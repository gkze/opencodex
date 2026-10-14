import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const directory = process.argv[2];
assert.ok(directory, 'Usage: publish.mjs <artifacts>');
const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
assert.match(manifest.version, /^\d+\.\d+\.\d+-gkze\.nightly\.\d+\.\d+$/);
assert.equal(manifest.source, process.env.FORK_CANDIDATE);
assert.match(manifest.source, /^[a-f0-9]{40}$/);
assert.equal(manifest.tag, `fork-v${manifest.version}`);
const files = readdirSync(directory).filter(x => x.endsWith('.tgz'));
assert.deepEqual(files, [manifest.file]);
assert.equal(path.basename(manifest.file), manifest.file);
const file = path.join(directory, manifest.file);
const pkg = JSON.parse(execFileSync('tar', ['-xOf', file, 'package/package.json'], { encoding: 'utf8' }));
assert.equal(pkg.name, '@gkze/opencodex');
assert.equal(pkg.version, manifest.version);
assert.deepEqual(pkg.publishConfig, { registry: 'https://npm.pkg.github.com' });
const target = `${pkg.name}@${pkg.version}`;
const registry = 'https://npm.pkg.github.com';
const existing = spawnSync('npm', ['view', target, 'dist.integrity', '--json', '--registry', registry], { encoding: 'utf8' });
const integrity = `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;
if (existing.status === 0) {
  assert.equal(JSON.parse(existing.stdout), integrity, 'Existing package bytes differ');
} else {
  assert.equal(JSON.parse(existing.stdout).error?.code, 'E404', 'Cannot inspect package');
  execFileSync('npm', ['publish', file, '--registry', registry, '--tag', 'candidate', '--access', 'public', '--ignore-scripts'], { stdio: 'inherit' });
}
// Publication is recoverable: immutable package first, then guarded promotion,
// then release visibility, and finally the consumer dist-tag.
execFileSync('node', ['scripts/fork/nightly.mjs', 'promote'], { stdio: 'inherit' });
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const remoteTag = git('ls-remote', 'origin', `refs/tags/${manifest.tag}`).split('\t')[0];
if (remoteTag) assert.equal(remoteTag, manifest.source, 'Release tag points at other source');
else git('push', 'origin', `${manifest.source}:refs/tags/${manifest.tag}`);
writeFileSync(path.join(directory, 'SHA256SUMS'), `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${manifest.file}\n`);
const release = spawnSync('gh', ['release', 'view', manifest.tag, '--repo', 'gkze/opencodex', '--json', 'isDraft'], { encoding: 'utf8' });
if (release.status !== 0) execFileSync('gh', ['release', 'create', manifest.tag, '--repo', 'gkze/opencodex', '--verify-tag', '--draft', '--prerelease', '--title', `OpenCodex Fork ${manifest.version}`, '--notes', `Nightly CLI package. Source: ${manifest.source}. Replace explicitly from this fork; upstream self-update is disabled.`], { stdio: 'inherit' });
else if (!JSON.parse(release.stdout).isDraft) {
  // Never replace the bytes of an already-visible release.
  execFileSync('npm', ['dist-tag', 'add', target, 'nightly', '--registry', registry], { stdio: 'inherit' });
  process.exit(0);
}
execFileSync('gh', ['release', 'upload', manifest.tag, file, path.join(directory, 'SHA256SUMS'), path.join(directory, 'manifest.json'), '--clobber', '--repo', 'gkze/opencodex'], { stdio: 'inherit' });
execFileSync('gh', ['release', 'edit', manifest.tag, '--draft=false', '--prerelease', '--repo', 'gkze/opencodex'], { stdio: 'inherit' });
execFileSync('npm', ['dist-tag', 'add', target, 'nightly', '--registry', registry], { stdio: 'inherit' });
assert.equal(execFileSync('npm', ['view', `${pkg.name}@nightly`, 'version', '--registry', registry], { encoding: 'utf8' }).trim(), manifest.version);
