import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Structural merge driver for the replay path. Upstream rewrites that only touch the inside of a
 * function are the common conflict shape, and a syntax-aware merge resolves them deterministically
 * where a line-based merge leaves markers for the repair agent to guess at. The tarball is pinned
 * by digest because the driver decides what the published tree contains.
 */
export const mergiraf = {
  version: "0.20.0",
  url: "https://codeberg.org/mergiraf/mergiraf/releases/download/v0.20.0/mergiraf_x86_64-unknown-linux-gnu.tar.gz",
  bytes: 7_472_707,
  sha256: "4341127da8d1da29eced669fbacc1e5d6e530115098de0b82cc9dc551a1acf37",
} as const

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** Downloads, verifies and unpacks the pinned driver; returns the binary path. */
export const installMergeDriver = async (directory: string): Promise<string> => {
  const response = await fetch(mergiraf.url)
  if (!response.ok) throw new Error(`Mergiraf download failed: HTTP ${response.status}`)
  const archive = new Uint8Array(await response.arrayBuffer())
  if (archive.byteLength !== mergiraf.bytes) throw new Error(`Mergiraf archive is ${archive.byteLength} bytes, expected ${mergiraf.bytes}`)
  if (digest(archive) !== mergiraf.sha256) throw new Error("Mergiraf archive digest does not match the pin")
  mkdirSync(directory, { recursive: true })
  const tar = join(directory, "mergiraf.tar.gz")
  writeFileSync(tar, archive)
  execFileSync("tar", ["-xzf", tar, "-C", directory], { stdio: "inherit" })
  const binary = join(directory, "mergiraf")
  chmodSync(binary, 0o755)
  const reported = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim()
  if (reported !== `mergiraf ${mergiraf.version}`) throw new Error(`Mergiraf reports "${reported}", expected ${mergiraf.version}`)
  return binary
}

/**
 * Registers the driver on one repository. Worktrees share this config, so a single call covers
 * every replay in that checkout. The attributes file matches the driver to every path: mergiraf
 * falls back to an ordinary merge for a language it does not parse.
 */
export const configureMergeDriver = (cwd: string, binary: string): void => {
  if (!binary) throw new Error("MERGIRAF_BIN is not set; the replay would silently fall back to line merging")
  // Lives in the shared git dir so linked worktrees see it and the binary stays untouched.
  const attributes = join(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" }).trim(), "mergiraf.attributes")
  writeFileSync(attributes, "* merge=mergiraf\n")
  execFileSync("git", ["config", "merge.mergiraf.name", "mergiraf"], { cwd })
  execFileSync("git", ["config", "merge.mergiraf.driver", `${binary} merge --git %O %A %B -s %S -x %X -y %Y -p %P -l %L`], { cwd })
  execFileSync("git", ["config", "core.attributesFile", attributes], { cwd })
  assertMergeDriver(cwd)
}

/**
 * Both ends of the pipeline replay the same patch and compare trees, so a mismatch here would read
 * as a semantic difference rather than a missing driver. Fail before any replay starts.
 */
export const assertMergeDriver = (cwd: string): void => {
  const read = (key: string) => execFileSync("git", ["config", "--get", key], { cwd, encoding: "utf8" }).trim()
  const driver = read("merge.mergiraf.driver")
  const attributes = read("core.attributesFile")
  const mapped = readFileSync(attributes, "utf8").split("\n").some(line => line.trim() === "* merge=mergiraf")
  if (!driver.includes("mergiraf merge --git") || !mapped) throw new Error(`Structural merge driver is not active in ${cwd}`)
}

if (import.meta.main) {
  const [command, directory] = process.argv.slice(2)
  if (command !== "install" || !directory) throw new Error("Usage: merge-driver.ts install <directory>")
  console.log(await installMergeDriver(directory))
}
