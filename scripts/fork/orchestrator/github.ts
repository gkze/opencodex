import { Effect, Schema } from "effect"
import { decode } from "./model.ts"
export const Repository = "gkze/opencodex"
export const Run = Schema.Struct({ id: Schema.Number, name: Schema.String, display_title: Schema.String, head_sha: Schema.String, event: Schema.String, status: Schema.String, conclusion: Schema.NullOr(Schema.String), path: Schema.String, head_repository: Schema.Struct({ full_name: Schema.String }) })
export const Runs = Schema.Struct({ workflow_runs: Schema.Array(Run) })
let remaining = Number.POSITIVE_INFINITY
let resetAt = 0
export const request = (path: string, body?: unknown) => Effect.tryPromise({
  try: async signal => {
    const token = process.env.GH_TOKEN
    if (!token) throw new Error("GH_TOKEN is required")
    if (remaining < 20 && Date.now() < resetAt) throw new Error(`API reserve reached; resume after ${new Date(resetAt).toISOString()}`)
    const response = await fetch(`https://api.github.com/repos/${Repository}/${path}`, { signal, method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
    const observedRemaining = response.headers.get("x-ratelimit-remaining")
    const observedReset = response.headers.get("x-ratelimit-reset")
    if (observedRemaining !== null) remaining = Number(observedRemaining)
    if (observedReset !== null) resetAt = Number(observedReset) * 1000
    if (!response.ok) throw new Error(`GitHub ${response.status}; remaining=${response.headers.get("x-ratelimit-remaining")}; reset=${response.headers.get("x-ratelimit-reset")}; retry-after=${response.headers.get("retry-after")}`)
    return response.status === 204 ? null : await response.json() as unknown
  }, catch: String,
})
export const dispatch = (attempt: string, control: string, payload: string, runner: string) => Effect.gen(function*() {
  const matches: Array<typeof Run.Type> = []
  for (let page = 1; ; page++) {
    const runs = decode(Runs, yield* request(`actions/workflows/fork-patch-worker.yml/runs?event=workflow_dispatch&per_page=100&page=${page}`))
    matches.push(...runs.workflow_runs.filter(r => r.display_title === attempt && r.head_sha === control))
    if (runs.workflow_runs.length < 100) break
    if (page >= 10) return yield* Effect.fail("Dispatch history exceeds reconciliation window; refusing ambiguous dispatch")
  }
  if (matches.length > 1) return yield* Effect.fail("Ambiguous duplicate dispatch; hold run")
  if (matches.length === 1) return matches[0].id
  const ref = process.env.GITHUB_REF_NAME
  if (!ref) return yield* Effect.fail("Missing trusted dispatch ref")
  const response = yield* request("actions/workflows/fork-patch-worker.yml/dispatches", { ref, inputs: { attempt, control, payload, runner } })
  return decode(Schema.Struct({workflow_run_id: Schema.Number}), response).workflow_run_id
})
export const wait = (runId: number, attempt: string, control: string, deadline: number) => Effect.gen(function*() {
  while (Date.now() < deadline) {
    const run = decode(Run, yield* request(`actions/runs/${runId}`))
    if (run.head_sha !== control || run.display_title !== attempt || run.head_repository.full_name !== Repository || run.path !== ".github/workflows/fork-patch-worker.yml" || run.event !== "workflow_dispatch") return yield* Effect.fail("Worker identity mismatch")
    if (run.status === "completed") {
      if (run.conclusion !== "success") return yield* Effect.fail(`Worker ${runId} ${run.conclusion}`)
      return runId
    }
    yield* Effect.sleep("60 seconds")
  }
  yield* request(`actions/runs/${runId}/cancel`, {})
  return yield* Effect.fail("Worker deadline exceeded")
})
