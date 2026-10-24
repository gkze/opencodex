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

test("scheduler starts dependents and replenishes slots before slow siblings finish", async () => {
  const { Deferred } = await import("effect")
  const { schedule } = await import("./scheduler.ts")
  const events: string[] = []
  await Effect.runPromise(Effect.gen(function*() {
    const childStarted = yield* Deferred.make<void>()
    yield* schedule([patch("base"), patch("slow"), patch("child", ["base"])], 2, 1, p => Effect.gen(function*() {
      events.push(p.id)
      if (p.id === "slow") yield* Deferred.await(childStarted)
      if (p.id === "child") yield* Deferred.succeed(childStarted, undefined)
      return p.id
    }))
  }).pipe(Effect.timeout("2 seconds")))
  expect(events).toEqual(["base", "slow", "child"])
})

test("scheduler bounds total and macOS execution and interrupts siblings on failure", async () => {
  const { schedule } = await import("./scheduler.ts")
  let active = 0, mac = 0, peak = 0, peakMac = 0
  const patches = Array.from({length:8}, (_, i) => ({...patch(`p${i}`), runner: i % 2 ? "ubuntu-24.04" as const : "macos-15" as const}))
  await Effect.runPromise(schedule(patches, 3, 1, p => Effect.acquireUseRelease(
    Effect.sync(() => {active++; mac += Number(p.runner === "macos-15"); peak = Math.max(peak, active); peakMac = Math.max(peakMac, mac)}),
    () => Effect.sleep("5 millis"),
    () => Effect.sync(() => {active--; mac -= Number(p.runner === "macos-15")}),
  )))
  expect(peak).toBeLessThanOrEqual(3)
  expect(peakMac).toBe(1)
  const outcome = await Effect.runPromise(schedule([patch("fail"), patch("blocked", ["fail"])], 2, 1, () => Effect.fail("stop")).pipe(Effect.result, Effect.timeout("2 seconds")))
  expect(outcome._tag).toBe("Failure")
})

test("workflow projections and repository storage budgets agree", async () => {  const { checkWorkflows } = await import("./resources.ts")
  const { checkStorage, limits } = await import("./limits.ts")
  checkWorkflows(join(import.meta.dir, "../../.."))
  expect(() => checkStorage(limits.policy.retainedRepositoryBytes, 1)).toThrow("retained")
  expect(() => checkStorage(0, limits.policy.runArtifactBytes + 1)).toThrow("Run")
  expect(() => checkStorage(6 * 1024 ** 3, limits.policy.runArtifactBytes)).not.toThrow()
})

test("dependency bases retain exact accepted ancestors, including independent parents", async () => {
  const { dependencyBase } = await import("./dependencies.ts")
  const { git } = await import("./process.ts")
  const root = mkdtempSync(join(tmpdir(), "ocx-dependency-test-"))
  try {
    await Effect.runPromise(Effect.gen(function*() {
      yield* git(root, "init")
      yield* git(root, "config", "user.name", "Fixture")
      yield* git(root, "config", "user.email", "test@example.com")
      yield* git(root, "commit", "--allow-empty", "-m", "upstream")
      const upstream = yield* git(root, "rev-parse", "HEAD")
      writeFileSync(join(root, "a"), "a")
      yield* git(root, "add", "a"); yield* git(root, "commit", "-m", "a")
      const a = yield* git(root, "rev-parse", "HEAD")
      expect(yield* dependencyBase(root, upstream, [a])).toBe(a)
      yield* git(root, "checkout", "--detach", upstream)
      writeFileSync(join(root, "b"), "b")
      yield* git(root, "add", "b"); yield* git(root, "commit", "-m", "b")
      const b = yield* git(root, "rev-parse", "HEAD")
      const base = yield* dependencyBase(root, upstream, [a, b])
      yield* git(root, "merge-base", "--is-ancestor", a, base)
      yield* git(root, "merge-base", "--is-ancestor", b, base)
      expect(readFileSync(join(root,"a"),"utf8")).toBe("a")
      expect(readFileSync(join(root,"b"),"utf8")).toBe("b")
    }))
  } finally {rmSync(root, {recursive:true,force:true})}
})

test("zero scheduler capacity and oversized upload outputs fail before execution", async () => {
  const { schedule } = await import("./scheduler.ts")
  const { checkOutput } = await import("./output-budget.ts")
  const result = await Effect.runPromiseExit(schedule([patch("one")], 0, 1, () => Effect.succeed("unexpected")))
  expect(result._tag).toBe("Failure")
  const root = mkdtempSync(join(tmpdir(), "ocx-budget-test-"))
  try {
    writeFileSync(join(root, "payload"), "12345")
    expect(checkOutput(root, 5)).toBe(5)
    expect(() => checkOutput(root, 4)).toThrow("allocation")
  } finally {rmSync(root, {recursive:true,force:true})}
})

test("worker retry re-dispatches once and preserves the first successful attempt", async () => {
  const { dispatchWithRetry, workerAttempts } = await import("./retry.ts")
  expect(workerAttempts).toBe(2)
  const seen: number[] = []
  const first = await Effect.runPromise(dispatchWithRetry((attempt) => {
    seen.push(attempt)
    return Effect.succeed(attempt === 0 ? "primary" : "retried")
  }))
  expect(first).toBe("primary")
  expect(seen).toEqual([0])
  const retried = await Effect.runPromise(dispatchWithRetry((attempt) => {
    seen.push(attempt)
    return attempt === 0 ? Effect.fail("Worker 1 failure") : Effect.succeed("retried")
  }))
  expect(retried).toBe("retried")
  expect(seen).toEqual([0, 0, 1])
})
test("worker retry surfaces the second failure instead of retrying forever", async () => {
  const { dispatchWithRetry } = await import("./retry.ts")
  const seen: number[] = []
  const retried: Array<string> = []
  const result = await Effect.runPromiseExit(dispatchWithRetry((attempt) => {
    seen.push(attempt)
    return Effect.fail(`Worker ${attempt + 1} failure`)
  }, (failure) => retried.push(failure)))
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(String(result.cause)).toContain("Worker 2 failure")
  expect(seen).toEqual([0, 1])
  expect(retried).toEqual(["Worker 1 failure"])
})
