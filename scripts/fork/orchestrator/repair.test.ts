import { expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { conflictHunks, resolveHunk, describeHunks } from "./conflicts.ts"
import { converse, fileTools, followUps, outstanding, type TranscriptEntry } from "./agent.ts"
import { replay } from "./replay.ts"
import { git } from "./process.ts"

// The 2026-11-09 failure: one long line, where upstream's and the base's sections share almost all
// their text, so no short quote of either is unique.
const head = "against `x`, which follows a recorded path. Waits 125 probes. Bootout is waited out (#8362)."
const base = "against `x`, which follows a recorded path. Waits 125 probes."
const theirs = "against `x`, which uses the trusted pair. Waits 125 probes."
const conflicted = `intro\n<<<<<<< HEAD\n${head}\n||||||| parent of abc (patch)\n${base}\n=======\n${theirs}\n>>>>>>> abc (patch)\n\noutro\n`
const resolved = "against `x`, which uses the trusted pair. Waits 125 probes. Bootout is waited out (#8362)."

test("diff3 hunks parse into upstream, base and patch sections", () => {
  const {hunks, malformed} = conflictHunks(conflicted)
  expect(malformed).toEqual([])
  expect(hunks.map(h => [h.line, h.ours, h.base, h.theirs])).toEqual([[2, head, base, theirs]])
  const merge = conflictHunks("<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n")
  expect(merge.hunks.map(h => [h.ours, h.base, h.theirs])).toEqual([["a", null, "b"]])
  // A half-deleted hunk is what a failed repair leaves, and must not read as clean.
  expect(conflictHunks("a\n=======\nb\n>>>>>>> x\n").malformed).toEqual([2, 4])
  expect(conflictHunks("<<<<<<< HEAD\na\n").malformed).toEqual([1])
})

test("a hunk is resolved by number where a text match is ambiguous", () => {
  expect(conflicted.split("against `x`, which follows a recorded path. Waits 125 probes.").length - 1).toBe(2)
  expect(resolveHunk(conflicted, 1, resolved)).toBe(`intro\n${resolved}\n\noutro\n`)
  expect(resolveHunk(conflicted, 1, "")).toBe("intro\n\noutro\n")
  const two = `${conflicted}${conflicted}`
  expect(conflictHunks(resolveHunk(two, 2, resolved)).hunks.map(h => h.line)).toEqual([2])
  expect(() => resolveHunk(conflicted, 2, resolved)).toThrow("No conflict hunk 2; the file has 1")
  expect(() => resolveHunk(conflicted, 1, "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> z")).toThrow("conflict markers")
  expect(resolveHunk("<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x", 1, "b")).toBe("b")
})

test("the prompt shows each side of a hunk and stays within its budget", () => {
  const text = describeHunks("doc.md", conflicted, 10_000)
  expect(text).toContain("doc.md hunk 1 (line 2)")
  for (const section of [head, base, theirs]) expect(text).toContain(section)
  expect(describeHunks("doc.md", conflicted, 40)).toContain("[truncated; read doc.md for the rest]")
  // A section that itself holds a code fence gets a longer one, so it cannot close the quote early.
  expect(describeHunks("doc.md", conflicted.replace(theirs, "```ts\ncode\n```"), 10_000)).toContain("````\n```ts\ncode\n```\n````")
})

test("the conflict tools resolve by number and record every call, refusals included", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ocx-repair-tools-"))
  try {
    writeFileSync(join(cwd, "doc.md"), conflicted)
    const writes: string[] = [], transcript: TranscriptEntry[] = []
    const tools = new Map(fileTools(cwd, ["doc.md"], ["doc.md"], ["doc.md"], writes, entry => transcript.push(entry)).map(t => [t.name, t]))
    const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.handler!(args as never, {} as never)
    expect(() => call("replace_in_source", {path: "doc.md", old: "which follows a recorded path", next: "x"})).toThrow("more than once")
    expect(String(call("list_conflicts", {}))).toContain("doc.md hunk 1")
    expect(call("resolve_conflict", {path: "doc.md", hunk: 1, resolution: resolved})).toBe("Resolved; 0 hunk(s) remain in doc.md")
    expect(call("list_conflicts", {})).toBe("No conflict hunks remain")
    expect(() => call("resolve_conflict", {path: "../escape", hunk: 1, resolution: ""})).toThrow("allowlist")
    expect(readFileSync(join(cwd, "doc.md"), "utf8")).toBe(`intro\n${resolved}\n\noutro\n`)
    expect(writes).toEqual(["doc.md"])
    expect(transcript.map(e => e.kind === "tool" ? [e.tool, e.error ? "refused" : "ok"] : [e.kind])).toEqual([
      ["replace_in_source", "refused"], ["list_conflicts", "ok"], ["resolve_conflict", "ok"], ["list_conflicts", "ok"], ["resolve_conflict", "refused"],
    ])
    expect(JSON.stringify(transcript)).not.toContain(head)
    expect(outstanding(cwd, ["doc.md", "gone.md"]).count).toBe(0)
  } finally { rmSync(cwd, {recursive: true, force: true}) }
})

