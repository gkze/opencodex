import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { download } from "./artifact.ts"

const scratch = () => mkdtempSync(join(tmpdir(), "artifact-"))
const digestOf = (data: Uint8Array) => `sha256:${createHash("sha256").update(data).digest("hex")}`
const archive = () => {
  const dir = scratch()
  writeFileSync(join(dir, "candidate.bundle"), "bundle")
  writeFileSync(join(dir, "result.json"), "{}")
  const zip = Bun.spawnSync(["zip", "-q", "artifact.zip", "candidate.bundle", "result.json"], {cwd: dir})
  if (zip.exitCode !== 0) throw new Error("zip failed")
  const data = readFileSync(join(dir, "artifact.zip"))
  rmSync(dir, {recursive: true, force: true})
  return new Uint8Array(data) as Uint8Array<ArrayBuffer>
}
const responses = (...statuses: (number | Uint8Array)[]) => {
  const calls: number[] = []
  const fake = (async () => {
    const next = statuses[Math.min(calls.length, statuses.length - 1)]!
    calls.push(1)
    return typeof next === "number" ? new Response("nope", {status: next}) : new Response(new Blob([next as Uint8Array<ArrayBuffer>]))
  }) as unknown as typeof fetch
  return {fake, calls}
}
const run = (digest: string, fake: typeof fetch) => {
  const dir = scratch()
  return Effect.runPromise(download(1, digest, dir, {fetch: fake, delayMillis: () => 0}).pipe(Effect.result))
    .finally(() => rmSync(dir, {recursive: true, force: true}))
}

test("a GitHub 5xx is retried and the download then succeeds", async () => {
  const data = archive()
  const {fake, calls} = responses(503, 502, data)
  const result = await run(digestOf(data), fake)
  expect(result._tag).toBe("Success")
  expect(calls.length).toBe(3)
})

test("a 5xx that persists fails after the bounded attempts", async () => {
  const {fake, calls} = responses(503)
  const result = await run(digestOf(new Uint8Array([1])), fake)
  expect(result._tag).toBe("Failure")
  expect(String(result._tag === "Failure" && result.failure)).toContain("Artifact download HTTP 503")
  expect(calls.length).toBe(3)
})

test("a missing artifact and a digest mismatch are not retried", async () => {
  const missing = responses(404)
  expect((await run(digestOf(new Uint8Array([1])), missing.fake))._tag).toBe("Failure")
  expect(missing.calls.length).toBe(1)
  const wrong = responses(archive())
  const result = await run(digestOf(new Uint8Array([1])), wrong.fake)
  expect(String(result._tag === "Failure" && result.failure)).toContain("Artifact digest mismatch")
  expect(wrong.calls.length).toBe(1)
})
