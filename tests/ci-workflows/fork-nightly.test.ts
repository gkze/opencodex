import { expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { repoPath } from "../helpers/repo-root"

const script = repoPath("scripts/fork/nightly.mjs")

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "fork-nightly-"))
  const repo = path.join(root, "repo")
  const remote = path.join(root, "remote.git")
  mkdirSync(repo)
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init", "--bare", remote)
  git("init", "-b", "dev")
  git("config", "user.email", "test@example.test")
  git("config", "user.name", "Test")
  git("config", `url.${remote}.insteadOf`, "https://github.com/lidge-jun/opencodex.git")
  git("config", "--add", `url.${remote}.insteadOf`, "https://github.com/gkze/opencodex.git")
  git("remote", "add", "origin", "https://github.com/gkze/opencodex.git")
  writeFileSync(path.join(repo, "upstream"), "base")
  git("add", ".")
  git("commit", "-m", "base")
  git("checkout", "-b", "gkze/patches")
  writeFileSync(path.join(repo, "custom"), "feature")
  git("add", ".")
  git("commit", "-m", "custom")
  const old = git("rev-parse", "HEAD")
  git("checkout", "dev")
  writeFileSync(path.join(repo, "upstream"), "new upstream")
  git("commit", "-am", "upstream update")
  const upstream = git("rev-parse", "HEAD")
  git("push", "origin", "dev", "gkze/patches")
  git("checkout", "-b", "nightly-candidate")
  git("cherry-pick", old)
  const candidate = git("rev-parse", "HEAD")
  const data = path.join(root, "data")
  mkdirSync(data)
  writeFileSync(path.join(data, "input.json"), JSON.stringify({ old, upstream, commits: [old] }))
  const report = {
    summary: "Refresh",
    tests: ["fixture behavior checked"],
    patches: [{ old, action: "keep", commits: [candidate], reason: "custom feature absent upstream" }],
  }
  writeFileSync(path.join(data, "report.json"), JSON.stringify(report))
  git("bundle", "create", path.join(data, "candidate.bundle"), "refs/heads/nightly-candidate")
  const run = (command: string, extraEnv: Record<string, string> = {}) =>
    spawnSync(process.execPath, [script, command, data], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        SOURCE_SHA: old,
        GITHUB_RUN_ID: "123",
        GITHUB_OUTPUT: path.join(root, "output"),
        FORK_OLD: old,
        FORK_CANDIDATE: candidate,
        FORK_UPSTREAM: upstream,
        ...extraEnv,
      },
    })
  return { root, repo, data, git, run, old, candidate, report }
}