test("an agent that stops early is told what remains, a bounded number of times", async () => {
  const sent: string[] = []
  let left = 3
  const turns = await converse("start", async message => { sent.push(message); left = Math.max(0, left - 1) }, () => ({count: left, rendered: `hunks:${left}`}))
  expect(turns).toBe(3)
  expect(sent).toEqual(["start", "2 conflict hunk(s) are still unresolved. Resolve every one with resolve_conflict before finishing.\n\nhunks:2", "1 conflict hunk(s) are still unresolved. Resolve every one with resolve_conflict before finishing.\n\nhunks:1"])
  const stuck: string[] = []
  expect(await converse("start", async message => { stuck.push(message) }, () => ({count: 1, rendered: ""}))).toBe(followUps + 1)
  expect(await converse("start", async () => {}, () => ({count: 0, rendered: ""}))).toBe(1)
})

test("replay leaves diff3 hunks and names the conflicted paths whatever the local conflict style", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ocx-replay-diff3-"))
  const trusted = resolve(import.meta.dir, "../../..")
  const write = (text: string) => writeFileSync(join(cwd, "doc.md"), `intro\n${text}\n\noutro\n`)
  // A runner has no global Git configuration; a maintainer's (a merge driver, diff3) would hide
  // whether replay itself chooses the conflict style.
  const saved = {global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM}
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_NOSYSTEM = "1"
  try {
    await Effect.runPromise(Effect.gen(function*() {
      yield* git(cwd, "init", "-q")
      yield* git(cwd, "config", "user.name", "Fixture")
      yield* git(cwd, "config", "user.email", "test@example.com")
      yield* git(cwd, "config", "merge.conflictStyle", "merge")
      mkdirSync(join(cwd, "structure"))
      copyFileSync(join(trusted, "structure/manifest.json"), join(cwd, "structure/manifest.json"))
      write(base)
      yield* git(cwd, "add", "."); yield* git(cwd, "commit", "-qm", "base")
      const parent = yield* git(cwd, "rev-parse", "HEAD")
      write(theirs); yield* git(cwd, "commit", "-qam", "patch")
      const source = yield* git(cwd, "rev-parse", "HEAD")
      yield* git(cwd, "checkout", "-q", "--detach", parent)
      write(head); yield* git(cwd, "commit", "-qam", "upstream")
      const applied = yield* replay(cwd, source, trusted)
      expect(applied).toEqual({ok: false, reason: "Conflicts: doc.md", conflicts: ["doc.md"]})
      expect(conflictHunks(readFileSync(join(cwd, "doc.md"), "utf8")).hunks.map(h => [h.ours, h.base, h.theirs])).toEqual([[head, base, theirs]])
    }))
  } finally {
    for (const [key, value] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.system]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    rmSync(cwd, {recursive: true, force: true})
  }
})
