import { Effect, Schema } from "effect"
import { statSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { decode } from "./model.ts"
import { limits, checkStorage } from "./limits.ts"
import { request } from "./github.ts"

const Strategy = Schema.Struct({ matrix: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)) })
const Workflow = Schema.Struct({ concurrency: Schema.optional(Schema.Struct({ group: Schema.String })), jobs: Schema.Record(Schema.String, Schema.Struct({ steps: Schema.optional(Schema.Array(Schema.Struct({uses: Schema.optional(Schema.String), with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))}))), "timeout-minutes": Schema.optional(Schema.Number), strategy: Schema.optional(Strategy) })) })
const readWorkflow = (root: string, name: string) => decode(Workflow, Bun.YAML.parse(readFileSync(join(root, ".github/workflows", name + ".yml"), "utf8")))
export const checkWorkflows = (root: string) => {
  const refresh = readWorkflow(root, "fork-stack-refresh"), worker = readWorkflow(root, "fork-patch-worker")
  const publish = readWorkflow(root, "fork-nightly-publish"), assets = readWorkflow(root, "fork-build-assets")
  if (refresh.concurrency?.group !== "fork-maintenance" || publish.concurrency?.group !== refresh.concurrency.group) throw new Error("Refresh/publication must share the maintenance lock")
  if (worker.jobs.patch?.["timeout-minutes"] !== limits.policy.workerMinutes) throw new Error("Worker timeout differs from admission policy")
  if (refresh.jobs.coordinate["timeout-minutes"] !== limits.policy.coordinatorMinutes + limits.policy.cleanupMinutes) throw new Error("Coordinator timeout differs from policy")
  const builds = decode(Schema.Array(Schema.Struct({os:Schema.String})), assets.jobs.build.strategy?.matrix.include)
  const smoke = decode(Schema.Array(Schema.String), publish.jobs.smoke.strategy?.matrix.os)
  if ((builds.length + 1) * limits.policy.publicationArtifactMaxBytes + limits.policy.artifactMaxBytes > limits.policy.runArtifactBytes) throw new Error("Publication allocations exceed run budget")
  const shards = publish.jobs.test.strategy?.matrix.shard.length ?? 0
  if (builds.length + smoke.length + shards > limits.policy.publicationJobs || builds.filter(b => b.os.startsWith("macos-")).length + smoke.filter(os => os.startsWith("macos-")).length > limits.policy.publicationMacosJobs) throw new Error("Publication fanout exceeds policy")
  for (const workflow of [refresh, publish, assets]) for (const job of Object.values(workflow.jobs)) for (const step of job.steps ?? []) {
    if (step.uses?.startsWith("actions/upload-artifact@") && step.with?.["retention-days"] !== limits.policy.publicationArtifactRetentionDays) throw new Error("Artifact retention differs from policy")
  }
  for (const workflow of [refresh, worker, publish, assets]) for (const job of Object.values(workflow.jobs)) {
    if ((job["timeout-minutes"] ?? limits.platform.jobMinutes) > limits.platform.jobMinutes) throw new Error("Job exceeds platform duration")
    if (job.strategy && Object.values(job.strategy.matrix).reduce((n, rows) => n * rows.length, 1) > limits.platform.matrixJobs) throw new Error("Matrix exceeds platform limit")
  }
}
const Artifacts = Schema.Struct({artifacts: Schema.Array(Schema.Struct({size_in_bytes: Schema.Number, expired: Schema.Boolean}))})
export const artifactUsage = (path = "actions/artifacts") => Effect.gen(function*() {
  let bytes = 0
  for (let page = 1; page <= 100; page++) {
    const response = decode(Artifacts, yield* request(`${path}?per_page=100&page=${page}`))
    bytes += response.artifacts.filter(a => !a.expired).reduce((n, a) => n + a.size_in_bytes, 0)
    if (response.artifacts.length < 100) return bytes
  }
  return yield* Effect.fail("Artifact inventory exceeds bounded pagination")
})
export const preflight = () => Effect.gen(function*() {
  yield* Effect.try({try: () => checkWorkflows(process.cwd()), catch:String})
  const retained = yield* artifactUsage()
  yield* Effect.try({try: () => checkStorage(retained, limits.policy.runArtifactBytes), catch:String})
  console.log(JSON.stringify({retainedRepositoryBytes: retained, additionalRunBudget: limits.policy.runArtifactBytes, accountUsage: "unknown", scope: "repository snapshot; not an account reservation"}))
})
export const measureOutputs = (directory: string) => Effect.try({try: () => {
  const bytes = ["candidate.bundle", "input.json", "stack.json"].reduce((n, file) => n + statSync(join(directory, file)).size, 0)
  if (bytes > limits.policy.artifactMaxBytes) throw new Error("Combined stack output exceeds artifact budget")
}, catch:String})
if (import.meta.main) await Effect.runPromise(process.argv[2] === "published-inputs" ? Effect.gen(function*() {
  const retained = yield* artifactUsage()
  const current = yield* artifactUsage(`actions/runs/${process.env.GITHUB_RUN_ID}/artifacts`)
  yield* Effect.try({try: () => checkStorage(retained, 0), catch:String})
  yield* Effect.try({try: () => checkStorage(0, current), catch:String})
}) : preflight())
