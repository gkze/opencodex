import { expect, test } from "bun:test"
import { merge, renderMetadata } from "./merge.ts"

// Shapes of upstream's hand-formatted metadata: a registry several entries to a line, and a
// manifest of path-keyed entries with compact arrays.
const registry = `{
  "version": 1,
  "explicit": { "a.test.ts": "cli", "b.test.ts": "server",
    "c.test.ts": "routing", "d.test.ts": "cli" }
}
`
const manifest = `{
  "docs": [
    {
      "path": "one.md",
      "documents": ["src/one.ts", "src/two.ts"]
    },
    {
      "path": "upstream-new.md",
      "documents": ["src/new.ts"]
    }
  ]
}
`

test("a patch's metadata change edits only its own entries and keeps upstream's layout", () => {
  const added = renderMetadata(registry, {version: 1, explicit: {...JSON.parse(registry).explicit, "e.test.ts": "clients"}})
  expect(added.split("\n").length).toBe(registry.split("\n").length)
  expect(added.split("\n").slice(0, 3)).toEqual(registry.split("\n").slice(0, 3))
  expect(JSON.parse(added).explicit["e.test.ts"]).toBe("clients")
  expect(renderMetadata(registry, JSON.parse(registry))).toBe(registry)
})

test("path-keyed entries are matched by identity: upstream's order stays, the patch's entry is appended", () => {
  // The patch was written before upstream added upstream-new.md; the merge must not move it.
  const base = {docs: [{path: "one.md", documents: ["src/one.ts", "src/two.ts"]}]}
  const patch = {docs: [{path: "one.md", documents: ["src/one.ts", "src/two.ts"]}, {path: "fork.md", documents: ["src/fork.ts"]}]}
  const rendered = renderMetadata(manifest, merge(base, JSON.parse(manifest), patch))
  expect(JSON.parse(rendered).docs.map((d: {path: string}) => d.path)).toEqual(["one.md", "upstream-new.md", "fork.md"])
  expect(rendered.startsWith(manifest.slice(0, manifest.lastIndexOf("    }\n  ]")))).toBe(true)
  const changed = renderMetadata(manifest, {docs: [{path: "upstream-new.md", documents: ["src/new.ts"]}, {path: "one.md", documents: ["src/one.ts"]}]})
  expect(JSON.parse(changed).docs).toEqual([{path: "one.md", documents: ["src/one.ts"]}, {path: "upstream-new.md", documents: ["src/new.ts"]}])
  expect(JSON.parse(renderMetadata(manifest, {docs: [{path: "upstream-new.md", documents: ["src/new.ts"]}]})).docs.map((d: {path: string}) => d.path)).toEqual(["upstream-new.md"])
})

test("one-entry-per-line objects take a new scalar on its own line", () => {
  const text = `{\n  "a": 1,\n  "b": 2\n}\n`
  expect(renderMetadata(text, {a: 1, b: 2, c: 3})).toBe(`{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n`)
})

test("a one-line list gains and loses elements in place instead of expanding", () => {
  const text = `{\n  "explicitShards": ["a.json", "b.json", "c.json"],\n  "x": 1\n}\n`
  const appended = renderMetadata(text, {explicitShards: ["a.json", "b.json", "c.json", "d.json"], x: 1})
  expect(appended.split("\n").length).toBe(text.split("\n").length)
  expect(JSON.parse(appended).explicitShards).toEqual(["a.json", "b.json", "c.json", "d.json"])
  const removed = renderMetadata(text, {explicitShards: ["a.json", "c.json"], x: 1})
  expect(removed.split("\n").length).toBe(text.split("\n").length)
  expect(JSON.parse(removed).explicitShards).toEqual(["a.json", "c.json"])
  expect(renderMetadata(text, {explicitShards: ["a.json", "b.json"], x: 1})).toBe(`{\n  "explicitShards": ["a.json", "b.json"],\n  "x": 1\n}\n`)
  expect(renderMetadata(text, {explicitShards: ["b.json", "c.json"], x: 1})).toBe(`{\n  "explicitShards": ["b.json", "c.json"],\n  "x": 1\n}\n`)
  // A reorder cannot be expressed as in-place edits, so the list is rewritten.
  expect(JSON.parse(renderMetadata(text, {explicitShards: ["c.json", "a.json"], x: 1})).explicitShards).toEqual(["c.json", "a.json"])
})
