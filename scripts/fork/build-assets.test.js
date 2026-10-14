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
