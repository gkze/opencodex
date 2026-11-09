import { Effect, Layer, Schema, Semaphore } from "effect"
import * as Workflow from "effect/workflow/Workflow"
import * as Activity from "effect/workflow/Activity"
import { mkdirSync } from "node:fs"
import { resolve, join } from "node:path"
import { decode, Registry, Input, Result, Settled, isDropped, order, type Dropped } from "./model.ts"
import { workflowRuntime } from "./runtime.ts"
import { git, command } from "./process.ts"
import { dispatch, wait, Repository, request } from "./github.ts"
import { dispatchWithRetry, retryTransient } from "./retry.ts"
import { lastAccepted } from "./held.ts"
import { limits, capacity, canStart } from "./limits.ts"
import { freshWorktree, freshDirectory } from "./recovery.ts"
import { download } from "./artifact.ts"
import { replay, commitPatch } from "./replay.ts"
import { schedule } from "./scheduler.ts"
import { dependencyBase } from "./dependencies.ts"
import { preflight, measureOutputs } from "./resources.ts"
import { isForkControl, carryControlCommits } from "./controls.ts"
import { settle, reviewBranch, annotation } from "./settle.ts"
import { assertMergeDriver, configureMergeDriver } from "./merge-driver.ts"
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
  // The worker verifies candidates by replaying them here, so both ends must merge identically.
  yield* Effect.sync(() => configureMergeDriver(root, process.env.MERGIRAF_BIN ?? ""))
  yield* Effect.sync(() => assertMergeDriver(root))
  yield* Effect.sync(() => console.error(`Structural merge driver: ${process.env.MERGIRAF_BIN}`))
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
  const settled = yield* schedule(registry.patches, capacity(0, 0), limits.policy.macosJobs, (definition, parents: readonly Settled[]) => Effect.gen(function*() {
      const patch = input.patches.find(p => p.id === definition.id)!
      if (!limits.policy.runnerLabels.includes(patch.runner)) return yield* Effect.fail("Runner outside allowlist")
      // Leave an opted-in patch out of tonight's stack; any other patch that cannot ship fails the
      // refresh, because the stack would be missing something the nightly depends on.
      const leaveOut = (reason: string): Effect.Effect<Dropped, string> => patch.droppable
        ? Effect.sync((): Dropped => {
          console.log(annotation("warning", `Dropped ${patch.id}`, reason))
          return {id: patch.id, dropped: true, reason}
        })
        : Effect.fail(reason)
      const missing = parents.find(isDropped)
      if (missing) return yield* leaveOut(`requires ${missing.id}, which is left out tonight: ${missing.reason}`)
      const dependencies = parents.filter((r): r is Result => !isDropped(r)).map(r => r.candidate)
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
      const dispatched = yield* dispatchWithRetry(worker, failure => console.error(`Retrying ${patch.id} after: ${failure}`)).pipe(Effect.result)
      // A patch that cannot be replayed tonight ships the revision the last accepted stack
      // published, so one blocked patch costs that patch a night instead of the whole refresh.
      // A patch neither revision of which replays is returned as `unreplayable` rather than failed,
      // so the caller can apply the drop policy to it. Any other failure is the machinery's own.
      const hold = (reason: string) => Effect.gen(function*() {
        const source = yield* lastAccepted(root, input.old, patch.id)
        if (!source) return {unreplayable: `${reason}; no accepted revision of ${patch.id} to hold`}
        const cwd = join(directory, `${patch.id}-hold`)
        yield* freshWorktree(root, directory, cwd, input.upstream)
        const base = yield* dependencyBase(cwd, input.upstream, dependencies)
        const replayed = yield* replay(cwd, source, root)
        if (!replayed.ok) {
          yield* git(root, "worktree", "remove", "--force", cwd)
          return {unreplayable: `${reason}; held revision does not replay: ${replayed.reason}`}
        }
        yield* git(cwd, "add", "--all")
        if (yield* git(cwd, "diff", "--name-only", "--diff-filter=U")) {
          yield* git(root, "worktree", "remove", "--force", cwd)
          return {unreplayable: `${reason}; held revision leaves unresolved conflicts`}
        }
        yield* commitPatch(cwd, source, patch.id)
        const candidate = yield* git(cwd, "rev-parse", "HEAD")
        yield* git(root, "worktree", "remove", "--force", cwd)
        yield* Effect.sync(() => console.log(annotation("warning", `Held ${patch.id}`, `Shipping its last accepted revision ${source.slice(0, 12)}: ${reason}`)))
        return {id: patch.id, source, upstream: input.upstream, base, candidate, adapted: false, hold: true} satisfies Result
      })
      const accept = ({attempt, id}: {attempt: string, id: number}) => Effect.gen(function*() {
        const destination = join(directory, patch.id)
        freshDirectory(directory, destination)
        const artifacts = decode(Schema.Struct({artifacts: Schema.Array(Schema.Struct({id: Schema.Number, digest: Schema.String, name: Schema.String, size_in_bytes: Schema.Number, expired: Schema.Boolean}))}), yield* request(`actions/runs/${id}/artifacts`))
        const matches = artifacts.artifacts.filter(a => a.name === attempt && !a.expired)
        if (matches.length !== 1 || matches[0].size_in_bytes > limits.policy.artifactMaxBytes) return yield* Effect.fail("Missing, duplicate or oversized artifact")
        yield* download(matches[0].id, matches[0].digest, destination)
        const raw = yield* Effect.promise(() => Bun.file(join(destination, "result.json")).json())
        const result = decode(Result, raw)
        if (raw.attempt !== attempt || raw.control !== input.control || result.id !== patch.id || result.source !== patch.source || result.upstream !== input.upstream) return yield* Effect.fail("Worker result provenance mismatch")
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
          // A rework may follow upstream into files the patch never touched, so scope is the
          // tree minus the fork's controls, capped so a repair cannot become a rewrite.
          const changed = (yield* git(root, "diff", "--name-only", result.base, result.candidate)).split("\n").filter(Boolean)
          if (changed.some(path => isForkControl(path))) return yield* Effect.fail("Adaptation touched a fork control")
          const shortstat = yield* git(root, "diff", "--shortstat", result.base, result.candidate)
          const lines = Number(shortstat.match(/(\d+) insertion/)?.[1] ?? 0) + Number(shortstat.match(/(\d+) deletion/)?.[1] ?? 0)
          if (lines > limits.policy.adaptationMaxLines) return yield* Effect.fail(`Adaptation rewrote ${lines} lines; budget is ${limits.policy.adaptationMaxLines}`)
        }
        yield* git(root, "worktree", "remove", "--force", expected)
        return JSON.stringify(result)
      })
      const accepted = dispatched._tag === "Success" ? yield* step(`accept-${patch.id}`, accept(dispatched.success)).pipe(Effect.result) : null
      const settlement = settle(patch.sensitive, patch.id, accepted === null ? {kind: "unfinished", failure: String(dispatched._tag === "Failure" ? dispatched.failure : "")}
        : accepted._tag === "Failure" ? {kind: "rejected", failure: String(accepted.failure)}
        : {kind: "verified", adapted: decode(Result, JSON.parse(accepted.success)).adapted})
      const review = `refs/heads/${reviewBranch(patch.id)}`
      if (settlement.action === "propose" && accepted?._tag === "Success") {
        // The rework passed the same verification as any adaptation. Only its acceptance waits for a person.
        const proposed = decode(Result, JSON.parse(accepted.success)).candidate
        yield* step(`propose-${patch.id}`, retryTransient(git(root, "push", "--force", "origin", `${proposed}:${review}`).pipe(Effect.as(proposed)),
          failure => console.error(`Retrying review push for ${patch.id} after: ${failure}`)).pipe(writer.withPermits(1)))
      } else if (settlement.action === "accept" && patch.sensitive) {
        // The patch applies again, so any rework proposed on an earlier night is stale.
        yield* step(`retire-review-${patch.id}`, retryTransient(Effect.gen(function*() {
          if (yield* git(root, "ls-remote", "origin", review)) yield* git(root, "push", "origin", "--delete", review)
          return review
        }), failure => console.error(`Retrying review cleanup for ${patch.id} after: ${failure}`)).pipe(writer.withPermits(1)))
      }
      const encoded = settlement.action === "accept" && accepted?._tag === "Success" ? accepted.success
        : yield* step(`hold-${patch.id}`, hold(settlement.action === "accept" ? "unreachable" : settlement.reason).pipe(
          Effect.flatMap((held): Effect.Effect<Settled, string> => held.unreplayable === undefined ? Effect.succeed(held) : leaveOut(held.unreplayable)),
          Effect.map(result => JSON.stringify(result))))
      const outcome = decode(Settled, JSON.parse(encoded))
      if (isDropped(outcome)) return outcome
      const result = outcome
      // The body re-reads the ref before pushing, so a retry after a 5xx that GitHub applied anyway
      // finds the candidate already there instead of failing the lease.
      if (input.patches.some(p => p.requires.includes(result.id))) yield* step(`expose-${result.id}`, retryTransient(Effect.gen(function*() {
        const ref = `refs/heads/maintenance/${run}/${result.id}`
        const current = (yield* git(root, "ls-remote", "origin", ref)).split("\t")[0]
        if (current === result.candidate) return result.candidate
        if (current) return yield* Effect.fail("Dependency staging ref unexpectedly advanced")
        yield* git(root, "push", `--force-with-lease=${ref}:`, "origin", `${result.candidate}:${ref}`)
        return result.candidate
      }), failure => console.error(`Retrying staging push for ${result.id} after: ${failure}`)).pipe(writer.withPermits(1)))
      return result
  }))
  const results = settled.filter((s): s is Result => !isDropped(s)), dropped = settled.filter(isDropped)
  return yield* step("assemble", Effect.gen(function*() {
    const cwd = join(directory, "integration")
    yield* freshWorktree(root, directory, cwd, input.upstream)
    const mapped: Array<{id: string, commit: string}> = []
    for (const patch of order(input.patches)) {
      const result = results.find(r => r.id === patch.id)
      if (!result) continue
      const merged = yield* replay(cwd, result.candidate, root)
      if (!merged.ok) return yield* Effect.fail(`Integration ${patch.id}: ${merged.reason}`)
      yield* commitPatch(cwd, result.candidate, patch.id)
      mapped.push({id: patch.id, commit: yield* git(cwd, "rev-parse", "HEAD")})
    }
    // Fork-owned controls live on the branch, not in the patch branches. They follow the patches as
    // their own commits; folding them into the last patch would make that patch's commit carry the
    // whole control tree.
    const controls = yield* carryControlCommits(cwd, input.old, input.upstream)
    const candidate = yield* git(cwd, "rev-parse", "HEAD")
    yield* git(cwd, "update-ref", "refs/heads/nightly-candidate", candidate)
    yield* git(cwd, "bundle", "create", join(directory, "candidate.bundle"), "refs/heads/nightly-candidate", ...results.map(r => r.candidate), `^${input.upstream}`)
    yield* Effect.promise(() => Bun.write(join(directory, "input.json"), JSON.stringify(input)))
    yield* Effect.promise(() => Bun.write(join(directory, "stack.json"), JSON.stringify({input, results, dropped, mapped, controls, candidate}, null, 2)))
    yield* measureOutputs(directory)
    yield* git(root, "worktree", "remove", "--force", cwd)
    return candidate
  }))
}))
const runtime = workflowRuntime(join(directory, "workflow.sqlite"))
const run = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
if (!/^\d+-\d+$/.test(run)) throw new Error("Coordinator requires Actions run identity")
try {
  await Effect.runPromise(Refresh.execute({run}).pipe(Effect.provide(registered.pipe(Layer.provideMerge(runtime)))))
} catch (error) {
  // The annotation is what the nightly attention issue quotes, so it says why without the log.
  console.log(annotation("error", "Fork stack refresh failed", String(error).slice(0, 4000)))
  throw error
}
