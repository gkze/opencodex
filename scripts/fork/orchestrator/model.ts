import { Schema } from "effect"

export const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
export const Id = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/))
export const Patch = Schema.Struct({ id: Id, branch: Schema.String.check(Schema.isPattern(/^codex\/[a-z0-9/-]+$/)), requires: Schema.Array(Id), sensitive: Schema.Boolean, runner: Schema.Literals(["ubuntu-24.04", "macos-15"]), tests: Schema.Array(Schema.String) })
export const Registry = Schema.Struct({ version: Schema.Literal(1), patches: Schema.Array(Patch) })
export type Patch = typeof Patch.Type
export type Registry = typeof Registry.Type
export const CapturedPatch = Schema.Struct({ ...Patch.fields, source: Sha })
export const Input = Schema.Struct({ run: Schema.String, control: Sha, upstream: Sha, old: Sha, patches: Schema.Array(CapturedPatch), deadline: Schema.Number })
export type Input = typeof Input.Type
export const Result = Schema.Struct({ id: Id, source: Sha, upstream: Sha, base: Sha, candidate: Sha, adapted: Schema.Boolean })
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
export const Stack = Schema.Struct({input: Input, results: Schema.Array(Result), mapped: Schema.Array(Schema.Struct({id: Id, commit: Sha})), candidate: Sha})
