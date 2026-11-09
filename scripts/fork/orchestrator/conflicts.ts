/** Git conflict hunks, as the repair agent sees and resolves them.
 *
 * Replay forces `merge.conflictStyle=diff3`, so a hunk carries the base the patch was written
 * against as well as both sides. The agent addresses a hunk by its index rather than by quoting
 * its text: in a long single-line paragraph the upstream and base sections are near-identical, so
 * a text match is rarely unique and a quoted-text edit cannot land. */
export interface Hunk {
  /** 1-based line of the `<<<<<<<` marker. */
  readonly line: number
  readonly ours: string
  readonly base: string | null
  readonly theirs: string
  /** Offsets of the whole hunk, markers included, in the file text. */
  readonly start: number
  readonly end: number
}

const open = /^<{7}( |$)/, ancestor = /^\|{7}( |$)/, divider = /^={7}$/, close = /^>{7}( |$)/

/** Every complete hunk in `text`. A marker line outside a well-formed hunk is reported as
 * malformed, because a half-deleted hunk is exactly what a failed repair leaves behind. */
export const conflictHunks = (text: string): {hunks: Hunk[], malformed: number[]} => {
  const hunks: Hunk[] = [], malformed: number[] = []
  const lines = text.split("\n")
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) { offsets.push(offset); offset += line.length + 1 }
  for (let i = 0; i < lines.length; i++) {
    if (!open.test(lines[i])) {
      if (ancestor.test(lines[i]) || divider.test(lines[i]) || close.test(lines[i])) malformed.push(i + 1)
      continue
    }
    let j = i + 1, baseAt = -1, dividerAt = -1
    for (; j < lines.length && !open.test(lines[j]) && !close.test(lines[j]); j++) {
      if (ancestor.test(lines[j]) && baseAt === -1 && dividerAt === -1) baseAt = j
      else if (divider.test(lines[j]) && dividerAt === -1) dividerAt = j
    }
    if (j >= lines.length || !close.test(lines[j]) || dividerAt === -1) { malformed.push(i + 1); continue }
    const section = (from: number, to: number) => lines.slice(from, to).join("\n")
    hunks.push({
      line: i + 1,
      ours: section(i + 1, baseAt === -1 ? dividerAt : baseAt),
      base: baseAt === -1 ? null : section(baseAt + 1, dividerAt),
      theirs: section(dividerAt + 1, j),
      start: offsets[i],
      end: j + 1 < lines.length ? offsets[j + 1] : text.length,
    })
    i = j
  }
  return {hunks, malformed}
}

/** Replace hunk `index` (1-based) with `resolution`, which must not itself contain markers. */
export const resolveHunk = (text: string, index: number, resolution: string): string => {
  const {hunks} = conflictHunks(text)
  const hunk = hunks[index - 1]
  if (!hunk) throw new Error(`No conflict hunk ${index}; the file has ${hunks.length}`)
  const check = conflictHunks(resolution)
  if (check.hunks.length || check.malformed.length) throw new Error("Resolution contains conflict markers")
  const body = resolution === "" || resolution.endsWith("\n") || hunk.end === text.length ? resolution : `${resolution}\n`
  return text.slice(0, hunk.start) + body + text.slice(hunk.end)
}

/** A bounded rendering of a file's hunks for the agent's prompt. */
export const describeHunks = (path: string, text: string, budget: number): string => {
  const {hunks, malformed} = conflictHunks(text)
  const parts = hunks.map((hunk, n) => [
    `### ${path} hunk ${n + 1} (line ${hunk.line})`,
    "Upstream now has (HEAD):", fence(hunk.ours),
    ...(hunk.base === null ? [] : ["Before either change (base):", fence(hunk.base)]),
    "The patch wants (theirs):", fence(hunk.theirs),
  ].join("\n"))
  if (malformed.length) parts.push(`### ${path}: stray marker lines at ${malformed.join(", ")}`)
  const rendered = parts.join("\n\n")
  return rendered.length <= budget ? rendered : `${rendered.slice(0, budget)}\n[truncated; read ${path} for the rest]`
}

const fence = (text: string) => {
  const ticks = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)))
  return `${ticks}\n${text}\n${ticks}`
}
