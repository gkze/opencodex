import { assertForkRemote } from "./remote.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"
import path from "node:path"

const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    // Only branch pushes need workflow-write access. Keep credentials out of argv
    // and leave release tag creation on the built-in token to avoid duplicate runs.
    env:
      args[0] === "push" && process.env.FORK_PUSH_TOKEN
        ? {
            ...process.env,
            GIT_CONFIG_COUNT: "2",
            GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
            GIT_CONFIG_VALUE_0: "",
            GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
            GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.FORK_PUSH_TOKEN}`).toString("base64")}`,
          }
        : process.env,
  }).trim()
const lines = (text) => (text ? text.split("\n") : [])
const read = (file) => JSON.parse(readFileSync(file, "utf8"))
const sha = (value) => {
  assert.match(value, /^[0-9a-f]{40}$/)
  return value
}
const controls = [
  ".github/workflows",
  ".github/actions",
  ".github/aw",
  "scripts/fork",
]
const branch = "refs/heads/gkze/patches"
const [command, directory] = process.argv.slice(2)

if (command === "prepare") {
  mkdirSync(directory, { recursive: true })
  git("fetch", "https://github.com/lidge-jun/opencodex.git", "dev")
  const upstream = git("rev-parse", "FETCH_HEAD")
  const old = git("rev-parse", "HEAD")
  const input = { old, upstream, commits: lines(git("rev-list", "--reverse", `${upstream}..${old}`)) }
  writeFileSync(path.join(directory, "input.json"), JSON.stringify(input, null, 2))
} else if (command === "manual") {
  assertForkRemote()
  const candidate = sha(process.env.SOURCE_SHA)
  assert.equal(candidate, sha(process.env.EXPECTED_SHA), "Dispatch commit differs from reviewed commit")
  assert.equal(git("rev-parse", "HEAD"), candidate)
  assert.equal(git("ls-remote", "origin", branch).split("\t")[0], candidate, "Fork advanced before dispatch")
  const upstream = git("merge-base", candidate, "origin/dev")
  appendFileSync(process.env.GITHUB_OUTPUT, `candidate=${candidate}\nold=${candidate}\nupstream=${upstream}\n`)
} else if (command === "accept") {
  assertForkRemote()
  const input = read(path.join(directory, "input.json"))
  assert.equal(sha(input.old), sha(process.env.SOURCE_SHA))
  git("fetch", "https://github.com/lidge-jun/opencodex.git", "dev")
  git("merge-base", "--is-ancestor", sha(input.upstream), "FETCH_HEAD")
  assert.deepEqual(input.commits, lines(git("rev-list", "--reverse", `${input.upstream}..${input.old}`)))
  git("bundle", "verify", path.join(directory, "candidate.bundle"))
  git("fetch", path.join(directory, "candidate.bundle"), "refs/heads/nightly-candidate")
  const candidate = git("rev-parse", "FETCH_HEAD")
  git("merge-base", "--is-ancestor", input.upstream, candidate)
  assert.equal(
    git("rev-list", "--merges", `${input.upstream}..${candidate}`),
    "",
    "Candidate must be a linear patch stack",
  )
  const base = git("merge-base", input.old, input.upstream)
  for (const file of lines(git("diff", "--name-only", input.old, candidate, "--", ...controls))) {
    // Carry upstream-only control changes, but never accept agent-authored workflows.
    assert.equal(git("diff", "--name-only", base, input.old, "--", file), "", `Fork control conflict: ${file}`)
    assert.equal(
      git("diff", "--name-only", input.upstream, candidate, "--", file),
      "",
      `Publication control changed: ${file}`,
    )
  }
  const report = read(path.join(directory, "report.json"))
  assert.ok(typeof report.summary === "string" && report.summary.trim())
  assert.ok(
    Array.isArray(report.tests) && report.tests.length && report.tests.every((x) => typeof x === "string" && x.trim()),
  )
  assert.ok(Array.isArray(report.patches))
  assert.deepEqual(
    report.patches.map((p) => p.old).sort(),
    [...input.commits].sort(),
    "Every old patch needs exactly one decision",
  )
  const mapped = report.patches.flatMap((p) => {
    assert.ok(["keep", "adapt", "drop"].includes(p.action))
    assert.ok(typeof p.reason === "string" && p.reason.trim())
    assert.ok(Array.isArray(p.commits))
    assert.equal(p.commits.length === 0, p.action === "drop")
    return p.commits.map(sha)
  })
  assert.deepEqual(
    [...new Set(mapped)].sort(),
    lines(git("rev-list", `${input.upstream}..${candidate}`)).sort(),
    "Every new commit needs provenance",
  )
  const staging = `refs/heads/nightly-${process.env.GITHUB_RUN_ID}`
  assert.match(staging, /^refs\/heads\/nightly-\d+$/)
  git("push", "origin", `${candidate}:${staging}`)
  appendFileSync(process.env.GITHUB_OUTPUT, `candidate=${candidate}\nold=${input.old}\nupstream=${input.upstream}\n`)
} else if (command === "promote") {
  assertForkRemote()
  const old = sha(process.env.FORK_OLD)
  const candidate = sha(process.env.FORK_CANDIDATE)
  const upstream = sha(process.env.FORK_UPSTREAM)
  git("fetch", "origin", candidate, old)
  git("merge-base", "--is-ancestor", upstream, candidate)
  const current = git("ls-remote", "origin", branch).split("\t")[0]
  // Retrying publication after a successful promotion must not overwrite newer work.
  if (current !== candidate) {
    assert.equal(current, old, "Fork advanced during this nightly; retry against the new tip")
    const archive = `refs/tags/fork-backup-${old}`
    git(
      "push",
      "--atomic",
      `--force-with-lease=${branch}:${old}`,
      "origin",
      `${old}:${archive}`,
      `${candidate}:${branch}`,
    )
  }
  assert.equal(git("ls-remote", "origin", branch).split("\t")[0], candidate)
} else {
  throw new Error("Usage: nightly.mjs prepare|accept <directory>, or promote")
}
