import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { assetContract } from './asset-contract.mjs';

export function manualInstallConfig(config, platform) {
  const result = structuredClone(config);
  result.bundle.createUpdaterArtifacts = false;
  // An empty array replaces the upstream endpoint list; deleting the property in
  // a merge override would leave the original endpoint active.
  result.plugins.updater.endpoints = [];
  result.plugins.updater.pubkey = '';
  if (platform === 'darwin') result.bundle.macOS.signingIdentity = '-';
  if (platform === 'win32') {
    result.bundle.windows.certificateThumbprint = null;
    result.bundle.windows.signCommand = null;
  }
  return result;
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const run = (command, args, options = {}) => execFileSync(command, args, {
  cwd: root, stdio: 'inherit', timeout: 40 * 60_000, ...options,
});
const bun = (...args) => run('bun', args);
const atomicJson = (file, value) => {
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
};
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');

// Exercise the exact extracted executable with no real user config or keychain
// operations. The keyring probe loads the addon only. HTTP smoke checks both the
// runtime identity and packaged GUI (including its first JS asset).
export async function smokeRuntime(binary, version) {
  const scratch = mkdtempSync(join(tmpdir(), 'ocx-fork-runtime-'));
  const env = { ...process.env, HOME: scratch, USERPROFILE: scratch,
    XDG_CONFIG_HOME: join(scratch, 'config'), XDG_DATA_HOME: join(scratch, 'data'),
    OPENCODEX_HOME: join(scratch, 'ocx'), CODEX_HOME: join(scratch, 'codex'),
    OCX_NO_DESKTOP_HANDOFF: '1', CI: 'true' };
  let child;
  let stopped;
  try {
    const output = run(binary, ['--version'], { cwd: scratch, env, encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
    assert.ok(output.includes(version), 'Executable version mismatch');
    const keyring = JSON.parse(run(binary, ['__keyring-load-check'], { cwd: scratch, env, encoding: 'utf8', stdio: 'pipe', timeout: 30_000 }));
    assert.deepEqual(keyring, { schema: 'ocx-keyring-load/1', available: true });
    const reservation = createServer();
    await new Promise((ok, fail) => { reservation.once('error', fail); reservation.listen(0, '127.0.0.1', ok); });
    const port = reservation.address().port;
    await new Promise((ok, fail) => reservation.close(error => error ? fail(error) : ok()));
    child = spawn(binary, ['start', '--port', String(port)], { cwd: scratch, env, stdio: 'ignore' });
    let spawnError;
    child.once('error', error => { spawnError = error; });
    stopped = new Promise(ok => child.once('close', ok));
    const url = `http://127.0.0.1:${port}`;
    let health;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, 'Runtime exited before becoming healthy');
      assert.equal(child.signalCode, null, 'Runtime was terminated before becoming healthy');
      try {
        const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { health = await response.json(); break; }
      } catch { /* readiness is bounded; assertions below remain fatal */ }
      await delay(500);
    }
    assert.equal(health?.version, version, 'Health response must identify the fork version');
    assert.equal(health?.service, 'opencodex');
    assert.equal(health?.pid, child.pid, 'Health must come from the process we started');
    assert.equal(health?.port, port);
    const gui = await fetch(`${url}/`, { signal: AbortSignal.timeout(5000) });
    assert.equal(gui.status, 200);
    const html = await gui.text();
    const script = html.match(/<script[^>]+src="([^"]+)"/);
    assert.ok(script, 'Packaged GUI has no script asset');
    const asset = new URL(script[1], url);
    assert.equal(asset.origin, url, 'GUI asset must be local');
    const response = await fetch(asset, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.ok((await response.text()).length > 0);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      if (!await Promise.race([stopped.then(() => true), delay(5000).then(() => false)])) {
        child.kill('SIGKILL');
        assert.ok(await Promise.race([stopped.then(() => true), delay(5000).then(() => false)]), 'Runtime cleanup failed');
      }
    }
    rmSync(scratch, { recursive: true, force: true });
  }
  return { version: 'passed', keyring: 'passed', healthz: 'passed', dashboard: 'passed' };
}

function selectMacSDK() {
  const developers = readdirSync('/Applications').filter(name => /^Xcode.*\.app$/.test(name))
    .map(name => join('/Applications', name, 'Contents/Developer'));
  for (const developer of developers) {
    try {
      const sdk = run('xcrun', ['--sdk', 'macosx', '--show-sdk-version'], {
        env: { ...process.env, DEVELOPER_DIR: developer }, stdio: 'pipe', encoding: 'utf8', timeout: 10_000,
      });
      if (Number(sdk.split('.')[0]) >= 26) { process.env.DEVELOPER_DIR = developer; return; }
    } catch { /* another installed Xcode may satisfy the release contract */ }
  }
  throw new Error('Desktop macOS requires an installed Xcode with macOS SDK 26+');
}

