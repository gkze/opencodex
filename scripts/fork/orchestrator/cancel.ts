import { Effect, Schema } from "effect"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { request, Runs, Run, dispatchWindow, Repository } from "./github.ts"
import { decode } from "./model.ts"
const prefix = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-`
if (!/^\d+-\d+-$/.test(prefix)) throw new Error("Missing parent identity")
await Effect.runPromise(Effect.gen(function*() {
  const failures: string[] = [], children = new Map<number, string>()
  const attempt = <A>(work: Effect.Effect<A, string>) => work.pipe(Effect.catch(error => Effect.sync(() => { failures.push(error) })))
  const receipts = join(process.env.RUN_STATE!, "children.jsonl")
  if (existsSync(receipts)) for (const line of readFileSync(receipts, "utf8").trim().split("\n").filter(Boolean)) {
    yield* attempt(Effect.try({try: () => {
      const receipt = decode(Schema.Struct({id:Schema.Number, attempt:Schema.String, control:Schema.String}), JSON.parse(line))
      if (!receipt.attempt.startsWith(prefix)) throw new Error("Foreign dispatch receipt")
      children.set(receipt.id, receipt.control)
    }, catch:String}))
  }
  yield* attempt(Effect.gen(function*() {
    for (let page = 1; page <= 10; page++) {
      const raw = yield* request(`actions/workflows/fork-patch-worker.yml/runs?event=workflow_dispatch&created=${dispatchWindow()}&per_page=100&page=${page}`)
      const runs = yield* Effect.try({try: () => decode(Runs, raw), catch:String})
      for (const run of runs.workflow_runs) if (run.display_title.startsWith(prefix)) children.set(run.id, run.head_sha)
      if (runs.workflow_runs.length < 100) return
    }
    return yield* Effect.fail("Cancellation history exceeded bounded scan")
  }))
  const pending = new Set<number>()
  for (const [id, control] of children) yield* attempt(Effect.gen(function*() {
    const raw = yield* request(`actions/runs/${id}`)
    const run = yield* Effect.try({try: () => decode(Run, raw), catch:String})
    if (run.head_sha !== control || run.head_repository.full_name !== Repository || run.path !== ".github/workflows/fork-patch-worker.yml" || run.event !== "workflow_dispatch") return yield* Effect.fail(`Cleanup identity mismatch for ${id}`)
    if (run.status !== "completed") {
      yield* request(`actions/runs/${id}/cancel`, {})
      pending.add(id)
    }
  }))
  const deadline = Date.now() + 90_000
  while (pending.size && Date.now() < deadline) {
    yield* Effect.sleep("5 seconds")
    for (const id of [...pending]) yield* attempt(Effect.gen(function*() {
      const raw = yield* request(`actions/runs/${id}`)
    const run = yield* Effect.try({try: () => decode(Run, raw), catch:String})
      if (run.status === "completed") pending.delete(id)
    }))
  }
  if (pending.size || failures.length) return yield* Effect.fail(`Cleanup incomplete: ${pending.size} children not confirmed stopped; ${failures.join("; ")}`)
}))
