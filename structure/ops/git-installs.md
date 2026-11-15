# Git Installation Preparation

### Git installation preparation

The `prepare` lifecycle hook in `package.json` runs `scripts/git-install-prepare.ts`. Its pure
`decideGitInstallPreparation` predicate runs the existing `build:gui` (dashboard build plus package
preparation) only when the package is being installed as a Git dependency, and the install fails
when that build fails:

- npm prepares a Git dependency by running `npm install` in a temporary clone or extracted hosted
  tarball with `_PACOTE_NO_PREPARE_` set; that variable is the npm signal, whether or not the
  directory has `.git`. npm's later pack of the same directory runs `prepare` again without it and
  is skipped.
- Bun runs `prepare` for a trusted Git dependency inside its install tree, from a source archive
  without `.git`; no `.git` at the package root plus a `node_modules` path segment is the Bun signal.

Every other `prepare` run is a no-op: a development checkout, worktree or CI checkout has `.git`,
the Docker build stage has neither `.git` nor a `node_modules` ancestor (it copies the script before
`bun install` and builds the GUI in its own step), and pack/publish builds once through
`prepublishOnly`. No release or TypeScript transpilation is needed, and registry consumers retain the
prebuilt package path. Source-archive compatibility hashing is a prerequisite when the installed
source has no `.git` directory. `tests/ci-workflows/git-install-prepare.test.ts` covers the
predicate. See the installation guide for explicit script trust.
