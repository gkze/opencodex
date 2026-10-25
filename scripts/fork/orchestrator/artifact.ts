import { Effect } from "effect"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { command } from "./process.ts"
import { Repository } from "./github.ts"
import { limits } from "./limits.ts"
const bounded = async (stream: ReadableStream<Uint8Array>, limit: number) => {
  const reader = stream.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > limit) throw new Error("Artifact exceeds byte budget")
      chunks.push(next.value)
    }
    return Buffer.concat(chunks)
  } finally { await reader.cancel() }
}
export const download = (id: number, digest: string, directory: string) => Effect.gen(function*() {
  const archive = join(directory, "artifact.zip")
  yield* Effect.tryPromise({try: async signal => {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("Missing artifact digest")
    const response = await fetch(`https://api.github.com/repos/${Repository}/actions/artifacts/${id}/zip`, {signal, headers:{Authorization:`Bearer ${process.env.GH_TOKEN}`, "X-GitHub-Api-Version":"2026-03-10"}})
    if (!response.ok || !response.body) throw new Error(`Artifact download HTTP ${response.status}`)
    const data = await bounded(response.body, limits.policy.artifactMaxBytes)
    if (`sha256:${createHash("sha256").update(data).digest("hex")}` !== digest) throw new Error("Artifact digest mismatch")
    await Bun.write(archive, data)
  }, catch:String})
  const entries = (yield* command(["unzip", "-Z1", archive], directory)).split("\n").sort()
  if (entries.join("\n") !== "candidate.bundle\nresult.json") return yield* Effect.fail("Unexpected archive entries")
  for (const name of entries) yield* Effect.tryPromise({try: async signal => {
    const child = Bun.spawn(["unzip", "-p", archive, name], {stdout:"pipe",stderr:"ignore"})
    const abort = () => child.kill()
    signal.addEventListener("abort", abort, {once:true})
    try {
      const data = await bounded(child.stdout, name === "result.json" ? 100_000 : limits.policy.artifactMaxBytes)
      if (await child.exited !== 0) throw new Error("Archive extraction failed")
      await Bun.write(join(directory, name), data)
    } finally {signal.removeEventListener("abort", abort); child.kill()}
  }, catch:String})
})
