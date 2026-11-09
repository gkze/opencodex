import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

/** A local checkout's origin may be upstream; publication is fork-only. */
export function assertForkRemote() {
  const rows = execFileSync('git', ['config', '--get-regexp', '^remote\\.origin\\.(url|pushurl)$'], { encoding: 'utf8' }).trim().split('\n');
  for (const row of rows) assert.match(row.slice(row.indexOf(' ') + 1), /^(?:https:\/\/github\.com\/|git@github\.com:)gkze\/opencodex(?:\.git)?$/, 'Publication origin must be gkze/opencodex');
}
