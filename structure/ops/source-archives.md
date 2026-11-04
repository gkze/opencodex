# Source Archive Identity

## Fork source installation

`scripts/generate-compatibility-version.ts` hashes the Git index in a checkout and falls back to
source-archive files when the package root has no `.git`, which is the shape Bun's Git dependency
cache produces. Archive scanning rejects symlinks and omits its own generated manifest, so a missing
required file or corrupt checkout metadata fails preparation instead of silently producing a partial
identity.
