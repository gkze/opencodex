import { Effect } from "effect"
import { git } from "./process.ts"
import { replay, commitPatch } from "./replay.ts"
import { decode, Registry, order } from "./model.ts"
import registryJson from "./registry.json"
const cwd = process.argv[2], root = process.cwd()
await Effect.runPromise(Effect.gen(function*() {
  for (const patch of order(decode(Registry, registryJson).patches)) {
    const source = yield* git(root, "rev-parse", patch.branch)
    const applied = yield* replay(cwd, source, root)
    if (!applied.ok) return yield* Effect.fail(`${patch.id}: ${applied.reason}`)
    yield* commitPatch(cwd, source, patch.id)
    console.log(patch.id, yield* git(cwd, "rev-parse", "HEAD"))
  }
}))
