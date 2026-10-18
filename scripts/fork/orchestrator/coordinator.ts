import { Effect, Layer, Schema } from "effect"
import * as Workflow from "effect/workflow/Workflow"
import * as Activity from "effect/workflow/Activity"
import { mkdirSync } from "node:fs"
import { resolve, join } from "node:path"
import { decode, Registry, Input, Result, order, type Result as PatchResult } from "./model.ts"
import { workflowRuntime } from "./runtime.ts"
import { git, command } from "./process.ts"
import { dispatch, wait, Repository, request } from "./github.ts"
import { limits, capacity, canStart } from "./limits.ts"
import { freshWorktree, freshDirectory } from "./recovery.ts"
import { download } from "./artifact.ts"
import { replay, commitPatch } from "./replay.ts"
import registryJson from "./registry.json"
const root = process.cwd(), directory = resolve(process.env.RUN_STATE ?? "../fork-state")
mkdirSync(directory, {recursive: true})
const startedAt = Number(process.env.FORK_RUN_STARTED_AT) * 1000
if (!Number.isFinite(startedAt) || startedAt <= 0 || startedAt > Date.now()) throw new Error("Missing or invalid job start time")
const registry = decode(Registry, registryJson)
if ((registry.patches.length + 1) * limits.policy.artifactMaxBytes > limits.account.artifactBytes.value) throw new Error("Run artifact reservation exceeds account policy")
const Refresh = Workflow.make("ForkRefreshV1", { payload: { run: Schema.String }, success: Schema.String, error: Schema.String, idempotencyKey: p => p.run })
const step = (name: string, execute: Effect.Effect<string, string>) => Activity.make({name, success: Schema.String, error: Schema.String, execute})
const registered = Refresh.toLayer(({run}) => Effect.gen(function*() {
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
  const results: PatchResult[] = []
  const pending = new Map(input.patches.map(p => [p.id, p]))
  while (pending.size) {
    const ready = [...pending.values()].filter(p => p.requires.every(id => results.some(r => r.id === id)))
    if (!ready.length) return yield* Effect.fail("Unsatisfied dependencies")
    // Unknown activity in other repositories is covered by a reserved-capacity policy;
    // this is an admission bound, not a claim of an account-wide atomic reservation.
    const slots = capacity(0, 0)
    if (slots === 0) return yield* Effect.fail("Account policy has no worker capacity")
    let macos = 0
    const batch = ready.filter(p => {
      if (!limits.policy.runnerLabels.includes(p.runner)) throw new Error("Runner outside allowlist")
      if (p.runner === "macos-15") return ++macos <= Math.min(limits.policy.macosJobs, limits.account.macosJobs.value)
      return true
    }).slice(0, slots)
    const completed = yield* Effect.forEach(batch, patch => Effect.gen(function*() {
      const dependencies = results.filter(r => {
        const closure = new Set<string>()
        const visit = (id: string) => { if (closure.has(id)) return; closure.add(id); input.patches.find(p => p.id === id)?.requires.forEach(visit) }
        patch.requires.forEach(visit)
        return closure.has(r.id)
      }).map(r => r.candidate)
      const attempt = `${run}-${patch.id}`
      const id = Number(yield* step(`dispatch-${patch.id}`, Effect.gen(function*() {
        if (!canStart(input.deadline, Date.now())) return yield* Effect.fail("Insufficient run time for worker")
        return String(yield* dispatch(attempt, input.control, JSON.stringify({attempt, control: input.control, upstream: input.upstream, patch, dependencies}), patch.runner))
      })))
      yield* step(`wait-${patch.id}`, wait(id, attempt, input.control, input.deadline - limits.policy.cleanupMinutes * 60_000).pipe(Effect.map(String)))
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
        for (const dep of dependencies) {
          const merged = yield* replay(expected, dep, root)
          if (!merged.ok) return yield* Effect.fail(merged.reason)
          yield* git(expected, "commit", "--allow-empty", "-m", `Dependency ${dep}`)
        }
        if ((yield* git(expected, "rev-parse", "HEAD^{tree}")) !== (yield* git(root, "rev-parse", `${result.base}^{tree}`))) return yield* Effect.fail("Worker dependency tree differs")
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
      return decode(Result, JSON.parse(encoded))
    }), {concurrency: limits.policy.workerJobs})
    for (const result of completed) {
      // One writer publishes only the objects later workers must fetch.
      if (input.patches.some(p => p.requires.includes(result.id))) yield* step(`expose-${result.id}`, Effect.gen(function*() {
        const ref = `refs/heads/maintenance/${run}/${result.id}`
        const current = (yield* git(root, "ls-remote", "origin", ref)).split("\t")[0]
        if (current === result.candidate) return result.candidate
        if (current) return yield* Effect.fail("Dependency staging ref unexpectedly advanced")
        yield* git(root, "push", `--force-with-lease=${ref}:`, "origin", `${result.candidate}:${ref}`)
        return result.candidate
      }))
      results.push(result); pending.delete(result.id)
    }
  }
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
    yield* git(root, "worktree", "remove", "--force", cwd)
    return candidate
  }))
}))
const runtime = workflowRuntime(join(directory, "workflow.sqlite"))
const run = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
if (!/^\d+-\d+$/.test(run)) throw new Error("Coordinator requires Actions run identity")
await Effect.runPromise(Refresh.execute({run}).pipe(Effect.provide(registered.pipe(Layer.provideMerge(runtime)))))
