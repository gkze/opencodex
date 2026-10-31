import { Effect } from "effect"
import { join, resolve } from "node:path"
import { appendFileSync } from "node:fs"
import { decode, Stack, Registry } from "./model.ts"
import { git } from "./process.ts"
import registryJson from "./registry.json"
const directory = resolve(process.argv[2]), root = process.cwd()
const stack = decode(Stack, await Bun.file(join(directory, "stack.json")).json())
const registry = decode(Registry, registryJson)
await Effect.runPromise(Effect.gen(function*() {
  const source = process.env.SOURCE_SHA
  if (source !== stack.input.old || source !== stack.input.control || (yield* git(root, "rev-parse", "HEAD")) !== source) return yield* Effect.fail("Untrusted stack source")
  const remote = yield* git(root, "remote", "get-url", "origin")
  if (remote !== "https://github.com/gkze/opencodex" && remote !== "https://github.com/gkze/opencodex.git") return yield* Effect.fail("Not the fork remote")
  if (JSON.stringify(stack.input.patches.map(({source, ...p}) => p)) !== JSON.stringify(registry.patches)) return yield* Effect.fail("Registry changed")
  for (const patch of stack.input.patches) {
    const actual = (yield* git(root, "ls-remote", "origin", `refs/heads/${patch.branch}`)).split("\t")[0]
    if (actual !== patch.source) return yield* Effect.fail(`Patch advanced: ${patch.id}`)
  }
  const ids = registry.patches.map(p => p.id).sort().join("\n")
  if (stack.results.map(p => p.id).sort().join("\n") !== ids || stack.mapped.map(p => p.id).sort().join("\n") !== ids) return yield* Effect.fail("Incomplete or duplicate patch mapping")
  yield* git(root, "fetch", "https://github.com/lidge-jun/opencodex.git", "dev")
  yield* git(root, "merge-base", "--is-ancestor", stack.input.upstream, "FETCH_HEAD")
  yield* git(root, "bundle", "verify", join(directory, "candidate.bundle"))
  yield* git(root, "fetch", join(directory, "candidate.bundle"), "refs/heads/nightly-candidate")
  if ((yield* git(root, "rev-parse", "FETCH_HEAD")) !== stack.candidate) return yield* Effect.fail("Bundle candidate differs")
  yield* git(root, "merge-base", "--is-ancestor", stack.input.upstream, stack.candidate)
  if (yield* git(root, "rev-list", "--merges", `${stack.input.upstream}..${stack.candidate}`)) return yield* Effect.fail("Nonlinear integration")
  const commits = (yield* git(root, "rev-list", `${stack.input.upstream}..${stack.candidate}`)).split("\n").sort().join("\n")
  if (commits !== stack.mapped.map(p => p.commit).sort().join("\n")) return yield* Effect.fail("Unmapped integration commits")
  const controls = [".github", "scripts/fork"]
  const base = yield* git(root, "merge-base", stack.input.old, stack.input.upstream)
  for (const path of (yield* git(root, "diff", "--name-only", stack.input.old, stack.candidate, "--", ...controls)).split("\n").filter(Boolean)) {
    if ((yield* git(root, "diff", "--name-only", base, stack.input.old, "--", path)) || (yield* git(root, "diff", "--name-only", stack.input.upstream, stack.candidate, "--", path))) return yield* Effect.fail(`Control conflict: ${path}`)
  }
  for (const result of stack.results) {
    const patch = stack.input.patches.find(p => p.id === result.id)!
    if (patch.source !== result.source || result.upstream !== stack.input.upstream || (result.adapted && patch.sensitive)) return yield* Effect.fail("Patch provenance mismatch")
    yield* git(root, "fetch", join(directory, "candidate.bundle"), result.candidate)
    yield* git(root, "merge-base", "--is-ancestor", stack.input.upstream, result.candidate)
    if ((yield* git(root, "rev-parse", `${result.candidate}^`)) !== result.base) return yield* Effect.fail("Patch base differs")
  }
  yield* git(root, "push", "origin", `${stack.candidate}:refs/heads/nightly-${process.env.GITHUB_RUN_ID}`)
  appendFileSync(process.env.GITHUB_OUTPUT!, `candidate=${stack.candidate}\nold=${stack.input.old}\nupstream=${stack.input.upstream}\n`)
}))
