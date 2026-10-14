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
  git("config", "user.email", "test@example.invalid")
  git("config", "user.name", "Test")
  git("config", `url.${remote}.insteadOf`, "https://github.com/lidge-jun/opencodex.git")
  git("remote", "add", "origin", remote)
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
  const run = (command: string) =>
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
  expect(workflow.jobs.publish.needs).toEqual(["candidate", "validate", "smoke"])
  expect(workflow.jobs.publish.permissions).toEqual({ contents: "write", packages: "write" })
})
