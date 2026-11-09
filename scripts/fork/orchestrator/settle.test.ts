import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { settle, reviewBranch, annotation } from "./settle.ts"
import { applyControls, carriedControls } from "./controls.ts"
import { git } from "./process.ts"
import { coverageFailure } from "./model.ts"

test("a sensitive rework is proposed for review, never accepted", () => {
  expect(settle(true, "deepseek-browser-auth", {kind: "verified", adapted: true})).toEqual({action: "propose", reason: "sensitive patch needs review; the proposed rework is on review/deepseek-browser-auth"})
  expect(settle(true, "x", {kind: "verified", adapted: false})).toEqual({action: "accept"})
  expect(settle(false, "x", {kind: "verified", adapted: true})).toEqual({action: "accept"})
  expect(reviewBranch("x")).toBe("review/x")
})

test("an unfinished or rejected worker holds its patch instead of failing the refresh", () => {
  expect(settle(false, "x", {kind: "unfinished", failure: "lost runner"})).toEqual({action: "hold", reason: "worker did not finish: lost runner"})
  for (const sensitive of [true, false]) {
    expect(settle(sensitive, "x", {kind: "rejected", failure: "Bundle head mismatch"})).toEqual({action: "hold", reason: "worker result rejected: Bundle head mismatch"})
  }
})

test("annotations escape what the runner would otherwise parse", () => {
  expect(annotation("warning", "Held a: b, c", "50% done\nnext")).toBe("::warning title=Held a%3A b%2C c::50%25 done%0Anext")
})

test("patch workers and stack assembly take the same controls from the fork tip", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-controls-test-"))
  const write = (path: string, text: string) => { mkdirSync(join(root, path, ".."), {recursive: true}); writeFileSync(join(root, path), text) }
  try {
    await Effect.runPromise(Effect.gen(function*() {
      yield* git(root, "init", "-q", "-b", "dev")
      yield* git(root, "config", "user.name", "Fixture")
      yield* git(root, "config", "user.email", "test@example.com")
      write(".github/workflows/ci.yml", "upstream ci"); write(".github/workflows/dropped.yml", "upstream only"); write("src/a.ts", "a")
      yield* git(root, "add", "."); yield* git(root, "commit", "-qm", "upstream base")
      yield* git(root, "checkout", "-qb", "fork")
      write("scripts/fork/nightly.mjs", "fork control"); write(".github/workflows/fork.yml", "fork workflow")
      yield* git(root, "rm", "-q", ".github/workflows/dropped.yml")
      yield* git(root, "add", "."); yield* git(root, "commit", "-qm", "fork controls")
      const tip = yield* git(root, "rev-parse", "HEAD")
      yield* git(root, "checkout", "-q", "dev")
      write(".github/workflows/ci.yml", "newer upstream ci"); write("src/a.ts", "newer a")
      yield* git(root, "commit", "-qam", "upstream moves")
      const upstream = yield* git(root, "rev-parse", "HEAD")
      expect(yield* carriedControls(root, tip, upstream)).toEqual({present: [".github/workflows/fork.yml", "scripts/fork/nightly.mjs"], deleted: [".github/workflows/dropped.yml"]})
      expect(yield* applyControls(root, tip, upstream)).toBe(3)
      // The fork's controls arrive and its deletion holds; upstream's newer files stay upstream's.
      expect(readFileSync(join(root, "scripts/fork/nightly.mjs"), "utf8")).toBe("fork control")
      expect(existsSync(join(root, ".github/workflows/dropped.yml"))).toBe(false)
      expect(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")).toBe("newer upstream ci")
      expect(yield* git(root, "status", "--porcelain", "--", ".", ":(exclude).github", ":(exclude)scripts/fork")).toBe("")
    }))
  } finally { rmSync(root, {recursive: true, force: true}) }
})

const p = (id: string, requires: string[] = [], droppable?: boolean) => ({id, requires, droppable, branch: `codex/patch/${id}`, sensitive: false, runner: "ubuntu-24.04" as const, tests: []})

test("a stack accounts for every patch once, and drops only opted-in patches with their dependents", () => {
  const patches = [p("base", [], true), p("child", ["base"], true), p("release")]
  expect(coverageFailure(patches, ["base", "child", "release"], ["base", "child", "release"], [])).toBeNull()
  expect(coverageFailure(patches, ["release"], ["release"], ["base", "child"])).toBeNull()
  expect(coverageFailure(patches, ["base", "child"], ["base", "child"], ["release"])).toBe("Patch release is not droppable")
  expect(coverageFailure(patches, ["child", "release"], ["child", "release"], ["base"])).toBe("Patch child ships without its dropped dependency base")
  expect(coverageFailure(patches, ["release", "base"], ["release", "base"], ["base", "child"])).toBe("Duplicate or shipped-and-dropped patch")
  expect(coverageFailure(patches, ["release"], ["release"], ["child"])).toBe("Incomplete or duplicate patch mapping")
  expect(coverageFailure(patches, ["release", "base", "child"], ["release"], [])).toBe("Incomplete or duplicate patch mapping")
})
