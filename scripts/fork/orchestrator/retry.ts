import { Effect } from "effect"

/** A worker that dies in prepare or loses its runner says nothing about the patch, so the
 * refresh re-dispatches it once instead of discarding every other patch in the same night. */
export const workerAttempts = 2

export const dispatchWithRetry = <A, E, R>(
  worker: (attempt: number) => Effect.Effect<A, E, R>,
  onRetry: (failure: E) => void = () => {},
) => Effect.gen(function*() {
  for (let attempt = 0; attempt < workerAttempts; attempt++) {
    const result = yield* worker(attempt).pipe(Effect.result)
    if (result._tag === "Success") return result.success
    if (attempt === workerAttempts - 1) return yield* Effect.fail(result.failure)
    onRetry(result.failure)
  }
  return yield* Effect.die("unreachable worker attempt")
})

/** GitHub-side failures that say nothing about the ref being pushed: a 5xx from the remote or a
 * connection that dropped mid-transfer. A lease or permission refusal is not in this set. */
export const isTransientGitFailure = (failure: string) =>
  /\bHTTP\/?[\d.]* 5\d\d\b|returned error: 5\d\d\b|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out|RPC failed|early EOF|Connection reset|Connection timed out|Could not resolve host|unexpected disconnect/i.test(failure)

export const remoteAttempts = 3

/** Re-run an idempotent remote operation after a transient GitHub failure, a bounded number of
 * times with growing delay. The operation must re-read remote state on each attempt, so a write
 * the remote applied before reporting an error is observed rather than repeated. */
export const retryTransient = <A, R>(
  operation: Effect.Effect<A, string, R>,
  onRetry: (failure: string) => void = () => {},
  delayMillis = (attempt: number) => 5_000 * 2 ** attempt,
) => Effect.gen(function*() {
  for (let attempt = 0; attempt < remoteAttempts; attempt++) {
    const result = yield* operation.pipe(Effect.result)
    if (result._tag === "Success") return result.success
    if (attempt === remoteAttempts - 1 || !isTransientGitFailure(result.failure)) return yield* Effect.fail(result.failure)
    onRetry(result.failure)
    yield* Effect.sleep(delayMillis(attempt))
  }
  return yield* Effect.die("unreachable remote attempt")
})
