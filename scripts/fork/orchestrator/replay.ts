import { Effect } from "effect"
import { git, command } from "./process.ts"
import { merge, renderMetadata } from "./merge.ts"
import { join } from "node:path"
import { reconcileReadme } from "./readme-metadata.ts"
const metadata = ["structure/manifest.json", "scripts/test-layout/layout.json", "tests/fixtures/test-layout-expected.json"]
export const replay = (cwd: string, source: string, trustedRoot: string) => Effect.gen(function*() {
  const parent = yield* git(cwd, "rev-parse", `${source}^`)
  const before = yield* git(cwd, "rev-parse", "HEAD")
  const attempt = yield* git(cwd, "cherry-pick", "--no-commit", source).pipe(Effect.result)
  // Generated metadata is reconciled from its authority even if Git's text merge succeeds.
  for (const path of metadata) {
    if (!(yield* git(cwd, "diff", "--name-only", parent, source, "--", path))) continue
    const values = yield* Effect.forEach([parent, before, source], ref => git(cwd, "show", `${ref}:${path}`))
    const value = yield* Effect.try({ try: () => merge(...values.map(v => JSON.parse(v)) as [unknown, unknown, unknown]), catch: String })
    yield* Effect.promise(() => Bun.write(join(cwd, path), (path === "tests/fixtures/test-layout-expected.json" ? renderMetadata(values[1], value) : JSON.stringify(value, null, 2) + "\n")))
    yield* git(cwd, "add", path)
  }
  // Use the captured control revision's generator, never agent-proposed executable code.
  yield* command(["bun", join(trustedRoot, "scripts/fork/orchestrator/render-index.ts"), cwd], trustedRoot)
  yield* git(cwd, "add", "structure/INDEX.md")
  yield* reconcileReadme(cwd, parent, before, source)
  const conflicts = yield* git(cwd, "diff", "--name-only", "--diff-filter=U")
  if (conflicts) return { ok: false as const, reason: `Conflicts: ${conflicts}` }
  if (attempt._tag === "Failure" && !(yield* git(cwd, "diff", "--cached", "--name-only"))) return { ok: false as const, reason: "Replay failed without staged changes" }
  return { ok: true as const, reason: "" }
})

export const commitPatch = (cwd: string, source: string, id: string) => Effect.gen(function*() {
  const author = yield* git(cwd, "show", "-s", "--format=%an <%ae>", source)
  const original = yield* git(cwd, "show", "-s", "--format=%B", source)
  const credits = original.split("\n").filter(line => /^Co-authored-by:/i.test(line))
  const base = yield* git(cwd, "rev-parse", "HEAD")
  yield* git(cwd, "commit", "--allow-empty", "--author", author, "-m", [`Maintain ${id}`, "", `Patch-Id: ${id}`, `Patch-Source: ${source}`, `Patch-Base: ${base}`, ...credits].join("\n"))
})
