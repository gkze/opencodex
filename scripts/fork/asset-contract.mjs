import assert from 'node:assert/strict';

// Build-only contract. The parent owns candidate acceptance and publication. Never
// put a generic manifest.json here: eight downloads are merged into one directory.
export const assetTargets = {
  standalone: ['bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-arm64', 'bun-darwin-x64', 'bun-windows-x64'],
  desktop: ['universal-apple-darwin', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu'],
};
const desktopSuffixes = {
  'universal-apple-darwin': ['macos.dmg', 'macos.app.tar.gz'],
  'x86_64-pc-windows-msvc': ['windows-x64.msi'],
  'x86_64-unknown-linux-gnu': ['linux-x86_64.AppImage', 'linux-amd64.deb'],
};
export function assetContract(kind, target, version, source) {
  assert.ok(assetTargets[kind]?.includes(target), 'Unsupported fork asset target');
  assert.match(source, /^[a-f0-9]{40}$/);
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-gkze\.nightly\.[1-9]\d*\.[1-9]\d*$/);
  assert.ok(version.length <= 128, 'Version exceeds installer metadata bound');
  const artifact = `fork-assets-${kind}-${target}`;
  const files = kind === 'standalone'
    ? [`ocx-${version}-${target}.${target.includes('windows') ? 'zip' : 'tar.gz'}`]
    : desktopSuffixes[target].map(suffix => `OpenCodex-${version}-${suffix}`);
  return { artifact, manifest: `assets-${target}.json`, files };
}

// Payload names only; every payload also has a <name>.sha256 sidecar.
export function expectedAssetNames(version) {
  return Object.entries(assetTargets).flatMap(([kind, targets]) =>
    targets.flatMap(target => assetContract(kind, target, version, '0'.repeat(40)).files));
}
