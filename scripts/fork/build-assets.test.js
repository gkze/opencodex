import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assetTargets, assetContract, expectedAssetNames } from './asset-contract.mjs';
import { manualInstallConfig } from './build-assets.mjs';

const version = '2.84.0-gkze.nightly.123456.1';
const source = 'a'.repeat(40);
// Node owns the test runner; Bun supplies the repository's YAML parser and runs
// existing TypeScript helpers. Both runtimes are set up before this suite in CI.
const root = new URL('../../', import.meta.url);
const bunJson = code => JSON.parse(execFileSync('bun', ['-e', code], {
  cwd: root, encoding: 'utf8', timeout: 30_000,
}));
test('every workflow matrix entry agrees with the canonical eight-artifact inventory', () => {
  const workflow = bunJson("console.log(JSON.stringify(Bun.YAML.parse(await Bun.file('.github/workflows/fork-build-assets.yml').text())))");
  const entries = workflow.jobs.build.strategy.matrix.include;
  assert.deepEqual(entries.map(row => `${row.kind}/${row.target}`).sort(),
    Object.entries(assetTargets).flatMap(([kind, targets]) => targets.map(target => `${kind}/${target}`)).sort());
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.on), ['workflow_call']);
  assert.equal(workflow.jobs.build.steps[0].with['persist-credentials'], false);
  for (const step of workflow.jobs.build.steps) {
    if (step.uses && !step.uses.startsWith('./')) assert.match(step.uses, /@[a-f0-9]{40}$/);
  }
});
test('ten payloads and eight manifests merge without collisions', () => {
  const contracts = Object.entries(assetTargets).flatMap(([kind, targets]) => targets.map(target => assetContract(kind, target, version, source)));
  const payloads = expectedAssetNames(version);
  assert.equal(payloads.length, 10);
  assert.equal(new Set(payloads).size, 10);
  const all = contracts.flatMap(c => [c.manifest, ...c.files.flatMap(name => [name, `${name}.sha256`])]);
  assert.equal(new Set(all).size, 28);
  assert.ok(contracts.every(c => /^assets-[\w-]+\.json$/.test(c.manifest)));
  assert.deepEqual(payloads.filter(name => name.endsWith('.zip')), [`ocx-${version}-bun-windows-x64.zip`]);
  assert.ok(payloads.includes(`OpenCodex-${version}-macos.app.tar.gz`));
});
test('reject untrusted path, version, SHA, and unsupported target inputs', () => {
  for (const bad of ['2.84.0', '2.84.0-gkze.nightly.01.1', '2.84.0-gkze.nightly.1.1/../../x', version + '\n']) {
    assert.throws(() => assetContract('standalone', 'bun-linux-x64', bad, source));
  }
  for (const bad of ['main', 'a'.repeat(39), source + '\n']) assert.throws(() => assetContract('desktop', 'universal-apple-darwin', version, bad));
  assert.throws(() => assetContract('standalone', '../x', version, source));
  assert.throws(() => assetContract('constructor', 'x', version, source));
});
test('manual config removes upstream updater authority while preserving resources', () => {
  const original = JSON.parse(readFileSync(new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  for (const platform of ['darwin', 'win32', 'linux']) {
    const config = manualInstallConfig(original, platform);
    assert.equal(config.bundle.createUpdaterArtifacts, false);
    assert.deepEqual(config.plugins.updater, { endpoints: [], pubkey: '' });
    assert.deepEqual(config.bundle.resources, original.bundle.resources);
    assert.deepEqual(config.bundle.externalBin, original.bundle.externalBin);
    if (platform === 'darwin') assert.equal(config.bundle.macOS.signingIdentity, '-');
    if (platform === 'win32') assert.equal(config.bundle.windows.certificateThumbprint, null);
  }
  assert.equal(original.bundle.createUpdaterArtifacts, true);
  assert.ok(original.plugins.updater.endpoints.length > 0);
});

test('desktop inventory agrees with the upstream collector', () => {
  const bundlesByTarget = bunJson("import {bundlesByTarget} from './desktop/scripts/collect-release-assets.ts'; console.log(JSON.stringify(bundlesByTarget))");
  for (const target of assetTargets.desktop) {
    assert.deepEqual(assetContract('desktop', target, version, source).files,
      bundlesByTarget[target].map(bundle => `OpenCodex-${version}-${bundle.name}`));
  }
});

test('MSI version uses only the core, even with a large nightly run ID', () => {
  const result = bunJson(`
    import {windowsInstallerVersion} from './desktop/scripts/windows-installer-config.ts';
    const versions = ['2.84.0-gkze.nightly.999999999999.65536', '255.255.65535-gkze.nightly.999999999999.1'];
    const invalid = ['256.0.0-gkze.nightly.1.1', '1.256.0-gkze.nightly.1.1', '1.0.65536-gkze.nightly.1.1'];
    console.log(JSON.stringify({
      accepted: versions.map(windowsInstallerVersion),
      rejected: invalid.map(version => { try { windowsInstallerVersion(version); return false; } catch { return true; } }),
    }));
  `);
  assert.deepEqual(result.accepted, ['2.84.0', '255.255.65535']);
  assert.deepEqual(result.rejected, [true, true, true]);
});

// Retention shares the publication-control validation gate with the asset contract.
import { expiredNightlies, pruneNightlyReleases, recordNightlyPublication } from './retention.mjs';
const nightly = id => ({ id, tag_name: `fork-v2.87.0-gkze.nightly.${id}.1`,
  body: `<!-- opencodex-nightly-publication-complete:fork-v2.87.0-gkze.nightly.${id}.1 -->`,
  draft: false, prerelease: true, published_at: `2026-10-${String(id).padStart(2, '0')}T00:00:00Z` });
function retentionApi(initial, failDelete = false) {
  let releases = structuredClone(initial);
  const deleted = [];
  return { deleted, api(args) {
    const endpoint = args.at(-1);
    if (args.includes('--slurp')) return [releases.slice(0, 3), releases.slice(3)];
    const id = Number(endpoint.split('/').at(-1));
    assert.ok(endpoint.startsWith('repos/gkze/opencodex/releases/'));
    if (args[0] === '--method') {
      assert.equal(args[1], 'DELETE');
      if (failDelete) throw new Error('deletion failed');
      deleted.push(id);
      releases = releases.filter(r => r.id !== id);
      return null;
    }
    return releases.find(r => r.id === id);
  } };
}
test('retention keeps five newest nightlies and all other release classes', () => {
  const preserved = [{ ...nightly(10), draft: true }, { ...nightly(11), prerelease: false },
    { ...nightly(12), tag_name: 'v2.87.0-preview.1' }];
  const releases = [1, 7, 3, 5, 2, 4, 6].map(nightly).concat(preserved);
  const f = retentionApi(releases);
  assert.deepEqual(pruneNightlyReleases(nightly(7).tag_name, f.api), [nightly(2).tag_name, nightly(1).tag_name]);
  assert.deepEqual(f.deleted, [2, 1]);
  assert.deepEqual(pruneNightlyReleases(nightly(7).tag_name, f.api), []);
});
test('retention is a no-op below the limit and refuses a stale or unpublished release', () => {
  const f = retentionApi([1, 2, 3].map(nightly));
  assert.deepEqual(pruneNightlyReleases(nightly(3).tag_name, f.api), []);
  assert.throws(() => pruneNightlyReleases(nightly(2).tag_name, f.api), /newest/);
  assert.throws(() => pruneNightlyReleases(nightly(4).tag_name, f.api), /newest/);
  assert.deepEqual(f.deleted, []);
});
test('retention rejects malformed inventory before deleting anything', () => {
  for (const bad of [{ ...nightly(1), id: -1 }, { ...nightly(1), published_at: null }]) {
    const f = retentionApi([nightly(6), bad]);
    assert.throws(() => pruneNightlyReleases(nightly(6).tag_name, f.api));
    assert.deepEqual(f.deleted, []);
  }
});
test('retention rechecks release classification immediately before deletion', () => {
  const f = retentionApi([1, 2, 3, 4, 5, 6].map(nightly));
  const api = args => {
    const result = f.api(args);
    return args.length === 1 ? { ...result, prerelease: false } : result;
  };
  assert.throws(() => pruneNightlyReleases(nightly(6).tag_name, api));
  assert.deepEqual(f.deleted, []);
});
test('retention failure preserves the publication and detects unsuccessful deletion', () => {
  const releases = [1, 2, 3, 4, 5, 6].map(nightly);
  const failed = retentionApi(releases, true);
  assert.throws(() => pruneNightlyReleases(nightly(6).tag_name, failed.api), /deletion failed/);
  const f = retentionApi(releases);
  assert.throws(() => pruneNightlyReleases(nightly(6).tag_name,
    args => args[0] === '--method' ? null : f.api(args)), /did not persist/);
});
test('retention runs only after the published package nightly tag is read back', () => {
  const publisher = readFileSync(new URL('./publish.mjs', import.meta.url), 'utf8');
  assert.ok(publisher.lastIndexOf('pruneNightlyReleases(manifest.tag)') > publisher.indexOf("`${pkg.name}@nightly`"));
  assert.ok(publisher.indexOf("'--draft=false'") < publisher.indexOf("`${pkg.name}@nightly`"));
});
test('an interrupted public release does not consume a successful rollback slot', () => {
  const releases = [1, 2, 3, 4, 5, 7].map(nightly).concat({ ...nightly(6), body: 'Publication interrupted' });
  const f = retentionApi(releases);
  assert.deepEqual(pruneNightlyReleases(nightly(7).tag_name, f.api), [nightly(1).tag_name]);
  assert.deepEqual(f.deleted, [1]);
});
test('completion recording preserves notes, reads back its write and is idempotent', () => {
  let release = { ...nightly(7), body: 'Original notes' };
  let writes = 0;
  const api = args => {
    if (args[0] === '--method') {
      assert.equal(args[1], 'PATCH');
      assert.equal(args[2], 'repos/gkze/opencodex/releases/7');
      release.body = args.at(-1).slice('body='.length);
      writes++;
    }
    return { ...release };
  };
  recordNightlyPublication(7, release.tag_name, api);
  recordNightlyPublication(7, release.tag_name, api);
  assert.equal(writes, 1);
  assert.ok(release.body.startsWith('Original notes\n\n'));
  assert.deepEqual(expiredNightlies([release], release.tag_name), []);
  assert.throws(() => recordNightlyPublication(7, nightly(7).tag_name,
    () => ({ ...nightly(7), body: 'write ignored' })), /did not persist/);
});
