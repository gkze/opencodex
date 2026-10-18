import { Schema } from "effect"
import { decode } from "./model.ts"
import configuration from "./limits.json"
const Positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
const Entitlement = Schema.Struct({ value: Positive, status: Schema.Literals(["verified", "assumed"]), source: Schema.String })
const Limits = Schema.Struct({ version: Schema.Literal(1), platform: Schema.Struct({ source: Schema.String, verifiedAt: Schema.String, jobMinutes: Positive, matrixJobs: Positive, githubTokenRequestsPerHour: Positive }), account: Schema.Struct({ owner: Schema.String, plan: Schema.Struct({status: Schema.Literal("unknown"), reason: Schema.String}), concurrentJobs: Entitlement, macosJobs: Entitlement, artifactBytes: Entitlement, verifiedAt: Schema.String }), policy: Schema.Struct({workerJobs: Positive, macosJobs: Positive, reservedJobs: Positive, coordinatorMinutes: Positive, workerMinutes: Positive, cleanupMinutes: Positive, pollSeconds: Positive, agentAttempts: Positive, artifactMaxBytes: Positive, runnerLabels: Schema.Array(Schema.String)}) })
export const limits = decode(Limits, configuration)
export const capacity = (observedJobs: number, reservedWorkers: number) => Math.max(0, Math.min(limits.policy.workerJobs - reservedWorkers, limits.account.concurrentJobs.value - observedJobs - limits.policy.reservedJobs - 1))
export const canStart = (deadline: number, now: number, minutes = limits.policy.workerMinutes) => now + (minutes + limits.policy.cleanupMinutes) * 60_000 < deadline
if (limits.policy.coordinatorMinutes >= limits.platform.jobMinutes) throw new Error("Coordinator lacks deadline headroom")
