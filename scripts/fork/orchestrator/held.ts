import { Effect } from "effect"
import { git } from "./process.ts"

/** The revision of a patch that the last accepted stack published. Assemble writes
 * `Patch-Id` trailers, so the branch history is the record of what already shipped. */
export const lastAccepted = (root: string, old: string, id: string) => Effect.gen(function*() {
  const found = yield* git(root, "log", "-1", "--format=%H", `--grep=^Patch-Id: ${id}$`, old)
  return found || null
})
