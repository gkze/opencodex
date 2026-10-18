# OpenCodex personal fork

`gkze/patches` is the maintained branch of `gkze/opencodex`. Its initial baseline
includes the committed `gkze/fork-work-on-dev` patches and the provider/catalog
changes staged on October 13, 2026. The original local checkout is not rewritten.
Upstream `dev`, `main`, and `preview` keep their upstream roles. This independent
fork channel does not publish to npmjs or use upstream release credentials.

## Nightly flow

The **Fork nightly refresh** workflow runs at 03:00 Pacific daily (`America/Los_Angeles`, including daylight-saving changes)
and can be dispatched manually on `gkze/patches`. GitHub may delay scheduled runs.
It captures upstream `lidge-jun/opencodex:dev` and the fork tip, then asks Copilot
to inspect each patch and keep, adapt, or drop it with concrete evidence. Clean
application is not evidence that a patch remains necessary. The agent cannot push
or publish. Conflicts in protected publication controls require manual repair.

**Publish fork nightly** accepts artifacts only from a successful same-repository
run on `gkze/patches`. It verifies lineage, linear history, complete patch mapping,
and unchanged fork publication controls before staging an immutable candidate.
Independent jobs run typecheck, the full test suite, privacy and structure checks,
and build the dashboard and CLI package. Linux, macOS and Windows jobs install
and execute that exact tarball and verify that upstream self-update is refused.
The write-capable publisher runs only trusted controls, never package scripts.

A successful publication creates:

- `@gkze/opencodex` on GitHub Packages with the `nightly` dist-tag;
- an immutable `fork-vX.Y.Z-gkze.nightly.RUN.ATTEMPT` tag and GitHub prerelease;
- the package tarball, all platform assets, SHA256SUMS, and source manifests attached to the release;
- a `fork-backup-OLD_SHA` tag before atomically advancing `gkze/patches` with an
  exact-old-tip lease. Concurrent fork work is never overwritten.

Version and package metadata are stamped only for the build. The maintained tree
keeps upstream metadata to avoid nightly version-bump commits in the patch stack.
The archive contains a built dashboard; install scripts do not rebuild it.
The same release also contains five standalone CLI builds (Linux x64/arm64,
macOS x64/arm64, Windows x64) and desktop bundles (universal macOS app and DMG,
Windows x64 MSI, Linux x64 AppImage and deb). Desktop builds are manual-install
fork builds: macOS is ad-hoc signed without notarization, Windows is unsigned,
and upstream desktop updater endpoints are disabled. Widget availability still
requires the platform's extension-signing requirements; an ad-hoc bundle does
not establish widget registration.

For an already reviewed fork tip, dispatch **Publish fork nightly** directly on
`gkze/patches` with its full `expected_sha`. The job refuses a moved tip, runs the
same validation/build gates, and publishes that exact commit without a rebase.
The scheduled refresh retains its semantic patch review and guarded promotion.

## Install and update

Download the `.tgz` and `SHA256SUMS` from the desired fork release, verify the
checksum, then use `npm install -g --allow-scripts=bun /absolute/path/to/the-package.tgz` or
`bun add -g /absolute/path/to/the-package.tgz`. These packages expose `ocx` and
`opencodex`, so choose deliberately which installed package owns those commands.
Run `ocx --version` to confirm the expected fork version.

GitHub Packages users can configure the `@gkze` scope for
`https://npm.pkg.github.com` and install `@gkze/opencodex@nightly` with their own
registry authentication. Never put tokens in tracked files.

Fork-version guards refuse upstream replacement through `ocx update` and the
dashboard. Update by explicitly installing a newer fork package. Existing config
and service ownership are unchanged; this setup does not install or restart a
local proxy.

## Setup and maintenance

The fork default branch must be `gkze/patches` for scheduling. Enable the two fork
workflows; inherited upstream workflows are not part of this release channel.
Repository secrets:

- `COPILOT_GITHUB_TOKEN`: Copilot CLI authentication for the read-only agent.
- `FORK_PUSH_TOKEN`: a credential with permission to update the fork's branch,
  including workflow files. Used only by deterministic acceptance/promotion.

The built-in GitHub token supplies release and package publication permissions.
Compile prompt changes with `gh aw compile fork-nightly --no-check-update` and
commit the Markdown, generated lock workflow, and action lock together. Review
workflow/control changes explicitly for secrets, permissions and artifact trust.

A failed validation leaves the maintained branch and public release untouched.
A publication can fail after uploading an immutable package or promoting the
branch: inspect the run, package version, branch, backup tag and release before
retrying. A retry never overwrites a mismatched published package or a newer
branch tip. Candidate staging branches and backup tags are retained for recovery;
cleanup is a separate deliberate operation. A manual rollback must use the
recorded backup SHA and account for newer fork work.

## Nightly release retention

After verifying all release assets and reading back the published package’s `nightly` tag, publication records and reads back a completion marker in the release notes, then retains the five newest marked public fork nightly prereleases. Unmarked historical or interrupted publications are preserved rather than assumed successful. Older matching GitHub release entries and their attached assets are deleted. Stable releases, drafts, unrelated prereleases, Git release tags, backup tags and package versions are preserved. Cleanup never runs merely because a rebase occurred or a build started. An older publication retry cannot prune a newer nightly. If cleanup fails, the verified publication remains available; retrying cleanup resumes from the remaining inventory.

## DeepSeek account authentication patch

The `fix(auth): support DeepSeek browser account authorization` stack entry adds
PKCE browser sign-in to `dsh-account`, preserving verified Harness import, strict
account identity, provider separation and local-only account removal. Its source
contract and implementation-source rationale live in
[`structure/providers/dsh-account.md`](structure/providers/dsh-account.md).
The entry is a normal linear commit above the maintained fork tip; the nightly
refresh inventories it from Git history, so there is no separate patch registry
to synchronize. Keep it until upstream supplies equivalent supported behavior.

Regression owners are `tests/oauth/dsh-browser.test.ts`,
`tests/oauth/dsh-login.test.ts`, `tests/providers/dsh-account.test.ts` and
`tests/adapters/dsh-account-adapter.test.ts`. The browser flow uses a temporary
loopback listener; remote browser use requires forwarding that port. Adding this
entry does not install or restart a proxy or publish a release.
