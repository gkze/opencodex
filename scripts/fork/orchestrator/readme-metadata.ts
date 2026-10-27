import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Effect, Schema } from "effect"
import { merge } from "./merge.ts"
import { decode } from "./model.ts"
import { git, command } from "./process.ts"

const path = "readme/i18n-manifest.json"
const Manifest = Schema.Struct({
  source: Schema.Literal("README.md"),
  note: Schema.optional(Schema.String),
  locales: Schema.Record(Schema.String, Schema.Struct({
    file: Schema.String, label: Schema.String, docsPath: Schema.String, sourceSha256: Schema.String,
  })),
})
export const readmeHash = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex")
export const readmeManifest = (text: string) => {
  const raw: unknown = JSON.parse(text), manifest = decode(Manifest, raw)
  if (!isDeepStrictEqual(raw, manifest)) throw new Error("Unsupported README manifest fields")
  if (!Object.keys(manifest.locales).length) throw new Error("Empty README locale registry")
  for (const [code, entry] of Object.entries(manifest.locales)) {
    if (!/^[A-Za-z-]+$/.test(code) || entry.file !== `readme/README.${code}.md`) throw new Error("Invalid README locale path")
  }
  return manifest
}
type Snapshot = { manifest: string, readme: string }
/** Hashes are derived only after preserving both synchronized inputs' metadata. */
export const mergeReadmeManifest = (snapshots: readonly Snapshot[], mergedReadme: string) => {
  if (snapshots.length !== 3) throw new Error("Expected base, current and patch README snapshots")
  const values = snapshots.map(snapshot => {
    const manifest = readmeManifest(snapshot.manifest)
    const hash = readmeHash(snapshot.readme)
    for (const entry of Object.values(manifest.locales)) {
      if (entry.sourceSha256 !== hash) throw new Error("README input has stale translation hashes")
    }
    return {...manifest, locales: Object.fromEntries(Object.entries(manifest.locales).map(([code, entry]) => [code, {...entry, sourceSha256: ""}]))}
  })
  const merged = readmeManifest(JSON.stringify(merge(values[0], values[1], values[2])))
  const hash = readmeHash(mergedReadme)
  return JSON.stringify({...merged, locales: Object.fromEntries(Object.entries(merged.locales).map(([code, entry]) => [code, {...entry, sourceSha256: hash}]))}, null, 2) + "\n"
}

/** Read Git blobs, not working-tree paths or executable code from the candidate. */
export const reconcileReadme = (cwd: string, parent: string, before: string, source: string) => Effect.gen(function*() {
  if (!(yield* git(cwd, "diff", "--name-only", parent, source, "--", "README.md", path, "readme"))) return
  // Leave textual conflicts for the normal repair/review path, never certify them.
  if (yield* git(cwd, "diff", "--name-only", "--diff-filter=U", "--", "README.md", "readme/*.md")) return
  const snapshots = yield* Effect.forEach([parent, before, source], ref => Effect.gen(function*() {
    const manifest = yield* git(cwd, "show", `${ref}:${path}`)
    // command() trims stdout; restore exact blob bytes before hashing.
    const readme = yield* command(["git", "show", `${ref}:README.md`], cwd, process.env, {trimOutput: false})
    return {manifest, readme}
  }))
  const files = yield* Effect.try({try: () => new Set(snapshots.flatMap(s => Object.values(readmeManifest(s.manifest).locales).map(e => e.file))), catch: String})
  // Requiring staged regular blobs also excludes deletions, symlinks and escaped paths.
  for (const file of ["README.md", ...files]) {
    if (!(yield* git(cwd, "ls-files", "--stage", "--", file)).startsWith("100644 ")) return yield* Effect.fail(`README is not a regular staged file: ${file}`)
  }
  const readme = yield* Effect.promise(() => Bun.file(`${cwd}/README.md`).text())
  const merged = yield* Effect.try({try: () => mergeReadmeManifest(snapshots, readme), catch: String})
  yield* Effect.promise(() => Bun.write(`${cwd}/${path}`, merged))
  yield* git(cwd, "add", path)
})
