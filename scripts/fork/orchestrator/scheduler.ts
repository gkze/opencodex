import { Deferred, Effect, Semaphore } from "effect"
import { order, type Patch } from "./model.ts"

/** Dependency waits hold no permits. A completed patch immediately releases a worker slot. */
export const schedule = <A, E, R>(patches: readonly Patch[], workers: number, macos: number, execute: (patch: Patch, dependencies: readonly A[]) => Effect.Effect<A, E, R>) => Effect.gen(function*() {
  if (!Number.isInteger(workers) || workers < 1 || !Number.isInteger(macos) || macos < 1) throw new Error("Scheduler requires positive permits")
  const sorted = order(patches)
  const slots = yield* Semaphore.make(workers)
  const macSlots = yield* Semaphore.make(macos)
  const done = new Map<string, Deferred.Deferred<A>>()
  for (const patch of sorted) done.set(patch.id, yield* Deferred.make<A>())
  return yield* Effect.forEach(sorted, patch => Effect.gen(function*() {
    const dependencies = yield* Effect.forEach(patch.requires, id => Deferred.await(done.get(id)!))
    const task = execute(patch, dependencies).pipe(slots.withPermits(1))
    const result = yield* (patch.runner.startsWith("macos-") ? task.pipe(macSlots.withPermits(1)) : task)
    yield* Deferred.succeed(done.get(patch.id)!, result)
    return result
  }), {concurrency: "unbounded"})
})
