import { applyEdits, modify } from "jsonc-parser"
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
  throw new Error(`Conflicting metadata: ${path}`)
}

/** Preserve the compact flat test registry while changing only semantic keys. */
export const renderMetadata = (text: string, value: unknown): string => {
  const before: Record<string, unknown> = JSON.parse(text)
  const after = value as Record<string, unknown>
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!isDeepStrictEqual(before[key], after[key])) text = applyEdits(text, modify(text, [key], after[key], {}))
  }
  return text.endsWith("\n") ? text : text + "\n"
}
