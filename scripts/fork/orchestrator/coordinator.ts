import { Effect, Layer, Schema, Semaphore } from "effect"
import * as Workflow from "effect/workflow/Workflow"
import * as Activity from "effect/workflow/Activity"
import { mkdirSync } from "node:fs"
import { resolve, join } from "node:path"
import { decode, Registry, Input, Result, order, type Result as PatchResult } from "./model.ts"
import { workflowRuntime } from "./runtime.ts"
import { git, command } from "./process.ts"
import { dispatch, wait, Repository, request } from "./github.ts"
import { dispatchWithRetry } from "./retry.ts"
import { limits, capacity, canStart } from "./limits.ts"
import { freshWorktree, freshDirectory } from "./recovery.ts"
import { download } from "./artifact.ts"
import { replay, commitPatch } from "./replay.ts"
import { schedule } from "./scheduler.ts"
import { dependencyBase } from "./dependencies.ts"
import { preflight, measureOutputs } from "./resources.ts"
import registryJson from "./registry.json"
const root = process.cwd(), directory = resolve(process.env.RUN_STATE ?? "../fork-state")
mkdirSync(directory, {recursive: true})
const startedAt = Number(process.env.FORK_RUN_STARTED_AT) * 1000
if (!Number.isFinite(startedAt) || startedAt <= 0 || startedAt > Date.now()) throw new Error("Missing or invalid job start time")
const registry = decode(Registry, registryJson)

