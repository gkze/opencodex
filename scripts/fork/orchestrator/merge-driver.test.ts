import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { fetchPinnedArchive } from "./merge-driver.ts"

const data = new TextEncoder().encode("pinned mergiraf archive")
const target = { file: "mergiraf.tar.gz", bytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") }
const responses = (...replies: (number | Uint8Array)[]) => {
  const calls: number[] = []
  const fake = (async () => {
    const next = replies[Math.min(calls.length, replies.length - 1)]!
    calls.push(1)
    return typeof next === "number" ? new Response("nope", { status: next }) : new Response(new Blob([next as Uint8Array<ArrayBuffer>]))
  }) as unknown as typeof fetch
  return { fake, calls }
}
const fetchWith = (fake: typeof fetch) => fetchPinnedArchive(target, { fetch: fake, delayMillis: () => 0 })

// Fork patch worker 42474305615 lost a night's worker to "Mergiraf download failed: HTTP 504".
test("a release-host 5xx is retried and the pinned archive then verifies", async () => {
  const { fake, calls } = responses(504, 502, data)
  expect(await fetchWith(fake)).toEqual(data)
  expect(calls.length).toBe(3)
})

test("a 5xx that persists fails after the bounded attempts", async () => {
  const { fake, calls } = responses(504)
  await expect(fetchWith(fake)).rejects.toThrow("Mergiraf download failed: HTTP 504")
  expect(calls.length).toBe(3)
})

test("a missing release and an archive that does not match the pin are not retried", async () => {
  const missing = responses(404)
  await expect(fetchWith(missing.fake)).rejects.toThrow("HTTP 404")
  expect(missing.calls.length).toBe(1)
  const tampered = responses(new TextEncoder().encode("pinned mergiraf archivX"))
  await expect(fetchWith(tampered.fake)).rejects.toThrow("digest does not match the pin")
  expect(tampered.calls.length).toBe(1)
})
