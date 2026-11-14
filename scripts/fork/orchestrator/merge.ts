import { applyEdits, findNodeAtLocation, modify, parseTree } from "jsonc-parser"
import { isDeepStrictEqual } from "node:util"
/** Merge independently changed metadata by semantic key; conflicting values fail closed. */
export const merge = (base: unknown, current: unknown, patch: unknown, path = "root"): unknown => {
  if (isDeepStrictEqual(base, patch) || isDeepStrictEqual(current, patch)) return current
  if (isDeepStrictEqual(base, current)) return patch
  const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)
  if (object(base) && object(current) && object(patch)) {
    const result: Record<string, unknown> = {}
    for (const key of new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(patch)])) {
      const value = merge(base[key], current[key], patch[key], `${path}.${key}`)
      if (value !== undefined) result[key] = value
    }
    return result
  }
  if ([base, current, patch].every(x => Array.isArray(x) && x.every(v => object(v) && typeof v.path === "string"))) {
    const keyed = (x: unknown) => Object.fromEntries((x as Array<{path: string}>).map(v => [v.path, v]))
    return Object.values(merge(keyed(base), keyed(current), keyed(patch), path) as Record<string, unknown>)
  }
  // A list of plain values here (`explicitShards`, a manifest entry's `documents`) is a set: upstream
  // adding one shard while a patch adds another is two independent changes, not a conflict, as the
  // 2026-11-12 to 14 refreshes treated it. Keep upstream's order, drop what the patch removed, and
  // append what it added.
  const scalars = (x: unknown): x is unknown[] => Array.isArray(x) && x.every(v => v === null || typeof v !== "object")
  if (scalars(base) && scalars(current) && scalars(patch)) {
    const removed = base.filter(v => !patch.includes(v)), added = patch.filter(v => !base.includes(v) && !current.includes(v))
    return [...current.filter(v => !removed.includes(v)), ...added]
  }
  throw new Error(`Conflicting metadata: ${path}`)
}

type Json = unknown
type Segment = string | number
const plain = (x: Json): x is Record<string, Json> => !!x && typeof x === "object" && !Array.isArray(x)
const scalarArray = (x: Json): x is Array<string | number | boolean | null> => Array.isArray(x) && x.every(v => v === null || typeof v !== "object")
const keyedArray = (x: Json): x is Array<{path: string}> => Array.isArray(x) && x.every(v => plain(v) && typeof v.path === "string")
const formatting = {insertSpaces: true, tabSize: 2, eol: "\n"}

/** Rewrite `text` so it parses to `value`, editing only the paths whose values changed.
 *
 * Upstream hand-formats these files: `layout.json` keeps its registry on a few very long lines,
 * the structure manifest mixes compact and expanded arrays. Re-serializing the whole document
 * reflowed them, and the first patch to touch one carried thousands of lines of formatting churn
 * plus whatever order the merge produced. Order is upstream's: an entry this edit adds goes at the
 * end of its object or array, and nothing that already exists moves. */
export const renderMetadata = (text: string, value: Json): string => {
  // The formatter reflows whatever container it touches. It is used to lay out a structured value,
  // or where the container already holds one entry per line; otherwise a scalar goes in inline, so
  // a registry kept on a few long lines stays on them.
  const onePerLine = (path: Segment[]) => {
    const tree = parseTree(text)
    const children = (tree && findNodeAtLocation(tree, path.slice(0, -1)))?.children ?? []
    return children.length > 1 && children.every((child, i) => i === 0 || text.slice(children[i - 1].offset, child.offset).includes("\n"))
  }
  // jsonc-parser's own removal of an array's last element leaves its opening quote behind
  // (`["a", "b"]` becomes `["a""]`), so elements are cut out by their node offsets instead.
  const removeElement = (path: Segment[], index: number) => {
    const tree = parseTree(text)
    const items = (tree && findNodeAtLocation(tree, path))?.children ?? []
    const item = items[index]
    if (!item) throw new Error(`No array element ${index} at ${path.join(".")}`)
    const previous = items[index - 1], following = items[index + 1]
    const [start, end] = previous ? [previous.offset + previous.length, item.offset + item.length]
      : following ? [item.offset, following.offset] : [item.offset, item.offset + item.length]
    text = text.slice(0, start) + text.slice(end)
  }
  const edit = (path: Segment[], next: Json, options: {isArrayInsertion?: boolean} = {}) => {
    const format = (next !== null && typeof next === "object") || onePerLine(path)
    text = applyEdits(text, modify(text, path, next, {...(format ? {formattingOptions: formatting} : {}), ...options}))
  }
  const visit = (path: Segment[], before: Json, after: Json): void => {
    if (isDeepStrictEqual(before, after)) return
    if (plain(before) && plain(after)) {
      for (const key of Object.keys(before)) if (!(key in after)) edit([...path, key], undefined)
      for (const key of Object.keys(after)) key in before ? visit([...path, key], before[key], after[key]) : edit([...path, key], after[key])
      return
    }
    if (keyedArray(before) && keyedArray(after)) {
      // Entries are identities, so match by `path`, never by position.
      const wanted = new Map(after.map(entry => [entry.path, entry]))
      for (let i = before.length - 1; i >= 0; i--) if (!wanted.has(before[i].path)) removeElement(path, i)
      const kept = before.filter(entry => wanted.has(entry.path))
      kept.forEach((entry, i) => visit([...path, i], entry, wanted.get(entry.path)))
      const known = new Set(kept.map(entry => entry.path))
      let length = kept.length
      for (const entry of after) if (!known.has(entry.path)) edit([...path, length++], entry, {isArrayInsertion: true})
      return
    }
    if (scalarArray(before) && scalarArray(after)) {
      // A list such as `explicitShards` lives on one line; replacing it whole would expand it.
      // Removed elements are deleted in place and new ones appended, when that yields `after`.
      const kept = before.filter(value => after.includes(value))
      const added = after.filter(value => !before.includes(value))
      if (isDeepStrictEqual([...kept, ...added], after)) {
        for (let i = before.length - 1; i >= 0; i--) if (!after.includes(before[i])) removeElement(path, i)
        added.forEach((value, i) => edit([...path, kept.length + i], value, {isArrayInsertion: true}))
        return
      }
    }
    edit(path, after)
  }
  visit([], JSON.parse(text), value)
  return text.endsWith("\n") ? text : text + "\n"
}
