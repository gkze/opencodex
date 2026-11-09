import { Effect } from "effect"
import { existsSync, rmSync, mkdirSync } from "node:fs"
import { resolve, sep } from "node:path"
import { git } from "./process.ts"
/** Rebuild only disposable activity scratch state; durable results live in Workflow SQL. */
export const freshWorktree = (root: string, directory: string, cwd: string, base: string) => Effect.gen(function*() {
  if (!resolve(cwd).startsWith(resolve(directory) + sep)) return yield* Effect.fail("Scratch path escapes run directory")
  if (existsSync(cwd)) yield* git(root, "worktree", "remove", "--force", cwd)
  yield* git(root, "worktree", "prune")
  yield* git(root, "worktree", "add", "--detach", cwd, base)
})
export const freshDirectory = (directory: string, target: string) => {
  if (!resolve(target).startsWith(resolve(directory) + sep)) throw new Error("Artifact path escapes run directory")
  rmSync(target, {recursive: true, force: true}); mkdirSync(target, {recursive: true})
}
