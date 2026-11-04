import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { git } from "./process.ts"
import { mergeReadmeManifest, readmeHash, reconcileReadme } from "./readme-metadata.ts"

const manifest = (readme: string, label = "Français") => JSON.stringify({
  source: "README.md",
  locales: {fr: {file: "readme/README.fr.md", label, docsPath: "fr", sourceSha256: readmeHash(readme)}},
})
test("README hashes derive from both synchronized inputs with normalized line endings", () => {
  const snapshots = ["base\n", "current\n", "patch\n"].map(readme => ({readme, manifest: manifest(readme)}))
  const result = JSON.parse(mergeReadmeManifest(snapshots, "merged\r\n"))
  expect(result.locales.fr.sourceSha256).toBe(readmeHash("merged\n"))
  expect(result.locales.fr.label).toBe("Français")
  for (let index = 0; index < snapshots.length; index++) {
    expect(() => mergeReadmeManifest(snapshots.map((s, i) => i === index ? {...s, readme: "stale"} : s), "merged")).toThrow("stale")
  }
  expect(() => mergeReadmeManifest([
    snapshots[0], {...snapshots[1], manifest: manifest("current\n", "French")},
    {...snapshots[2], manifest: manifest("patch\n", "Fr")},
  ], "merged")).toThrow("Conflicting")
  expect(() => mergeReadmeManifest(snapshots.map(s => ({...s, manifest: s.manifest.replace("readme/README.fr.md", "../outside")})), "merged")).toThrow("path")
})

test("Git replay reconciles hash-only conflicts but leaves prose conflicts unresolved", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ocx-readme-replay-"))
  const baseText = "top\n\none\n\ntwo\n\nthree\n\nbottom\n"
  const currentText = baseText.replace("top", "upstream")
  const patchText = baseText.replace("bottom", "fork")
  const write = (text: string) => {
    writeFileSync(join(cwd, "README.md"), text)
    writeFileSync(join(cwd, "readme/README.fr.md"), text)
    writeFileSync(join(cwd, "readme/i18n-manifest.json"), manifest(text))
  }
  try {
    mkdirSync(join(cwd, "readme"))
    await Effect.runPromise(Effect.gen(function*() {
      yield* git(cwd, "init")
      yield* git(cwd, "config", "user.name", "Fixture")
      yield* git(cwd, "config", "user.email", "test@example.com")
      write(baseText)
      yield* git(cwd, "add", "."); yield* git(cwd, "commit", "-m", "base")
      const base = yield* git(cwd, "rev-parse", "HEAD")
      write(patchText)
      yield* git(cwd, "add", "."); yield* git(cwd, "commit", "-m", "patch")
      const source = yield* git(cwd, "rev-parse", "HEAD")
      yield* git(cwd, "checkout", "--detach", base)
      write(currentText)
      yield* git(cwd, "add", "."); yield* git(cwd, "commit", "-m", "current")
      const current = yield* git(cwd, "rev-parse", "HEAD")
      expect((yield* git(cwd, "cherry-pick", "--no-commit", source).pipe(Effect.result))._tag).toBe("Failure")
      expect(yield* git(cwd, "diff", "--name-only", "--diff-filter=U")).toBe("readme/i18n-manifest.json")
      yield* reconcileReadme(cwd, base, current, source)
      expect(yield* git(cwd, "diff", "--name-only", "--diff-filter=U")).toBe("")
      const merged = baseText.replace("top", "upstream").replace("bottom", "fork")
      expect(readFileSync(join(cwd, "README.md"), "utf8")).toBe(merged)
      expect(readFileSync(join(cwd, "readme/README.fr.md"), "utf8")).toBe(merged)
      expect(JSON.parse(readFileSync(join(cwd, "readme/i18n-manifest.json"), "utf8")).locales.fr.sourceSha256).toBe(readmeHash(merged))
      const tree = yield* git(cwd, "write-tree")
      yield* git(cwd, "reset", "--hard", current)
      yield* git(cwd, "cherry-pick", "--no-commit", source).pipe(Effect.result)
      yield* reconcileReadme(cwd, base, current, source)
      expect(yield* git(cwd, "write-tree")).toBe(tree)
      rmSync(join(cwd, "README.md"))
      symlinkSync("readme/README.fr.md", join(cwd, "README.md"))
      yield* git(cwd, "add", "README.md")
      const unsafe = yield* reconcileReadme(cwd, base, current, source).pipe(Effect.result)
      expect(unsafe._tag).toBe("Failure")
      yield* git(cwd, "reset", "--hard", base)
      write(baseText.replace("bottom", "overlap"))
      yield* git(cwd, "add", "."); yield* git(cwd, "commit", "-m", "overlap")
      const overlap = yield* git(cwd, "rev-parse", "HEAD")
      yield* git(cwd, "cherry-pick", "--no-commit", source).pipe(Effect.result)
      const unresolved = yield* git(cwd, "diff", "--name-only", "--diff-filter=U")
      yield* reconcileReadme(cwd, base, overlap, source)
      expect(yield* git(cwd, "diff", "--name-only", "--diff-filter=U")).toBe(unresolved)
      expect(unresolved).toContain("README.md")
    }))
  } finally {rmSync(cwd, {recursive: true, force: true})}
})
