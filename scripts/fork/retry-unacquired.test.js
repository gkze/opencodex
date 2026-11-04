import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decide, maxAttempts, unacquired } from './retry-unacquired.mjs';

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

test('the watcher reacts only to failed publish runs of the maintained branch and can re-run them', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/fork-nightly-retry.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflows: \[Publish fork nightly\]/);
  assert.match(workflow, /github\.repository == 'gkze\/opencodex'/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'failure'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'gkze\/patches'/);
  assert.match(workflow, /actions: write/);
  assert.doesNotMatch(workflow, /contents: write|secrets\./);
});
