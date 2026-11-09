import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Run after frozen installation and all source checks. Metadata is build-local;
// the maintained branch keeps upstream's version so the next rebase stays small.
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), process.env.FORK_CANDIDATE);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const base = pkg.version.split('-')[0];
assert.match(base, /^\d+\.\d+\.\d+$/);
assert.match(process.env.GITHUB_RUN_ID ?? '', /^\d+$/);
assert.match(process.env.GITHUB_RUN_ATTEMPT ?? '', /^\d+$/);
const version = `${base}-gkze.nightly.${process.env.GITHUB_RUN_ID}.${process.env.GITHUB_RUN_ATTEMPT}`;
pkg.name = '@gkze/opencodex';
pkg.files = [...new Set([...pkg.files, 'FORK.md'])];
pkg.version = version;
pkg.repository = { type: 'git', url: 'git+https://github.com/gkze/opencodex.git' };
pkg.homepage = 'https://github.com/gkze/opencodex';
pkg.bugs = { url: 'https://github.com/gkze/opencodex/issues' };
pkg.publishConfig = { registry: 'https://npm.pkg.github.com' };
// Git-install preparation is unnecessary for an already prepared release package.
delete pkg.scripts.prepare;
delete pkg.scripts.prepack;
delete pkg.scripts.prepublishOnly;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
execFileSync('bun', ['run', 'build:gui'], { stdio: 'inherit' });
mkdirSync('dist/fork', { recursive: true });
const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', 'dist/fork'], { encoding: 'utf8' }));
assert.equal(packed.length, 1);
writeFileSync('dist/fork/manifest.json', JSON.stringify({ version, tag: `fork-v${version}`, source: process.env.FORK_CANDIDATE, file: packed[0].filename }, null, 2) + '\n');
console.log(resolve('dist/fork', packed[0].filename));

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
