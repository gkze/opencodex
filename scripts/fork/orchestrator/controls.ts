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

/** The fork tip's own control commits, oldest first: every stack commit that is not a patch (it
 * carries no `Patch-Id` trailer). A non-patch commit that reaches outside the control roots is
 * refused, because nothing would carry it: patches come from their branches, controls from here. */
export const controlCommits = (cwd: string, tip: string, upstream: string) => Effect.gen(function*() {
  const base = yield* git(cwd, "merge-base", tip, upstream)
  const commits = (yield* git(cwd, "rev-list", "--reverse", "--no-merges", `${base}..${tip}`)).split("\n").filter(Boolean)
  const controls: string[] = []
  for (const commit of commits) {
    if (/^Patch-Id: /m.test(yield* git(cwd, "show", "-s", "--format=%B", commit))) continue
    const outside = (yield* git(cwd, "diff-tree", "--no-commit-id", "--name-only", "-r", commit)).split("\n").filter(path => path && !carriedRoots.some(root => path.startsWith(`${root}/`)))
    if (outside.length) return yield* Effect.fail(`Control commit ${commit.slice(0, 12)} changes paths outside ${carriedRoots.join(", ")}: ${outside.slice(0, 5).join(", ")}`)
    controls.push(commit)
  }
  return controls
})

/** Replay the tip's control commits onto `cwd`'s HEAD, keeping each one's message, author and
 * boundary, so the fork's own history survives every rebuild instead of collapsing into one blob.
 * A commit upstream has made redundant is dropped. The tip's controls must then be fully present:
 * anything they hold that no commit carries fails here rather than disappearing from the stack. */
export const carryControlCommits = (cwd: string, tip: string, upstream: string) => Effect.gen(function*() {
  const carried: Array<{source: string, commit: string}> = []
  for (const source of yield* controlCommits(cwd, tip, upstream)) {
    const before = yield* git(cwd, "rev-parse", "HEAD")
    const picked = yield* git(cwd, "cherry-pick", "--empty=drop", source).pipe(Effect.result)
    if (picked._tag === "Failure") return yield* Effect.fail(`Control commit ${source.slice(0, 12)} does not apply: ${picked.failure}`)
    const after = yield* git(cwd, "rev-parse", "HEAD")
    if (after !== before) carried.push({source, commit: after})
  }
  yield* applyControls(cwd, tip, upstream)
  const missing = yield* git(cwd, "diff", "--cached", "--name-only")
  if (missing) return yield* Effect.fail(`Fork controls on ${tip.slice(0, 12)} that no control commit carries: ${missing.split("\n").slice(0, 5).join(", ")}`)
  return carried
})
