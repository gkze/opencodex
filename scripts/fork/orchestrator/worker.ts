import { Effect, Schema } from "effect"
import { resolve, join } from "node:path"
import { mkdirSync } from "node:fs"
import { decode, CapturedPatch, Sha, Result as ResultSchema, type Result } from "./model.ts"
import { git, command } from "./process.ts"
import { replay, commitPatch } from "./replay.ts"
import { limits } from "./limits.ts"
import { repair } from "./agent.ts"
const Task = Schema.Struct({ attempt: Schema.String, control: Sha, upstream: Sha, patch: CapturedPatch, dependencies: Schema.Array(Sha) })
const task = decode(Task, JSON.parse(process.env.PATCH_TASK ?? "null"))
const trusted = process.cwd(), cwd = resolve("../candidate"), output = resolve(process.env.RUNNER_TEMP ?? "..", "result")
mkdirSync(output, {recursive: true})
const prepare = Effect.gen(function*() {
  if ((yield* git(trusted, "rev-parse", "HEAD")) !== task.control) return yield* Effect.fail("Control checkout mismatch")
  yield* command(["git", "clone", "--no-hardlinks", "--no-checkout", trusted, cwd], trusted)
  yield* git(cwd, "config", "user.name", "Fork patch maintenance")
  yield* git(cwd, "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")
  yield* git(cwd, "fetch", "https://github.com/lidge-jun/opencodex.git", task.upstream)
  for (const ref of [task.patch.source, ...task.dependencies]) yield* git(cwd, "fetch", "https://github.com/gkze/opencodex.git", ref)
  yield* git(cwd, "checkout", "--detach", task.upstream)
  const timestamp = yield* git(cwd, "show", "-s", "--format=%cI", task.upstream)
  process.env.GIT_AUTHOR_DATE = timestamp
  process.env.GIT_COMMITTER_DATE = timestamp
  for (const source of task.dependencies) {
    const applied = yield* replay(cwd, source, trusted)
    if (!applied.ok) return yield* Effect.fail(`Dependency ${applied.reason}`)
    yield* git(cwd, "commit", "--allow-empty", "-m", `Dependency ${source}`)
  }
  const base = yield* git(cwd, "rev-parse", "HEAD")
  const applied = yield* replay(cwd, task.patch.source, trusted)
  let adapted = false
  if (!applied.ok) {
    if (limits.policy.agentAttempts !== 1) return yield* Effect.fail("This protocol supports exactly one bounded repair attempt")
    const instructions = yield* Effect.promise(() => Bun.file(join(trusted, "scripts/fork/orchestrator/engineering-discipline.md")).text())
    yield* repair(cwd, task.patch, applied.reason, instructions, (yield* git(cwd, "ls-files")).split("\n"), (yield* git(cwd, "diff", "--name-only", `${task.patch.source}^`, task.patch.source)).split("\n"))
    adapted = true
  }
  yield* git(cwd, "add", "--all")
  if (yield* git(cwd, "diff", "--name-only", "--diff-filter=U")) return yield* Effect.fail("Unresolved conflicts")
  if (adapted) {
    const protectedPaths = [".github", "scripts/fork", "package.json", "bun.lock"]
    // Agent cannot change controls even when the original patch legitimately touches them.
    for (const path of protectedPaths) {
      const expected = yield* git(cwd, "diff", `${task.patch.source}^`, task.patch.source, "--", path)
      const actual = yield* git(cwd, "diff", "--cached", "--", path)
      if (actual !== expected) return yield* Effect.fail(`Agent changed protected path ${path}`)
    }
  }
  yield* git(cwd, "diff", "--cached", "--check")
  yield* commitPatch(cwd, task.patch.source, task.patch.id)
  const candidate = yield* git(cwd, "rev-parse", "HEAD")
  const result: Result = {id: task.patch.id, source: task.patch.source, upstream: task.upstream, base, candidate, adapted}
  yield* Effect.promise(() => Bun.write(join(output, "result.json"), JSON.stringify({attempt: task.attempt, control: task.control, ...result}, null, 2)))
})
const verify = Effect.gen(function*() {
  const result = decode(ResultSchema, yield* Effect.promise(() => Bun.file(join(output, "result.json")).json()))
  if ((yield* git(cwd, "rev-parse", "HEAD")) !== result.candidate) return yield* Effect.fail("Candidate changed before independent verification")
  delete process.env.COPILOT_GITHUB_TOKEN
  yield* command(["bun", "install", "--frozen-lockfile", "--linker=hoisted"], cwd)
  yield* command(["bun", "run", "typecheck"], cwd)
  for (const file of task.patch.tests) {
    if (file.startsWith("tests/") && file.endsWith(".test.ts")) yield* command(["bun", "test", file], cwd)
    else if (file.startsWith("gui/tests/") && /\.test\.tsx?$/.test(file)) {
      yield* command(["bun", "install", "--frozen-lockfile", "--linker=hoisted"], join(cwd, "gui"))
      yield* command(["bun", "test", file.slice(4)], join(cwd, "gui"))
    } else if (file === "app/Sources/WindowControlsTests/main.swift" && task.patch.runner === "macos-15") {
      yield* command(["swift", "run", "--package-path", "app", "WindowControlsTests"], cwd)
    } else return yield* Effect.fail(`Unsupported registered validation: ${file}`)
  }
  yield* command(["bun", "run", "structure:check"], cwd)
  if (yield* git(cwd, "status", "--porcelain")) return yield* Effect.fail("Validation changed tracked/untracked state")
  yield* git(cwd, "update-ref", "refs/heads/patch-result", result.candidate)
  yield* git(cwd, "bundle", "create", join(output, "candidate.bundle"), "refs/heads/patch-result", `^${task.upstream}`)
  if (Bun.file(join(output, "candidate.bundle")).size > limits.policy.artifactMaxBytes) return yield* Effect.fail("Bundle exceeds artifact budget")
})
const mode = process.argv[2]
if (mode !== "prepare" && mode !== "verify") throw new Error("Expected prepare or verify")
await Effect.runPromise(mode === "prepare" ? prepare : verify)
