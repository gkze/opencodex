import { lstatSync, readdirSync } from "node:fs"
import { join } from "node:path"
import configuration from "./limits.json"

/** Runs before upload without installing orchestrator dependencies in build jobs. */
export const outputBytes = (path: string): number => {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error("Artifact output cannot contain symlinks")
  if (stat.isDirectory()) return readdirSync(path).reduce((n, entry) => n + outputBytes(join(path, entry)), 0)
  if (!stat.isFile()) throw new Error("Artifact output must be regular files")
  return stat.size
}
export const checkOutput = (path: string, limit = configuration.policy.publicationArtifactMaxBytes) => {
  const bytes = outputBytes(path)
  return bytes
}
if (import.meta.main) console.log(JSON.stringify({bytes: checkOutput(process.argv[2])}))
