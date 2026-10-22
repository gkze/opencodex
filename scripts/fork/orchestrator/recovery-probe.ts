import { Effect, Layer, Schema } from "effect"
import * as Workflow from "effect/workflow/Workflow"
import * as Activity from "effect/workflow/Activity"
import { appendFileSync } from "node:fs"
import { workflowRuntime } from "./runtime.ts"

const Probe = Workflow.make("RecoveryProbe", { payload: { id: Schema.String }, success: Schema.String, error: Schema.String, idempotencyKey: p => p.id })
const registered = Probe.toLayer(p => Effect.gen(function*() {
  yield* Activity.make({ name: "record", success: Schema.String, execute: Effect.sync(() => {
    appendFileSync(process.argv[3], `${p.id}\n`)
    return "recorded"
  }) })
  if (process.env.PROBE_PAUSE === "1") {
    yield* Effect.sync(() => appendFileSync(process.argv[3] + ".ready", "ready"))
    yield* Effect.sleep("1 minute")
  }
  return "complete"
}))
const runtime = workflowRuntime(process.argv[2])
await Effect.runPromise(Probe.execute({ id: "same-attempt" }).pipe(Effect.provide(registered.pipe(Layer.provideMerge(runtime)))))