test("nightly preserves history, archives old tip, promotes and retries without rewriting", () => {
  const f = fixture()
  try {
    expect(f.run("accept").status).toBe(0)
    expect(f.run("promote").status).toBe(0)
    expect(f.git("ls-remote", "origin", "refs/heads/gkze/patches")).toStartWith(f.candidate)
    expect(f.git("ls-remote", "origin", `refs/tags/fork-backup-${f.old}`)).toStartWith(f.old)
    expect(f.run("promote").status).toBe(0)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test("nightly refuses to overwrite concurrent fork work", () => {
  const f = fixture()
  try {
    expect(f.run("accept").status).toBe(0)
    f.git("checkout", "gkze/patches")
    f.git("commit", "--allow-empty", "-m", "concurrent work")
    f.git("push", "origin", "gkze/patches")
    expect(f.run("promote").status).not.toBe(0)
    expect(f.git("ls-remote", "origin", "refs/heads/gkze/patches")).toStartWith(f.git("rev-parse", "HEAD"))
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test("nightly rejects an incomplete patch review", () => {
  const f = fixture()
  try {
    writeFileSync(path.join(f.data, "report.json"), JSON.stringify({ ...f.report, patches: [] }))
    expect(f.run("accept").status).not.toBe(0)
    expect(f.git("ls-remote", "origin", "refs/heads/gkze/patches")).toStartWith(f.old)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test("nightly refuses changed publication controls", () => {
  const f = fixture()
  try {
    mkdirSync(path.join(f.repo, ".github/workflows"), { recursive: true })
    writeFileSync(path.join(f.repo, ".github/workflows/unlisted.yml"), "changed")
    f.git("add", ".")
    f.git("commit", "-m", "change publisher")
    rmSync(path.join(f.data, "candidate.bundle"))
    f.git("bundle", "create", path.join(f.data, "candidate.bundle"), "refs/heads/nightly-candidate")
    expect(f.run("accept").status).not.toBe(0)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test("nightly rejects forged input provenance", () => {
  const f = fixture()
  try {
    writeFileSync(path.join(f.data, "input.json"), JSON.stringify({ old: f.candidate, upstream: f.candidate, commits: [] }))
    expect(f.run("accept").status).not.toBe(0)
    expect(f.git("ls-remote", "origin", "refs/heads/gkze/patches")).toStartWith(f.old)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test("publication requires checked artifacts and keeps candidate execution read-only", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(repoPath(".github/workflows/fork-nightly-publish.yml")).text()) as {
    permissions: Record<string, string>;
    on: { workflow_run: { workflows: string[]; types: string[] } };
    jobs: Record<string, { needs?: string[]; permissions?: Record<string, string>; if?: string }>;
  }
  expect(workflow.permissions).toEqual({ contents: "read" })
  expect(workflow.on.workflow_run).toEqual({ workflows: ["Fork nightly refresh"], types: ["completed"] })
  expect(workflow.jobs.candidate.if).toContain("head_repository.full_name == github.repository")
  expect(workflow.jobs.candidate.if).toContain("head_branch == 'gkze/patches'")
  expect(workflow.jobs.validate.permissions).toBeUndefined()
  expect(workflow.jobs.smoke.permissions).toBeUndefined()
  expect(workflow.jobs.publish.needs).toEqual(["candidate", "validate", "smoke", "assets"])
  expect(workflow.jobs.publish.permissions).toEqual({ contents: "write", packages: "write" })
})

test("nightly refuses an upstream publication remote", () => {
  const f = fixture()
  try {
    f.git("remote", "set-url", "origin", "https://github.com/lidge-jun/opencodex.git")
    expect(f.run("accept").status).not.toBe(0)
    expect(f.run("promote").status).not.toBe(0)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})


test("manual release requires the reviewed commit to be the current fork tip", () => {
  const f = fixture()
  try {
    f.git("checkout", "gkze/patches")
    const env = { EXPECTED_SHA: f.old, SOURCE_SHA: f.old }
    expect(f.run("manual", env).status).toBe(0)
    expect(f.run("manual", { ...env, EXPECTED_SHA: f.candidate }).status).not.toBe(0)
    f.git("commit", "--allow-empty", "-m", "new fork work")
    f.git("push", "origin", "gkze/patches")
    f.git("checkout", "--detach", f.old)
    expect(f.run("manual", env).status).not.toBe(0)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})


test("release assets reject missing builds, mixed source, and corrupt bytes", async () => {
  const { verifyAssets } = await import("../../scripts/fork/verify-assets.mjs")
  const { createHash } = await import("node:crypto")
  const root = mkdtempSync(path.join(os.tmpdir(), "fork-assets-"))
  const release = { version: "2.84.0-gkze.nightly.1.1", source: "a".repeat(40) }
  const inventory = [{ target: "platform-a", artifact: "build-a", files: ["platform-a.zip"] }, { target: "platform-b", artifact: "build-b", files: ["platform-b.tar.gz"] }]
  const metadata = (target: string, name: string, source = release.source) => ({
    ...release, source, target,
    files: [{ name, sha256: createHash("sha256").update("verified bytes").digest("hex") }],
  })
  try {
    for (const item of inventory) {
      const dir = path.join(root, item.artifact)
      mkdirSync(dir)
      writeFileSync(path.join(dir, item.files[0]!), "verified bytes")
      writeFileSync(path.join(dir, `${item.files[0]}.sha256`), `${createHash("sha256").update("verified bytes").digest("hex")}  ${item.files[0]}\n`)
      writeFileSync(path.join(root, item.artifact, `assets-${item.target}.json`), JSON.stringify(metadata(item.target, item.files[0]!)))
    }
    expect(verifyAssets(root, release, inventory)).toHaveLength(4)
    const replacement = path.join(root, "build-a", "replacement.tgz")
    writeFileSync(replacement, "unverified package")
    expect(() => verifyAssets(root, release, inventory)).toThrow("Unexpected files")
    rmSync(replacement)
    writeFileSync(path.join(root, "build-b", "assets-platform-b.json"), JSON.stringify(metadata("platform-b", "platform-b.tar.gz", "b".repeat(40))))
    expect(() => verifyAssets(root, release, inventory)).toThrow("Source mismatch")
    writeFileSync(path.join(root, "build-b", "assets-platform-b.json"), JSON.stringify(metadata("platform-b", "platform-b.tar.gz")))
    writeFileSync(path.join(root, "build-b", "platform-b.tar.gz"), "changed bytes")
    expect(() => verifyAssets(root, release, inventory)).toThrow("Corrupt asset")
    rmSync(path.join(root, "build-b", "assets-platform-b.json"))
    expect(() => verifyAssets(root, release, inventory)).toThrow()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
