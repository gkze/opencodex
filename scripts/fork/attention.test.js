import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose, stateOf, notesFor, title } from './attention.mjs';

const base = { owner: 'gkze', repository: 'gkze/opencodex', refresh: 'https://github.com/gkze/opencodex/actions/runs/1' };
const head = 'a'.repeat(40), shipped = 'b'.repeat(40), review = 'c'.repeat(40);
const held = { id: 'deepseek-browser-auth', branch: 'codex/patch/deepseek-browser-auth', head, shipped, review: null, reason: null };

test('a healthy nightly has no issue body', () => {
  assert.equal(compose({ ...base, failure: null, held: [] }), null);
  assert.equal(title, 'Fork nightly needs attention');
});

test('a failed run quotes its specific annotations, not the generic exit line', () => {
  assert.deepEqual(notesFor(['Process completed with exit code 1.', 'Fork stack refresh failed: Integration x: Conflicts: a.ts']), ['Fork stack refresh failed: Integration x: Conflicts: a.ts']);
  assert.deepEqual(notesFor(['Process completed with exit code 1.']), ['Process completed with exit code 1.']);
  const body = compose({ ...base, failure: { workflow: 'Publish fork nightly', url: 'https://example.test/run', jobs: [{ name: 'smoke (ubuntu-24.04)', notes: ['line one\nline two'] }] }, held: [] });
  assert.match(body, /^@gkze, the fork nightly needs a person/);
  assert.match(body, /\[Publish fork nightly\]\(https:\/\/example\.test\/run\) failed/);
  assert.match(body, /- \*\*smoke \(ubuntu-24\.04\)\*\*:\n  > line one\n  > line two/);
});

test('a held sensitive patch with a proposed rework gives the exact accept command', () => {
  const body = compose({ ...base, failure: null, held: [{ ...held, review, reason: 'Shipping its last accepted revision bbbb: sensitive patch needs review' }] });
  assert.match(body, /`codex\/patch\/deepseek-browser-auth` is at a{12}; the stack ships b{12}\. Last refresh: Shipping/);
  assert.ok(body.includes(`git push --force-with-lease=refs/heads/codex/patch/deepseek-browser-auth:${head} origin ${review}:refs/heads/codex/patch/deepseek-browser-auth`));
  assert.match(compose({ ...base, failure: null, held: [held] }), /Rebase it onto upstream `dev`.*\(https:\/\/github\.com\/gkze\/opencodex\/actions\/runs\/1\)/);
});

test('the recorded state changes with what needs attention, not with run links', () => {
  const one = compose({ ...base, failure: null, held: [held] });
  const again = compose({ ...base, refresh: 'https://github.com/gkze/opencodex/actions/runs/2', failure: null, held: [{ ...held, reason: 'other words' }] });
  assert.notEqual(one, again);
  assert.equal(stateOf(one), stateOf(again));
  assert.notEqual(stateOf(one), stateOf(compose({ ...base, failure: null, held: [{ ...held, review }] })));
  assert.equal(stateOf('no marker'), null);
});
