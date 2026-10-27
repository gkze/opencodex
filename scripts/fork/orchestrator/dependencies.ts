import { Effect } from "effect"
import { git } from "./process.ts"

/** Keep accepted dependency commits in ancestry, including a deterministic merge for independent parents. */
export const dependencyBase = (cwd: string, upstream: string, dependencies: readonly string[]) => Effect.gen(function*() {
  yield* git(cwd, "checkout", "--detach", upstream)
  for (const dependency of dependencies) {
    yield* git(cwd, "merge-base", "--is-ancestor", upstream, dependency)
    yield* git(cwd, "merge", "--no-edit", dependency)
  }
  return yield* git(cwd, "rev-parse", "HEAD")
})
