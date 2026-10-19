# Personal Fork Release

The independent personal fork release channel is specified in `FORK.md`. Manual publication pins the reviewed fork tip; scheduled publication accepts a checked refresh candidate. Both require CLI package checks plus all standalone and desktop build jobs before publication. Platform downloads are manual-install fork builds, with upstream desktop updates disabled; their signatures are not upstream release signatures.

## Personal fork nightlies

The `gkze/opencodex` fork uses the durable patch coordinator below for daily refresh onto upstream `dev`. The prior `.github/workflows/fork-nightly.md` and generated lock workflow remain manual-only. `scripts/fork/nightly.mjs` owns guarded promotion and legacy candidate acceptance. `.github/workflows/fork-nightly-publish.yml` independently checks and builds it, runs the complete test membership in four bounded fresh-process shards, smoke-tests the package on Linux, macOS and Windows, and publishes `@gkze/opencodex` to GitHub Packages plus a GitHub prerelease. Promotion of `gkze/patches` uses an exact-old-tip lease and backup tag. Upstream release authority remains `scripts/release.ts`; this fork channel never publishes the upstream npm package. After verified release and package publication, `scripts/fork/retention.mjs` keeps five public fork nightly releases with a verified publication-completion marker and deletes only older matching release entries and assets; stable releases, drafts, unrelated prereleases, unmarked publications, Git tags and package versions remain. A cleanup failure does not roll back publication. See `FORK.md` for operations and recovery.

## Durable patch orchestration

The scheduled and manually dispatched `.github/workflows/fork-stack-refresh.yml` runs Bun and
Effect Workflow with a SQLite database local to that Actions job. It captures
upstream `dev`, the control revision, and every branch in
`scripts/fork/orchestrator/registry.json`. Dedicated patch branches contain one
squashed own commit, with `Patch-Id` and `Patch-Base` trailers checked before
replay; dependency commits precede that own commit. Additional edits must be
squashed into the patch tip before maintenance can consume them.

Workers execute `.github/workflows/fork-patch-worker.yml` from the captured
control revision. Replay reconciles keyed metadata and regenerates the structure
index from its authority. README translation hashes are recomputed from the merged
English README only when all three input manifests are synchronized and the English
and localized READMEs merge cleanly as regular files. Other manifest fields still
use conflict-rejecting semantic merging. Workers run README parity checks whenever
the patch changes README files. This deterministic reconciliation also runs during
coordinator verification and stack assembly, including for sensitive patches.
Ordinary textual conflicts permit one bounded Copilot
SDK repair using only allowlisted read/write file tools. Sensitive patch conflicts,
metadata conflicts, and failed validation stop the run for review. GUI and Swift
checks have explicit execution paths; unsupported checks fail rather than skip.
Inference credentials are present only in preparation; validation runs in a
separate step without those credentials. Workers have no fork-push credentials.

The coordinator independently checks source, dependency trees and unchanged
replay results. Adapted results must remain within the original patch file set
and cannot change workflow, fork tooling or dependency controls. Temporary refs
make verified dependency objects available to later workers, with one sequential writer. They are not
maintained source branches. Combined checks remain in the existing publisher.
Promotion updates all maintained patch refs and the fork ref atomically, with
expected old tips and recovery tags, only after all publication gates pass.

`scripts/fork/orchestrator/limits.json` separates documented platform constraints,
account assumptions with provenance, and operating budgets. Unknown account plan
or usage is not represented as verified. Worker admission bounds this run;
other account repositories can still cause queueing. Paid runner classes are
excluded. API exhaustion and ambiguous dispatch halt rather than retrying writes.
SQLite is a run-local journal that survives a process restart on the same runner, not runner loss; no automatic restart is configured. Fresh runs
capture fresh inputs. Cancellation attempts to stop child workflows, whose own
timeouts bound work if parent cleanup cannot run. No database survives the run.

Dependency-ready workers replenish slots immediately using Effect semaphores.
Dependency bases preserve accepted commits, merging independent parents in declared
order and rejecting merge conflicts. The integrated fork still cherry-picks only
own patch commits into a linear stack. Refresh and publication share a concurrency
group. Parsed workflow conformance checks bind job durations, matrix fanout and
artifact retention to the policy. Repository artifact inventory is an advisory
snapshot checked against explicit operating budgets, not an account reservation.
Publication input sizes are checked again before promotion; retained account-wide
storage and other repositories' activity remain unknown.
