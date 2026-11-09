import { Effect } from "effect"
import { git } from "./process.ts"

/** Fork-owned control paths. A repair agent never writes these, whatever the patch touches. */
export const forkControls = [".github", "scripts/fork", "package.json", "bun.lock"] as const

export const isForkControl = (path: string) => forkControls.some(control => path === control || path.startsWith(`${control}/`))

/** The control roots that live only on the fork branch. Patch branches do not carry them. */
export const carriedRoots = [".github", "scripts/fork"] as const

/** Control paths the fork tip changed from upstream. Every tree built on a newer upstream takes
 * these from the tip. The stack assembly and each patch worker use this one list, so a patch is
 * validated against the same controls it ships with. */
export const carriedControls = (cwd: string, tip: string, upstream: string) => Effect.gen(function*() {
  const base = yield* git(cwd, "merge-base", tip, upstream)
  const listed = yield* git(cwd, "diff", "--name-status", "--no-renames", base, tip, "--", ...carriedRoots)
  const entries = listed.split("\n").filter(Boolean).map(line => line.split("\t") as [string, string])
  return {present: entries.filter(([status]) => status !== "D").map(([, path]) => path), deleted: entries.filter(([status]) => status === "D").map(([, path]) => path)}
})

/** Write the tip's controls into the work tree of `cwd` and stage them. */
export const applyControls = (cwd: string, tip: string, upstream: string) => Effect.gen(function*() {
  const controls = yield* carriedControls(cwd, tip, upstream)
  if (controls.present.length) yield* git(cwd, "checkout", tip, "--", ...controls.present)
  if (controls.deleted.length) yield* git(cwd, "rm", "-q", "--ignore-unmatch", "--", ...controls.deleted)
  return controls.present.length + controls.deleted.length
})
