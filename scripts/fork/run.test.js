import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const run = fileURLToPath(new URL('./run.mjs', import.meta.url));
// A child that exits at once but leaves a background process holding its stdout and stderr: the
// shape that kept the 2026-11-11 publish step open until its timeout.
const leaky = "sleep 4 & echo child-output; echo '::warning title=Kept::annotation'";

// Times a node process the way the runner reads a step: through pipes, until they close.
const timed = script => {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  return { ...result, seconds: (Date.now() - started) / 1000 };
};

test('a descendant left behind cannot hold the caller\'s output open', () => {
  const isolated = timed(`import { runIsolated } from ${JSON.stringify(run)}; runIsolated('sh', ['-c', ${JSON.stringify(leaky)}]);`);
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.ok(isolated.seconds < 3, `took ${isolated.seconds}s`);
  assert.match(isolated.stdout, /child-output/);
  assert.match(isolated.stdout, /::warning title=Kept::annotation/);
});

test('inherited descriptors do hold the caller open, so the test above can fail', () => {
  const inherited = timed(`import { execFileSync } from 'node:child_process'; execFileSync('sh', ['-c', ${JSON.stringify(leaky)}], { stdio: 'inherit' });`);
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.ok(inherited.seconds >= 3.5, `took only ${inherited.seconds}s`);
});

test('a failing child still prints its output and throws with its status', () => {
  const failed = timed(`import { runIsolated } from ${JSON.stringify(run)}; try { runIsolated('sh', ['-c', 'echo before-failure; exit 3']); } catch (error) { console.log('status=' + error.status); process.exitCode = 9; }`);
  assert.equal(failed.status, 9, failed.stderr);
  assert.match(failed.stdout, /before-failure[\s\S]*status=3/);
});

test('a child waiting on stdin reads end-of-file instead of waiting for a person', () => {
  const waiting = timed(`import { runIsolated } from ${JSON.stringify(run)}; runIsolated('sh', ['-c', 'if read answer; then echo "read [$answer]"; else echo end-of-file; fi']);`);
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.match(waiting.stdout, /end-of-file/);
  assert.ok(waiting.seconds < 3, `took ${waiting.seconds}s`);
});
