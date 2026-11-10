import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decideGitInstallPreparation } from "../../scripts/git-install-prepare";
import { repoPath } from "../helpers/repo-root";

const bunGitDependency =
  "/home/u/app/node_modules/.bun/@bitkyc08+opencodex@git+https+++github.com+gkze+opencodex+abc/node_modules/@bitkyc08/opencodex";

describe("Git install preparation predicate", () => {
  test("builds for a Bun Git dependency: no .git, inside node_modules", () => {
    expect(decideGitInstallPreparation({ packageRoot: bunGitDependency, hasGitDir: false, env: {} }).build).toBe(true);
    const globalWindows = "C:\\Users\\u\\.bun\\install\\global\\node_modules\\@bitkyc08\\opencodex";
    expect(decideGitInstallPreparation({ packageRoot: globalWindows, hasGitDir: false, env: {} }).build).toBe(true);
  });

  test("builds for npm Git dependency preparation with or without .git", () => {
    const env = { _PACOTE_NO_PREPARE_: "git+https://github.com/gkze/opencodex.git#abc" };
    for (const hasGitDir of [true, false]) {
      expect(decideGitInstallPreparation({ packageRoot: "/tmp/_cacache/tmp/git-cloneXyz", hasGitDir, env }).build)
        .toBe(true);
    }
  });

  test("skips a checkout, CI, the Docker build stage, and npm's pack of the prepared clone", () => {
    const cases = [
      { packageRoot: "/home/u/src/opencodex", hasGitDir: true, env: {} },
      { packageRoot: "/home/runner/work/opencodex/opencodex", hasGitDir: true, env: { CI: "true" } },
      { packageRoot: "/home/bun/app", hasGitDir: false, env: {} },
      { packageRoot: "/tmp/_cacache/tmp/git-cloneXyz", hasGitDir: true, env: { npm_package_resolved: "/tmp/x" } },
      { packageRoot: "/tmp/_cacache/tmp/git-cloneXyz", hasGitDir: false, env: { _PACOTE_NO_PREPARE_: "" } },
    ];
    for (const input of cases) expect(decideGitInstallPreparation(input).build).toBe(false);
  });

  test("the hook is wired to the predicate, and pack/publish builds the GUI exactly once", () => {
    const scripts = (JSON.parse(readFileSync(repoPath("package.json"), "utf8")) as { scripts: Record<string, string> })
      .scripts;
    expect(scripts.prepare).toBe("bun scripts/git-install-prepare.ts");
    expect(scripts.prepublishOnly).toContain("build:gui");
    expect(scripts.prepack).not.toContain("build:gui");
  });

  test("the Docker build stage has the hook script before its root bun install", () => {
    const build = readFileSync(repoPath("Dockerfile"), "utf8").split(" AS build")[1]!.split(" AS runtime")[0]!;
    const copy = build.indexOf("COPY --chown=bun:bun scripts/git-install-prepare.ts ./scripts/git-install-prepare.ts");
    expect(copy).toBeGreaterThan(-1);
    expect(copy).toBeLessThan(build.indexOf("RUN bun install --frozen-lockfile"));
    expect(readFileSync(repoPath(".dockerignore"), "utf8").split(/\r?\n/)).toContain("!scripts/git-install-prepare.ts");
  });
});
