import { assetTargets, assetContract } from './asset-contract.mjs';
import { verifyAssets } from './verify-assets.mjs';
import { assertForkRemote } from "./remote.mjs";
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';

assertForkRemote();
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
const inventory = Object.entries(assetTargets).flatMap(([kind, targets]) => targets.map(target => ({
  target, ...assetContract(kind, target, manifest.version, manifest.source),
})));
const platformAssets = verifyAssets(process.argv[3], manifest, inventory);
for (const asset of platformAssets) {
  const destination = path.join(directory, asset.name);
  assert.ok(!existsSync(destination), `Artifact would overwrite publication input: ${asset.name}`);
  copyFileSync(asset.path, destination);
}
const releaseNames = [manifest.file, 'manifest.json', ...platformAssets.map(asset => asset.name)];
const checksums = releaseNames.map(name => `${createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex')}  ${name}`).join('\n') + '\n';
writeFileSync(path.join(directory, 'SHA256SUMS'), checksums);
releaseNames.push('SHA256SUMS');
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

const release = spawnSync('gh', ['release', 'view', manifest.tag, '--repo', 'gkze/opencodex', '--json', 'isDraft'], { encoding: 'utf8' });
if (release.status !== 0) execFileSync('gh', ['release', 'create', manifest.tag, '--repo', 'gkze/opencodex', '--verify-tag', '--draft', '--prerelease', '--title', `OpenCodex ${manifest.version}`, '--notes', `CLI package, five standalone builds, and desktop bundles. Source: ${manifest.source}. Manual installation only; upstream self-update is disabled. macOS is ad-hoc signed without notarization; Windows is unsigned. These are personal builds, not official signed releases.`], { stdio: 'inherit' });
const alreadyVisible = release.status === 0 && !JSON.parse(release.stdout).isDraft;
if (!alreadyVisible) {
  execFileSync('gh', ['release', 'upload', manifest.tag, ...releaseNames.map(name => path.join(directory, name)), '--clobber', '--repo', 'gkze/opencodex'], { stdio: 'inherit' });
}
// Verify every asset's server-computed digest before making a draft visible or
// moving the consumer tag. A retry of a visible release never replaces its bytes.
// The tag endpoint only resolves published releases; address drafts by identity.
const identity = JSON.parse(execFileSync('gh', ['release', 'view', manifest.tag, '--repo', 'gkze/opencodex', '--json', 'databaseId'], { encoding: 'utf8' }));
assert.ok(Number.isSafeInteger(identity.databaseId) && identity.databaseId > 0);
const published = JSON.parse(execFileSync('gh', ['api', `repos/gkze/opencodex/releases/${identity.databaseId}`], { encoding: 'utf8' }));
assert.equal(published.tag_name, manifest.tag);
assert.deepEqual(published.assets.map(asset => asset.name).sort(), [...releaseNames].sort(), 'Published release asset inventory differs');
for (const name of releaseNames) {
  const asset = published.assets.find(item => item.name === name);
  const expected = `sha256-${createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex')}`;
  assert.equal(asset.digest?.replace('sha256:', 'sha256-'), expected, `Published asset digest differs: ${name}`);
}
if (!alreadyVisible) execFileSync('gh', ['release', 'edit', manifest.tag, '--draft=false', '--prerelease', '--repo', 'gkze/opencodex'], { stdio: 'inherit' });
const visible = JSON.parse(execFileSync('gh', ['release', 'view', manifest.tag, '--repo', 'gkze/opencodex', '--json', 'isDraft'], { encoding: 'utf8' }));
assert.equal(visible.isDraft, false);
execFileSync('npm', ['dist-tag', 'add', target, 'nightly', '--registry', registry], { stdio: 'inherit' });
assert.equal(execFileSync('npm', ['view', `${pkg.name}@nightly`, 'version', '--registry', registry], { encoding: 'utf8' }).trim(), manifest.version);
