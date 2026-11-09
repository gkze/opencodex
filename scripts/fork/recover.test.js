import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decide, maxAttempts, unacquired, advanced } from './recover.mjs';

// Verbatim annotations from Publish fork nightly 41920075969 and 42017446473.
const notAcquired = 'The job was not acquired by Runner of type hosted even after multiple attempts';
const capacity = 'Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times.';
const desktop = { id: 1, name: 'assets / build (desktop, universal-apple-darwin, macos-15, darwin, *)', conclusion: 'cancelled' };
const intel = { id: 2, name: 'smoke (macos-15-intel)', conclusion: 'cancelled' };
const publish = { id: 3, name: 'publish', conclusion: 'skipped' };
const linux = { id: 4, name: 'test (1)', conclusion: 'success' };

test('only the hosted-runner placement failure counts as unassigned', () => {
  assert.equal(unacquired(notAcquired), true);
  assert.equal(unacquired(capacity), false);
  assert.equal(unacquired('Process completed with exit code 1.'), false);
});

test('jobs GitHub never started are re-run, and dependents skipped by them do not block it', () => {
  const annotations = new Map([[1, [capacity, notAcquired]], [2, [notAcquired]]]);
  assert.equal(decide({ jobs: [desktop, intel, publish, linux], annotations, attempt: 1 }).action, 'rerun');
});

test('a real failure anywhere stops the retry, even beside an unassigned job', () => {
  const smoke = { id: 5, name: 'smoke (ubuntu-24.04)', conclusion: 'failure' };
  const annotations = new Map([[1, [notAcquired]], [5, ['Process completed with exit code 1.']]]);
  const decision = decide({ jobs: [desktop, smoke, publish], annotations, attempt: 1 });
  assert.equal(decision.action, 'stop');
  assert.match(decision.reason, /smoke \(ubuntu-24\.04\)/);
  // A promotion refusal (a maintained ref advanced) carries no placement annotation.
  assert.equal(decide({ jobs: [{ id: 6, name: 'publish', conclusion: 'failure' }], annotations: new Map(), attempt: 1 }).action, 'stop');
  // A run someone cancelled by hand: cancelled jobs without the annotation.
  assert.equal(decide({ jobs: [{ ...desktop, id: 7 }], annotations: new Map([[7, []]]), attempt: 1 }).action, 'stop');
});

test('retries are bounded', () => {
  const annotations = new Map([[1, [notAcquired]]]);
  assert.equal(decide({ jobs: [desktop], annotations, attempt: maxAttempts - 1 }).action, 'rerun');
  assert.equal(decide({ jobs: [desktop], annotations, attempt: maxAttempts }).action, 'give-up');
});

test('a promotion refused because a maintained ref moved starts a fresh refresh', () => {
  const promote = { id: 8, name: 'publish', conclusion: 'failure' };
  const moved = 'Fork advanced during publication: refs/heads/gkze/patches moved while this nightly ran';
  assert.equal(advanced(moved), true);
  assert.equal(decide({ jobs: [promote], annotations: new Map([[8, [moved, 'Process completed with exit code 1.']]]), attempt: 1 }).action, 'refresh');
  // The title the watcher matches is the one promotion writes.
  const nightly = readFileSync(new URL('./nightly.mjs', import.meta.url), 'utf8');
  assert.match(nightly, /const advancedTitle = "Fork advanced during publication"/);
  assert.match(nightly, /::error title=\$\{advancedTitle\}::/);
});

test('the watcher recovers only failed publish runs of the maintained branch, and reports both workflows', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/fork-nightly-watch.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflows: \[Fork stack refresh, Publish fork nightly\]/);
  assert.match(workflow, /github\.repository == 'gkze\/opencodex'/);
  assert.match(workflow, /github\.event\.workflow_run\.name == 'Publish fork nightly' &&\n\s+github\.event\.workflow_run\.conclusion == 'failure'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'gkze\/patches'/);
  assert.match(workflow, /actions: write/);
  assert.match(workflow, /issues: write/);
  assert.doesNotMatch(workflow, /contents: write|secrets\./);
});
