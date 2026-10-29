import type { Patch } from "./model.ts"

/**
 * A patch that cannot be replayed tonight is skipped for this build instead of failing it, and
 * everything that requires one is skipped with it: a dependent replayed onto a base missing its
 * dependency would ship a revision no reviewer approved. `ordered` comes from `order`, so a
 * patch is always visited after its dependencies.
 */
export const quarantine = (ordered: readonly Patch[], blocked: ReadonlyMap<string, string>): ReadonlyMap<string, string> => {
  const skipped = new Map<string, string>()
  for (const patch of ordered) {
    const reason = blocked.get(patch.id)
    if (reason) {
      skipped.set(patch.id, reason)
      continue
    }
    const dependency = patch.requires.find(id => skipped.has(id))
    if (dependency) skipped.set(patch.id, `requires quarantined ${dependency}`)
  }
  return skipped
}
