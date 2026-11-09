import { Schema } from "effect"

export const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
export const Id = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/))
/** `droppable` opts a patch into being left out of a night's stack when neither its current revision
 * nor its last accepted one replays onto upstream. Without it, such a patch fails the refresh: some
 * patches carry the nightly itself (its release channel, its build), and a stack without them is
 * not a smaller nightly but a broken one. */
export const Patch = Schema.Struct({ id: Id, branch: Schema.String.check(Schema.isPattern(/^codex\/[a-z0-9/-]+$/)), requires: Schema.Array(Id), sensitive: Schema.Boolean, droppable: Schema.optional(Schema.Boolean), runner: Schema.Literals(["ubuntu-24.04", "macos-15"]), tests: Schema.Array(Schema.String) })
export const Registry = Schema.Struct({ version: Schema.Literal(1), patches: Schema.Array(Patch) })
export type Patch = typeof Patch.Type
export type Registry = typeof Registry.Type
export const CapturedPatch = Schema.Struct({ ...Patch.fields, source: Sha })
export const Input = Schema.Struct({ run: Schema.String, control: Sha, upstream: Sha, old: Sha, patches: Schema.Array(CapturedPatch), deadline: Schema.Number })
export type Input = typeof Input.Type
export const Result = Schema.Struct({ id: Id, source: Sha, upstream: Sha, base: Sha, candidate: Sha, adapted: Schema.Boolean, hold: Schema.optional(Schema.Boolean) })
export type Result = typeof Result.Type
export const decode = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S, value: unknown): S["Type"] => Schema.decodeUnknownSync(schema)(value)

export const order = (patches: ReadonlyArray<Patch>): ReadonlyArray<Patch> => {
  const byId = new Map(patches.map(p => [p.id, p]))
  if (byId.size !== patches.length) throw new Error("Duplicate patch identity")
  const done = new Set<string>(), visiting = new Set<string>(), result: Patch[] = []
  const visit = (id: string) => {
    if (done.has(id)) return
    if (visiting.has(id)) throw new Error(`Dependency cycle at ${id}`)
    const patch = byId.get(id)
    if (!patch) throw new Error(`Missing dependency ${id}`)
    visiting.add(id)
    patch.requires.forEach(visit)
    visiting.delete(id); done.add(id); result.push(patch)
  }
  patches.forEach(p => visit(p.id))
  return result
}
/** A patch left out of tonight's stack, and why. */
export const Dropped = Schema.Struct({ id: Id, dropped: Schema.Literal(true), reason: Schema.String })
export type Dropped = typeof Dropped.Type
export const Settled = Schema.Union([Result, Dropped])
export type Settled = typeof Settled.Type
export const isDropped = (settled: Settled): settled is Dropped => "dropped" in settled
// `dropped` is optional so a stack written before patches could be dropped still decodes.
export const Stack = Schema.Struct({input: Input, results: Schema.Array(Result), dropped: Schema.optional(Schema.Array(Dropped)), mapped: Schema.Array(Schema.Struct({id: Id, commit: Sha})), candidate: Sha})

/** Why a stack does not account for every registered patch exactly once, or null when it does.
 * A patch ships (a result with a mapped commit) or is dropped; only an opted-in patch may be
 * dropped, and so must everything that requires it, because a dependent replayed without its
 * dependency is not the patch that was verified. */
export const coverageFailure = (patches: ReadonlyArray<Patch>, results: ReadonlyArray<string>, mapped: ReadonlyArray<string>, dropped: ReadonlyArray<string>): string | null => {
  const key = (ids: ReadonlyArray<string>) => [...ids].sort().join("\n")
  if (new Set([...results, ...dropped]).size !== results.length + dropped.length) return "Duplicate or shipped-and-dropped patch"
  if (key([...results, ...dropped]) !== key(patches.map(p => p.id)) || key(mapped) !== key(results)) return "Incomplete or duplicate patch mapping"
  const left = new Set(dropped)
  for (const patch of patches) {
    if (left.has(patch.id) && !patch.droppable) return `Patch ${patch.id} is not droppable`
    const missing = patch.requires.find(id => left.has(id))
    if (missing && !left.has(patch.id)) return `Patch ${patch.id} ships without its dropped dependency ${missing}`
  }
  return null
}
