# OpenCodex personal fork

`gkze/patches` is the maintained branch of `gkze/opencodex`. Its initial baseline
includes the committed `gkze/fork-work-on-dev` patches and the provider/catalog
changes staged on October 13, 2026. The original local checkout is not rewritten.
Upstream `dev`, `main`, and `preview` keep their upstream roles. This independent
fork channel does not publish to npmjs or use upstream release credentials.

## Nightly flow

The **Fork stack refresh** workflow runs at 03:00 Pacific daily
(`America/Los_Angeles`, including daylight-saving changes), and supports manual
runs on `gkze/patches`. GitHub may delay scheduled runs. It captures upstream
`lidge-jun/opencodex:dev`, the fork tip, and the dedicated branches in
`scripts/fork/orchestrator/registry.json` once per run.

A Bun/Effect coordinator owns a SQLite workflow journal for that job only.
Dependency-ready workers continuously replenish bounded slots. Dependency branches
retain accepted parent commits; independent dependency tips compose through Git
merges, with conflicts held for review. The final fork remains linear. It
replays each logical patch on the captured upstream plus declared dependencies
in isolated GitHub Actions workers. Clean replay is deterministic. A text
conflict may receive a bounded Copilot SDK repair with restricted file tools that
cannot write the fork's controls. The agent sees each conflict hunk with upstream's
text, the base and the patch's text, resolves hunks by number, and is told what
remains before its session ends; each worker keeps a transcript of its tool calls
and replies as a `<attempt>-transcript` artifact for three days. A repaired non-sensitive patch ships once it
passes validation. A repaired sensitive patch never ships unreviewed: the rework
goes to `review/<patch-id>` and the patch is held. A patch whose worker fails,
whose result the coordinator rejects, or that is waiting for review is held: the
stack ships the revision the last accepted stack published, and the other patches
still refresh. When that revision does not replay either, a patch marked
`droppable` in `scripts/fork/orchestrator/registry.json`, together with every patch
that requires it, is left out of that night's build, which the release note and the
attention issue say; any other such patch fails the refresh, because patches like
the release channel carry the nightly itself. Patch retirement requires a reviewed registry change. The agent
cannot push or publish.

The fork's controls (`.github` and `scripts/fork`) live only on `gkze/patches`.
Patch branches do not carry copies. Workers validate each patch with those
controls laid over it. Each control change is its own commit on `gkze/patches`, with
no `Patch-Id` trailer and no paths outside those two roots, and the assembled stack
replays those commits after the patches, keeping their messages and boundaries.
Commit control changes directly to `gkze/patches`.

Workers validate their own patch. The coordinator verifies artifact digests,
provenance and reconstructed trees, then assembles the complete stack. Only the
existing publisher promotes maintained branches. Expected-tip leases update all
patch branches and `gkze/patches` atomically, preserving backup tags. SQLite is
not carried between workflow runs; interrupted runs start fresh from maintained
refs. There is no automatic process restart; the journal supports same-runner
recovery only. Account assumptions, platform ceilings and policy budgets are separate in
`scripts/fork/orchestrator/limits.json`; unobservable shared usage can still cause
throttling. Refresh and publication share one concurrency group. Workflow limits
and retention are checked against the policy before dispatch. Storage admission
uses retained repository artifacts plus a 2 GiB run budget against a 10 GiB
repository budget; these are operating budgets, not account entitlements. Shared
account usage remains unknown. Publication artifacts expire after three days;
GitHub release assets follow their separate retention policy. The prior **Fork nightly refresh** workflow is manual-only.

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
The scheduled refresh uses deterministic replay and bounded conflict repair.

## Watching the nightly

**Watch fork nightly** runs after every refresh and publication.

- It re-runs publication jobs that GitHub cancelled because no hosted runner
  picked them up, up to six attempts. This is mostly macOS when that pool is short.
- When promotion refuses because `gkze/patches` or a patch branch moved during
  the run, it starts a fresh refresh. The refusal keeps the pushed work, and the
  fresh run includes it.
- It keeps one issue, **Fork nightly needs attention**, up to date. The issue opens
  when a run failed for a reason a re-run cannot fix, or when a patch is held or
  dropped. It quotes the failure, lists each held or dropped patch with the reason
  from the last refresh,
  and gives the exact command to accept a proposed sensitive rework after review.
  It closes when the nightly is healthy again.

To accept a proposed rework, review `review/<patch-id>`, then push that commit to
the patch branch with the command in the issue. It is already one squashed commit
with verified trailers. The next refresh replays it as an unadapted patch.

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

The fork default branch must be `gkze/patches` for scheduling. Enable the coordinator, worker and publisher
workflows; inherited upstream workflows are not part of this release channel.
Repository secrets:

- `COPILOT_GITHUB_TOKEN`: Copilot SDK authentication for bounded patch repair.
- `FORK_PUSH_TOKEN`: a credential with permission to update the fork's branch,
  including workflow files. Used only by deterministic acceptance/promotion.

The built-in GitHub token supplies release and package publication permissions.
For the manual legacy workflow only, compile prompt changes with `gh aw compile fork-nightly --no-check-update` and
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