const Refresh = Workflow.make("ForkRefreshV1", { payload: { run: Schema.String }, success: Schema.String, error: Schema.String, idempotencyKey: p => p.run })
const step = (name: string, execute: Effect.Effect<string, string>) => Activity.make({name, success: Schema.String, error: Schema.String, execute})
const registered = Refresh.toLayer(({run}) => Effect.gen(function*() {
  yield* preflight()
  const input = decode(Input, JSON.parse(yield* step("capture", Effect.gen(function*() {
    const control = yield* git(root, "rev-parse", "HEAD")
    const old = (yield* git(root, "ls-remote", "origin", "refs/heads/gkze/patches")).split("\t")[0]
    if (old !== control) return yield* Effect.fail("Fork advanced before capture")
    yield* git(root, "fetch", "https://github.com/lidge-jun/opencodex.git", "dev")
    const upstream = yield* git(root, "rev-parse", "FETCH_HEAD")
    const patches = yield* Effect.forEach(order(registry.patches), patch => Effect.gen(function*() {
      yield* git(root, "fetch", "origin", patch.branch)
      const source = yield* git(root, "rev-parse", "FETCH_HEAD")
      const parents = (yield* git(root, "show", "-s", "--format=%P", source)).split(" ")
      const message = yield* git(root, "show", "-s", "--format=%B", source)
      if (parents.length !== 1 || !message.split("\n").includes(`Patch-Base: ${parents[0]}`) || !message.split("\n").includes(`Patch-Id: ${patch.id}`)) return yield* Effect.fail(`Patch ${patch.id} must be one squashed own commit with verified base trailers`)
      return {...patch, source}
    }))
    return JSON.stringify({run, old, control, upstream, patches, deadline: startedAt + limits.policy.coordinatorMinutes * 60_000})
  }))))
  const timestamp = yield* git(root, "show", "-s", "--format=%cI", input.upstream)
  process.env.GIT_AUTHOR_DATE = timestamp
  process.env.GIT_COMMITTER_DATE = timestamp
  const writer = yield* Semaphore.make(1)
  const results = yield* schedule(registry.patches, capacity(0, 0), limits.policy.macosJobs, (definition, parents: readonly PatchResult[]) => Effect.gen(function*() {
      const patch = input.patches.find(p => p.id === definition.id)!
      if (!limits.policy.runnerLabels.includes(patch.runner)) return yield* Effect.fail("Runner outside allowlist")
      const dependencies = parents.map(r => r.candidate)
      // Distinct step names keep a recorded activity failure from being replayed on retry.
      const worker = (n: number) => Effect.gen(function*() {
        const tag = n === 0 ? "" : `-retry${n}`
        const attempt = `${run}-${patch.id}${tag}`
        const id = Number(yield* step(`dispatch-${patch.id}${tag}`, Effect.gen(function*() {
          if (!canStart(input.deadline, Date.now())) return yield* Effect.fail("Insufficient run time for worker")
          return String(yield* dispatch(attempt, input.control, JSON.stringify({attempt, control: input.control, upstream: input.upstream, patch, dependencies}), patch.runner))
        })))
        yield* step(`wait-${patch.id}${tag}`, wait(id, attempt, input.control, input.deadline - limits.policy.cleanupMinutes * 60_000).pipe(Effect.map(String)))
        return {attempt, id}
      })
      const {attempt, id} = yield* dispatchWithRetry(worker, failure => console.error(`Retrying ${patch.id} after: ${failure}`))
      const encoded = yield* step(`accept-${patch.id}`, Effect.gen(function*() {
        const destination = join(directory, patch.id)
        freshDirectory(directory, destination)
        const artifacts = decode(Schema.Struct({artifacts: Schema.Array(Schema.Struct({id: Schema.Number, digest: Schema.String, name: Schema.String, size_in_bytes: Schema.Number, expired: Schema.Boolean}))}), yield* request(`actions/runs/${id}/artifacts`))
        const matches = artifacts.artifacts.filter(a => a.name === attempt && !a.expired)
        if (matches.length !== 1 || matches[0].size_in_bytes > limits.policy.artifactMaxBytes) return yield* Effect.fail("Missing, duplicate or oversized artifact")
        yield* download(matches[0].id, matches[0].digest, destination)
        const raw = yield* Effect.promise(() => Bun.file(join(destination, "result.json")).json())
        const result = decode(Result, raw)
        if (raw.attempt !== attempt || raw.control !== input.control || result.id !== patch.id || result.source !== patch.source || result.upstream !== input.upstream || (patch.sensitive && result.adapted)) return yield* Effect.fail("Worker result provenance mismatch")
        yield* git(root, "bundle", "verify", join(destination, "candidate.bundle"))
        yield* git(root, "fetch", join(destination, "candidate.bundle"), `refs/heads/patch-result:refs/maintenance/${run}/${patch.id}`)
        if ((yield* git(root, "rev-parse", `refs/maintenance/${run}/${patch.id}`)) !== result.candidate) return yield* Effect.fail("Bundle head mismatch")
        yield* git(root, "merge-base", "--is-ancestor", input.upstream, result.candidate)
        if ((yield* git(root, "rev-parse", `${result.candidate}^`)) !== result.base) return yield* Effect.fail("Patch must have exactly one own commit")
        const expected = join(directory, `${patch.id}-verify`)
        yield* freshWorktree(root, directory, expected, input.upstream)
        const expectedBase = yield* dependencyBase(expected, input.upstream, dependencies)
        if (expectedBase !== result.base) return yield* Effect.fail("Worker dependency ancestry differs")
        const merged = yield* replay(expected, patch.source, root)
        if (!result.adapted) {
          if (!merged.ok || (yield* git(expected, "write-tree")) !== (yield* git(root, "rev-parse", `${result.candidate}^{tree}`))) return yield* Effect.fail("Unadapted worker changed patch semantics")
        } else {
          const changed = (yield* git(root, "diff", "--name-only", result.base, result.candidate)).split("\n")
          const allowed = new Set((yield* git(root, "diff", "--name-only", `${patch.source}^`, patch.source)).split("\n"))
          if (changed.some(p => !allowed.has(p) || p.startsWith(".github/") || p.startsWith("scripts/fork/") || /(^|\/)(package.json|bun.lock)$/.test(p))) return yield* Effect.fail("Adaptation exceeds reviewed scope")
        }
        yield* git(root, "worktree", "remove", "--force", expected)
        return JSON.stringify(result)
      }))
      const result = decode(Result, JSON.parse(encoded))
      if (input.patches.some(p => p.requires.includes(result.id))) yield* step(`expose-${result.id}`, Effect.gen(function*() {
        const ref = `refs/heads/maintenance/${run}/${result.id}`
        const current = (yield* git(root, "ls-remote", "origin", ref)).split("\t")[0]
        if (current === result.candidate) return result.candidate
        if (current) return yield* Effect.fail("Dependency staging ref unexpectedly advanced")
        yield* git(root, "push", `--force-with-lease=${ref}:`, "origin", `${result.candidate}:${ref}`)
        return result.candidate
      }).pipe(writer.withPermits(1)))
      return result
  }))
  return yield* step("assemble", Effect.gen(function*() {
    const cwd = join(directory, "integration")
    yield* freshWorktree(root, directory, cwd, input.upstream)
    const mapped: Array<{id: string, commit: string}> = []
    for (const patch of order(input.patches)) {
      const result = results.find(r => r.id === patch.id)!
      const merged = yield* replay(cwd, result.candidate, root)
      if (!merged.ok) return yield* Effect.fail(`Integration ${patch.id}: ${merged.reason}`)
      yield* commitPatch(cwd, result.candidate, patch.id)
      mapped.push({id: patch.id, commit: yield* git(cwd, "rev-parse", "HEAD")})
    }
    const candidate = yield* git(cwd, "rev-parse", "HEAD")
    yield* git(cwd, "update-ref", "refs/heads/nightly-candidate", candidate)
    yield* git(cwd, "bundle", "create", join(directory, "candidate.bundle"), "refs/heads/nightly-candidate", ...results.map(r => r.candidate), `^${input.upstream}`)
    yield* Effect.promise(() => Bun.write(join(directory, "input.json"), JSON.stringify(input)))
    yield* Effect.promise(() => Bun.write(join(directory, "stack.json"), JSON.stringify({input, results, mapped, candidate}, null, 2)))
    yield* measureOutputs(directory)
    yield* git(root, "worktree", "remove", "--force", cwd)
    return candidate
  }))
}))
const runtime = workflowRuntime(join(directory, "workflow.sqlite"))
const run = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
if (!/^\d+-\d+$/.test(run)) throw new Error("Coordinator requires Actions run identity")
await Effect.runPromise(Refresh.execute({run}).pipe(Effect.provide(registered.pipe(Layer.provideMerge(runtime)))))
