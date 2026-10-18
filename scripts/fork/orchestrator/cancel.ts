import { Effect } from "effect"
import { request, Runs } from "./github.ts"
import { decode } from "./model.ts"
const prefix = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-`
if (!/^\d+-\d+-$/.test(prefix)) throw new Error("Missing parent identity")
await Effect.runPromise(Effect.gen(function*() {
  for (let page = 1; page <= 10; page++) {
    const runs = decode(Runs, yield* request(`actions/workflows/fork-patch-worker.yml/runs?event=workflow_dispatch&per_page=100&page=${page}`))
    for (const run of runs.workflow_runs) if (run.display_title.startsWith(prefix) && run.status !== "completed") {
      yield* request(`actions/runs/${run.id}/cancel`, {}).pipe(Effect.catch(error => Effect.logWarning(error)))
    }
    if (runs.workflow_runs.length < 100) return
  }
  return yield* Effect.fail("Cancellation history exceeded bounded scan")
}))