async function standalone(target, version, out, file) {
  bun('run', 'build:standalone', '--target', target);
  const directory = join(root, 'dist/standalone', target);
  if (process.platform === 'win32') {
    run('pwsh', ['-NoProfile', '-Command', 'Compress-Archive -Path ocx.exe,gui,keyring -DestinationPath $env:FORK_ARCHIVE'], {
      cwd: directory, env: { ...process.env, FORK_ARCHIVE: join(out, file) },
    });
  } else run('tar', ['-czf', join(out, file), 'ocx', 'gui', 'keyring'], { cwd: directory });
  const extracted = mkdtempSync(join(tmpdir(), 'ocx-fork-extracted-'));
  try {
    if (process.platform === 'win32') {
      run('pwsh', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:FORK_ARCHIVE -DestinationPath $env:FORK_EXTRACTED'], {
        env: { ...process.env, FORK_ARCHIVE: join(out, file), FORK_EXTRACTED: extracted },
      });
    } else run('tar', ['-xf', join(out, file), '-C', extracted]);
    return await smokeRuntime(join(extracted, process.platform === 'win32' ? 'ocx.exe' : 'ocx'), version);
  } finally { rmSync(extracted, { recursive: true, force: true }); }
}

async function desktop(target, version, out, scratch) {
  const mac = process.platform === 'darwin';
  const windows = process.platform === 'win32';
  const desktopRoot = join(root, 'desktop');
  const tauriRoot = join(desktopRoot, 'src-tauri');
  if (mac) selectMacSDK();
  const triples = mac ? ['aarch64-apple-darwin', 'x86_64-apple-darwin'] : [target];
  for (const triple of triples) bun('desktop/scripts/prepare-sidecar.ts', '--target', triple);
  if (mac) {
    run('lipo', ['-create', ...triples.map(triple => join(tauriRoot, 'binaries', `ocx-${triple}`)), '-output', join(tauriRoot, 'binaries', `ocx-${target}`)]);
    run('lipo', [join(tauriRoot, 'binaries', `ocx-${target}`), '-verify_arch', 'arm64', 'x86_64']);
    run('bash', ['desktop/scripts/build-widget.sh'], { env: { ...process.env, MACOS_SIGN_IDENTITY: '', WIDGET_SIGN_REQUIRED: '0' } });
    for (const arch of ['arm64', 'x64']) {
      const addon = join(tauriRoot, 'resources/keyring', `keyring.darwin-${arch}.node`);
      run('codesign', ['--force', '--sign', '-', addon]);
    }
  }
  const build = (bundles, targetDir) => run('bun', ['x', '--no-install', 'tauri', 'build', '--ci', '--target', target, '--bundles', bundles], {
    cwd: desktopRoot, env: { ...process.env, CARGO_TARGET_DIR: targetDir },
  });
  let bundleRoot;
  let smoke;
  if (mac || windows) {
    const targetDir = join(scratch, 'cargo');
    build(mac ? 'app,dmg' : 'msi', targetDir);
    bundleRoot = join(targetDir, target, 'release/bundle');
    if (mac) {
      const app = join(bundleRoot, 'macos/OpenCodex.app');
      run('bash', ['desktop/scripts/verify-macos-runtime.sh', app]);
      for (const arch of ['arm64', 'x64']) assert.ok(existsSync(join(app, 'Contents/Resources/keyring', `keyring.darwin-${arch}.node`)));
      smoke = await smokeRuntime(join(app, 'Contents/MacOS/ocx'), version);
      // Updater artifact creation is disabled. This is a manual-install archive,
      // produced from the verified ad-hoc app, with no .sig or updater manifest.
      run('tar', ['-czf', join(bundleRoot, 'macos/OpenCodex.app.tar.gz'), 'OpenCodex.app'], { cwd: join(bundleRoot, 'macos') });
    } else {
      const msi = readdirSync(join(bundleRoot, 'msi')).filter(name => name.endsWith('.msi'));
      assert.equal(msi.length, 1);
      const extracted = join(scratch, 'msi-extracted');
      run('msiexec.exe', ['/a', join(bundleRoot, 'msi', msi[0]), '/qn', `TARGETDIR=${extracted}`]);
      const binaries = readdirSync(extracted, { recursive: true }).filter(name => basename(name) === 'ocx.exe');
      assert.equal(binaries.length, 1, 'MSI must contain one sidecar');
      smoke = await smokeRuntime(join(extracted, binaries[0]), version);
    }
    smoke.nativeGui = 'not-exercised';
  } else {
    const wrapper = join(desktopRoot, 'scripts/appimage-patchelf.py');
    chmodSync(wrapper, 0o755);
    process.env.PATCHELF = wrapper;
    bundleRoot = join(scratch, 'linux-bundles');
    for (const format of ['appimage', 'deb']) {
      const targetDir = join(scratch, `cargo-${format}`);
      build(format, targetDir);
      cpSync(join(targetDir, target, 'release/bundle', format), join(bundleRoot, format), { recursive: true });
    }
    run('bash', ['desktop/scripts/verify-linux-sidecar.sh', join(bundleRoot, 'appimage')]);
    // Reuse the faithful packaged-shell acceptance (both formats, real window,
    // sidecar health/version and shutdown), including its isolated homes.
    run('dbus-run-session', ['--', 'xvfb-run', '-a', '-s', '-screen 0 1440x900x24', 'bash', '-c',
      'openbox >/dev/null 2>&1 & wm_pid=$!; trap \'kill "$wm_pid" 2>/dev/null || true\' EXIT; bun desktop/scripts/linux-packaged-e2e.ts --bundle-root "$FORK_BUNDLE_ROOT" --report "$FORK_E2E_REPORT" --version "$FORK_VERSION"'], {
      env: { ...process.env, FORK_BUNDLE_ROOT: bundleRoot, FORK_E2E_REPORT: join(scratch, 'e2e.json'), FORK_VERSION: version },
    });
    const report = JSON.parse(readFileSync(join(scratch, 'e2e.json'), 'utf8'));
    assert.equal(report.ok, true);
    smoke = { nativeGui: 'passed-appimage-and-deb', healthz: 'passed', version: 'passed', keyring: 'passed-appimage' };
  }
  const { collectReleaseAssets } = await import('../../desktop/scripts/collect-release-assets.ts');
  collectReleaseAssets({ version, target, out, repoRoot: root, bundleRoot });
  return smoke;
}

