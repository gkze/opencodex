import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { carryControlCommits, controlCommits } from "./controls.ts"
import { git } from "./process.ts"

const fixture = (body: (root: string, write: (path: string, text: string) => void) => Effect.Effect<unknown, string>) => async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-control-commits-"))
  const write = (path: string, text: string) => { mkdirSync(join(root, path, ".."), {recursive: true}); writeFileSync(join(root, path), text) }
  try {
    await Effect.runPromise(Effect.gen(function*() {
      yield* git(root, "init", "-q", "-b", "dev")
      yield* git(root, "config", "user.name", "Fixture")
      yield* git(root, "config", "user.email", "test@example.com")
      write("src/a.ts", "a"); write(".github/workflows/ci.yml", "ci")
      yield* git(root, "add", "."); yield* git(root, "commit", "-qm", "upstream base")
      yield* body(root, write)
    }))
  } finally { rmSync(root, {recursive: true, force: true}) }
}
const commit = (root: string, message: string) => Effect.gen(function*() {
  yield* git(root, "add", "-A"); yield* git(root, "commit", "-qm", message)
  return yield* git(root, "rev-parse", "HEAD")
})

test("control commits follow the patches with their own messages and boundaries", fixture((root, write) => Effect.gen(function*() {
  yield* git(root, "checkout", "-qb", "fork")
  write("src/a.ts", "patched"); yield* commit(root, "Maintain one\n\nPatch-Id: one")
  write("scripts/fork/orchestrator/worker.ts", "worker"); const first = yield* commit(root, "fork: orchestrator")
  write(".github/workflows/fork.yml", "fork"); const second = yield* commit(root, "fork: workflow")
  const tip = yield* git(root, "rev-parse", "HEAD")
  expect(yield* controlCommits(root, tip, "dev")).toEqual([first, second])
  yield* git(root, "checkout", "-q", "dev")
  write("src/b.ts", "b"); yield* commit(root, "upstream moves")
  const upstream = yield* git(root, "rev-parse", "HEAD")
  write("src/a.ts", "patched"); yield* commit(root, "Maintain one\n\nPatch-Id: one")
  const carried = yield* carryControlCommits(root, tip, upstream)
  expect(carried.map(c => c.source)).toEqual([first, second])
  expect(yield* git(root, "log", "--format=%s", `${upstream}..HEAD`)).toBe("fork: workflow\nfork: orchestrator\nMaintain one")
  expect(yield* git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", carried[0].commit)).toBe("scripts/fork/orchestrator/worker.ts")
  expect(readFileSync(join(root, ".github/workflows/fork.yml"), "utf8")).toBe("fork")
})))

test("controls folded into a patch commit, or a stray commit, fail instead of vanishing", fixture((root, write) => Effect.gen(function*() {
  const upstream = yield* git(root, "rev-parse", "HEAD")
  yield* git(root, "checkout", "-qb", "legacy")
  write("src/a.ts", "patched"); write("scripts/fork/nightly.mjs", "nightly")
  const legacy = yield* commit(root, "Maintain one\n\nPatch-Id: one")
  yield* git(root, "checkout", "-q", "--detach", upstream)
  const folded = yield* Effect.result(carryControlCommits(root, legacy, upstream))
  expect(folded._tag === "Failure" && folded.failure).toContain("that no control commit carries: scripts/fork/nightly.mjs")
  yield* git(root, "checkout", "-q", "-B", "stray", upstream)
  write("src/a.ts", "edited by hand"); const stray = yield* commit(root, "fix a thing")
  const refused = yield* Effect.result(controlCommits(root, stray, upstream))
  expect(refused._tag === "Failure" && refused.failure).toContain("changes paths outside .github, scripts/fork: src/a.ts")
})))
