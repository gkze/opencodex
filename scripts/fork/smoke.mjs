import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  const directUpdate = execFileSync(runtime, [join(root, 'node_modules', '@gkze', 'opencodex', 'src', 'cli', 'index.ts'), 'update', '--json'], { env, encoding: 'utf8', timeout: 60_000 });
  assert.ok(directUpdate.includes('https://github.com/gkze/opencodex/releases'), directUpdate);
  console.log(`Verified installed fork ${manifest.version} and upstream-update refusal`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