export async function main(argv) {
  const [command, kind, target, version, source, ...rest] = argv;
  assert.ok(['validate', 'build'].includes(command) && rest.length === 0,
    'Usage: bun scripts/fork/build-assets.mjs <validate|build> <standalone|desktop> <target> <version> <sha>');
  const contract = assetContract(kind, target, version, source);
  assert.equal(run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim(), source, 'Source SHA mismatch');
  if (command === 'validate') { console.log(JSON.stringify(contract)); return; }
  const host = process.platform === 'win32' ? 'windows' : process.platform;
  assert.ok(kind === 'standalone' ? target === `bun-${host}-${process.arch}`
    : target === ({ darwin: 'universal-apple-darwin', win32: 'x86_64-pc-windows-msvc', linux: 'x86_64-unknown-linux-gnu' })[process.platform], 'Use a native runner for every target');
  const out = join(root, 'dist/fork-assets', contract.artifact);
  assert.ok(!existsSync(out), 'Refusing to mix artifacts with a previous build');
  mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'ocx-fork-build-'));
  try {
    // Build-local version stamping uses the shared owner, including Cargo.lock.
    const { writeVersionSources, versionSourceMismatches } = await import('../release-version-sources.ts');
    writeVersionSources(root, version);
    assert.deepEqual(versionSourceMismatches(root, version), []);
    if (kind === 'desktop') {
      const file = join(root, 'desktop/src-tauri/tauri.conf.json');
      const config = manualInstallConfig(JSON.parse(readFileSync(file, 'utf8')), process.platform);
      if (process.platform === 'win32') {
        const { windowsInstallerVersion } = await import('../../desktop/scripts/windows-installer-config.ts');
        config.bundle.windows.wix.version = windowsInstallerVersion(version);
      }
      atomicJson(file, config);
    }
    bun('run', 'build:gui');
    const smoke = kind === 'standalone' ? await standalone(target, version, out, contract.files[0]) : await desktop(target, version, out, scratch);
    const files = contract.files.map(name => {
      const file = join(out, name);
      const sha256 = digest(file);
      const size = statSync(file).size;
      assert.ok(size > 0);
      writeFileSync(`${file}.sha256`, `${sha256}  ${name}\n`);
      return { name, sha256 };
    });
    assert.deepEqual(readdirSync(out).sort(), contract.files.flatMap(name => [name, `${name}.sha256`]).sort(), 'Unexpected assets (including signatures)');
    atomicJson(join(out, contract.manifest), {
      version, source, target, files,
      signing: { identity: process.platform === 'darwin' ? 'ad-hoc' : 'unsigned', notarized: false, official: false },
      updater: { mode: 'manual-install', endpoints: [], signatures: false }, smoke,
    });
    console.log(`Built ${contract.artifact}`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
