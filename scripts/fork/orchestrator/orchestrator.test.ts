import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { order, decode, Registry } from "./model.ts"
import { merge, renderMetadata } from "./merge.ts"
import { capacity, canStart } from "./limits.ts"
import { safeFile } from "./agent.ts"
import { command } from "./process.ts"
const patch = (id: string, requires: string[] = []) => ({id, requires, branch: `codex/patch/${id}`, sensitive: false, runner: "ubuntu-24.04" as const, tests: []})
test("dependency order rejects missing, duplicate and cyclic identities", () => {
  expect(order([patch("child", ["base"]), patch("base")]).map(p => p.id)).toEqual(["base", "child"])
  expect(() => order([patch("child", ["missing"])])).toThrow("Missing")
  expect(() => order([patch("one"), patch("one")])).toThrow("Duplicate")
  expect(() => order([patch("one", ["two"]), patch("two", ["one"])])).toThrow("cycle")
  expect(() => decode(Registry, {version:1, patches:[{...patch("one"), branch:"../../main"}]})).toThrow()
})
test("metadata retains both independent changes and rejects overlapping changes", () => {
  expect(merge({a:1,b:2},{a:3,b:2},{a:1,b:4})).toEqual({a:3,b:4})
  expect(merge([{path:"a",v:1}],[{path:"a",v:1},{path:"b",v:2}],[{path:"a",v:3}])).toEqual([{path:"a",v:3},{path:"b",v:2}])
  expect(() => merge({a:1},{a:2},{a:3})).toThrow("Conflicting")
})
test("admission preserves capacity and completion headroom", () => {
  expect(capacity(20, 0)).toBe(0)
  expect(capacity(0, 4)).toBe(0)
  expect(capacity(0, 0)).toBe(4)
  expect(canStart(70*60_000, 0)).toBe(false)
  expect(canStart(71*60_000, 0)).toBe(true)
})
test("agent file tools refuse escaped paths and symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-agent-test-"))
  try {
    writeFileSync(join(root, "safe"), "ok")
    symlinkSync("/etc/passwd", join(root, "link"))
    expect(safeFile(root, "safe", new Set(["safe"]))).toBe(join(root, "safe"))
    expect(() => safeFile(root, "../other", new Set())).toThrow()
    expect(() => safeFile(root, "link", new Set(["link"]))).toThrow()
  } finally {rmSync(root, {recursive:true,force:true})}
})
test("SQLite workflow completion survives a process restart without repeating activity", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-workflow-test-"))
  try {
    const args = [process.execPath, join(import.meta.dir, "recovery-probe.ts"), join(root,"state.sqlite"), join(root,"side-effect")]
    await Effect.runPromise(command(args, import.meta.dir))
    await Effect.runPromise(command(args, import.meta.dir))
    expect(readFileSync(join(root,"side-effect"),"utf8")).toBe("same-attempt\n")
  } finally {rmSync(root, {recursive:true,force:true})}
})

test("interrupted workflow resumes from its persisted activity", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-workflow-interrupt-"))
  const log = join(root,"side-effect")
  const args = [process.execPath, join(import.meta.dir, "recovery-probe.ts"), join(root,"state.sqlite"), log]
  const child = Bun.spawn(args, {cwd: import.meta.dir, env:{...process.env, PROBE_PAUSE:"1"}, stdout:"ignore", stderr:"pipe"})
  try {
    const deadline = Date.now() + 5000
    while (!existsSync(log+".ready") && Date.now() < deadline) await Bun.sleep(25)
    expect(existsSync(log+".ready")).toBe(true)
    child.kill("SIGKILL"); await child.exited
    await Effect.runPromise(command(args, import.meta.dir))
    expect(readFileSync(log,"utf8")).toBe("same-attempt\n")
  } finally { child.kill(); rmSync(root, {recursive:true,force:true}) }
}, 15000)

test("metadata updates preserve compact registry layout and semantics", () => {
  const text = '{"a":1, "b":2, "c":3}\n'
  const rendered = renderMetadata(text, {a:1,b:4,d:5})
  expect(JSON.parse(rendered)).toEqual({a:1,b:4,d:5})
  expect(rendered.split("\n").length).toBe(2)
  expect(renderMetadata(text, JSON.parse(text))).toBe(text)
})
