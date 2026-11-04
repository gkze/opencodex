import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
const directory = resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
assert.match(manifest.file, /^gkze-opencodex-[a-zA-Z0-9.-]+\.tgz$/);
const root = mkdtempSync(join(tmpdir(), 'ocx-fork-smoke-'));
// npm's .cmd shim is not executable through execFile on Windows. Invoke npm's
// actual JS entrypoint there; no artifact-controlled string enters a shell.
const npm = process.platform === 'win32'
  ? [process.execPath, [join(process.execPath, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js')]]
  : ['npm', []];
try {
  execFileSync(npm[0], [...npm[1], 'install', '--ignore-scripts', '--prefix', root, '--no-audit', '--no-fund', join(directory, manifest.file)], { stdio: 'inherit', timeout: 600_000 });
  const launcher = join(root, 'node_modules', '@gkze', 'opencodex', 'bin', 'ocx.mjs');
  const bunPackage = dirname(createRequire(launcher).resolve('bun/package.json'));
  // Run only the declared Bun installer, independent of host npm lifecycle policy.
  execFileSync(process.execPath, [join(bunPackage, 'install.js')], { stdio: 'inherit', timeout: 120_000 });
  const runtime = join(bunPackage, 'bin', 'bun.exe');
  execFileSync(runtime, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  const env = { ...process.env, OPENCODEX_BUN_PATH: runtime, OPENCODEX_HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex'), OCX_NO_DESKTOP_HANDOFF: '1' };
  const version = execFileSync(process.execPath, [launcher, '--version'], { env, encoding: 'utf8', timeout: 60_000 });
  assert.ok(version.includes(manifest.version), version);
  const update = execFileSync(process.execPath, [launcher, 'update'], { env, encoding: 'utf8', timeout: 60_000 });
  assert.ok(update.includes('https://github.com/gkze/opencodex/releases'), update);
  // The machine-readable update path is `update (--plan | --yes) --json`. A fork build must plan
  // nothing from the upstream registry and refuse to apply, pointing at the fork release channel.
  const cli = join(root, 'node_modules', '@gkze', 'opencodex', 'src', 'cli', 'index.ts');
  const plan = JSON.parse(execFileSync(runtime, [cli, 'update', '--plan', '--json'], { env, encoding: 'utf8', timeout: 60_000 }));
  assert.equal(plan.canApply, false, JSON.stringify(plan));
  assert.equal(plan.reason, 'fork-build', JSON.stringify(plan));
  assert.equal(plan.targetVersion, null, JSON.stringify(plan));
  assert.equal(plan.releaseNotesUrl, 'https://github.com/gkze/opencodex/releases', JSON.stringify(plan));
  const apply = spawnSync(runtime, [cli, 'update', '--yes', '--json'], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(apply.status, 10, `${apply.stdout}${apply.stderr}`);
  const applied = JSON.parse(apply.stdout);
  assert.equal(applied.applied, false, apply.stdout);
  assert.equal(applied.error, 'fork-build', apply.stdout);
  console.log(`Verified installed fork ${manifest.version} and upstream-update refusal`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
