/**
 * `prepare` lifecycle entry point. It builds the packaged dashboard (and, through `build:gui`,
 * the package metadata) only when this package is being installed as a Git dependency. Every other
 * `prepare` run is a no-op: a development checkout, CI and the Docker image build the GUI on their
 * own schedule, and `prepublishOnly` already builds it once for pack/publish.
 *
 * Signals, checked against Bun 1.4 and npm 12 (pacote):
 * - npm prepares a Git dependency by running `npm install` in a temporary clone or an extracted
 *   hosted tarball, with `_PACOTE_NO_PREPARE_` set to the Git specs being prepared. That directory
 *   may or may not contain `.git`, so the variable is the signal. npm then packs the directory and
 *   runs `prepare` once more without the variable; that second run is skipped.
 * - Bun runs `prepare` for a trusted Git dependency inside its install tree
 *   (`node_modules/.bun/<name>@git+.../node_modules/<name>`), from a source archive without `.git`
 *   (the same signal `generate-compatibility-version.ts` uses). A checkout or worktree has `.git`;
 *   the Docker build stage has neither `.git` nor a `node_modules` ancestor.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface GitInstallPreparationInput {
  readonly packageRoot: string;
  readonly hasGitDir: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface GitInstallPreparationDecision {
  readonly build: boolean;
  readonly reason: string;
}

export function decideGitInstallPreparation(input: GitInstallPreparationInput): GitInstallPreparationDecision {
  if (input.env._PACOTE_NO_PREPARE_) {
    return { build: true, reason: "npm is preparing this package as a Git dependency" };
  }
  if (input.hasGitDir) {
    return { build: false, reason: "package root is a Git checkout, not a Git dependency install" };
  }
  if (input.packageRoot.split(/[\\/]/).includes("node_modules")) {
    return { build: true, reason: "Bun is preparing this package as a Git dependency" };
  }
  return { build: false, reason: "package root is neither a Git checkout nor inside node_modules" };
}

if (import.meta.main) {
  const packageRoot = resolve(import.meta.dir, "..");
  const decision = decideGitInstallPreparation({
    packageRoot,
    hasGitDir: existsSync(join(packageRoot, ".git")),
    env: process.env,
  });
  if (!decision.build) {
    console.log(`[prepare] skipped: ${decision.reason}`);
    process.exit(0);
  }
  console.log(`[prepare] building dashboard: ${decision.reason}`);
  const result = Bun.spawnSync([process.execPath, "run", "build:gui"], {
    cwd: packageRoot,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (result.exitCode !== 0) {
    console.error(
      `[prepare] dashboard build failed (exit ${result.exitCode ?? "signal"}). The Git install needs Bun on PATH `
      + "and network access for the dashboard's dependencies; fix the error above and reinstall, "
      + "or install the published npm package instead.",
    );
    process.exit(result.exitCode ?? 1);
  }
}
