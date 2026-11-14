import { expect, test } from "bun:test";
import { isForkVersion } from "../../src/update/fork-policy.mjs";
import { checkForUpdate } from "../../src/update/job";
import { readUpdateBadge } from "../../src/update/badge";
import { decideOrchestratedApply, observeOrchestratedPlan, type OrchestratedPlanDeps } from "../../src/update/orchestrated-entry";

test("fork builds cannot consult or install the upstream update channel", () => {
  for (const installer of ["npm", "bun", "pnpm", "source"] as const) {
    const currentVersion = () => "2.84.0-gkze.nightly.123.1";
    const detectInstall = () => installer;
    const result = checkForUpdate("latest", {
      currentVersion, detectInstall,
      latestVersion: () => { throw new Error("upstream registry must not be read"); },
    });
    expect(result.canUpdate).toBe(false);
    expect(result.updateAvailable).toBe(false);
    expect(result.reason).toBe("fork_build");
    expect(result.releaseNotesUrl).toBe("https://github.com/gkze/opencodex/releases");
    expect(readUpdateBadge({ currentVersion, detectInstall,
      readCache: () => { throw new Error("upstream cache must not be read"); },
    }).canUpdate).toBe(false);
  }
});

test("upstream versions retain their own update policy", () => {
  expect(isForkVersion("2.84.0")).toBe(false);
  expect(isForkVersion("2.84.0-preview.1")).toBe(false);
  expect(isForkVersion("2.84.0-gkze.nightly.123.1")).toBe(true);
  const result = checkForUpdate("latest", {
    currentVersion: () => "2.84.0", detectInstall: () => "npm", latestVersion: () => "2.85.0",
  });
  expect(result.canUpdate).toBe(true);
});

test("fork builds refuse the orchestrated update plan and apply without reading the upstream registry", async () => {
  const live = { kind: "live" as const, servingRoot: "/fixture/ocx", runtime: { pid: 3, port: 10101, hostname: "127.0.0.1", command: ["/fixture/bun", "/fixture/ocx/src/cli/index.ts"] } };
  for (const installer of ["npm", "bun", "pnpm"] as const) {
    const deps: OrchestratedPlanDeps = {
      install: () => ({ installer, cliRoot: "/fixture/ocx", desktopPath: false }),
      currentVersion: () => "2.84.0-gkze.nightly.123.1",
      identity: async () => live,
      ownership: () => ({ runtimeOwner: "service", permits: true }),
      target: () => { throw new Error("upstream registry must not be read"); },
      inFlight: () => false,
    };
    for (const mode of ["plan", "apply"] as const) {
      const request = { ok: true as const, mode, tag: "latest" as const };
      const plan = await observeOrchestratedPlan(request, deps);
      expect(plan).toMatchObject({ canApply: false, reason: "fork-build", targetVersion: null,
        releaseNotesUrl: "https://github.com/gkze/opencodex/releases" });
      expect(decideOrchestratedApply(plan, request, Date.now())).toMatchObject({ kind: "done", exitCode: 10,
        result: { applied: false, error: "fork-build" } });
    }
  }
});
