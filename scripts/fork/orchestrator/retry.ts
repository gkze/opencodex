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
