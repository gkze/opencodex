import { expect, test } from "bun:test";
import { isForkVersion } from "../../src/update/fork-policy.mjs";
import { checkForUpdate } from "../../src/update/job";
import { readUpdateBadge } from "../../src/update/badge";

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
