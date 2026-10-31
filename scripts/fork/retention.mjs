import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const releasesPath = 'repos/gkze/opencodex/releases';
const nightlyTag = /^fork-v\d+\.\d+\.\d+-gkze\.nightly\.\d+\.\d+$/;

const completionMarker = tag => `<!-- opencodex-nightly-publication-complete:${tag} -->`;

/** Only verified complete publications count toward the five-release window. */
export function expiredNightlies(releases, currentTag) {
  assert.ok(Array.isArray(releases));
  assert.match(currentTag, nightlyTag);
  const nightlies = releases.filter(r => r.draft === false && r.prerelease === true && nightlyTag.test(r.tag_name) &&
    typeof r.body === 'string' && r.body.split('\n').includes(completionMarker(r.tag_name)));
  for (const release of nightlies) {
    assert.ok(Number.isSafeInteger(release.id) && release.id > 0);
    assert.ok(Number.isFinite(Date.parse(release.published_at)), 'Missing nightly publication time');
  }
  assert.equal(new Set(nightlies.map(r => r.id)).size, nightlies.length, 'Duplicate release identity');
  nightlies.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || b.id - a.id);
  assert.equal(nightlies[0]?.tag_name, currentTag, 'Retention requires the newest published nightly');
  return nightlies.slice(5);
}

function github(args) {
  const output = execFileSync('gh', ['api', ...args], { encoding: 'utf8' });
  return output.trim() ? JSON.parse(output) : null;
}

/** Persist completion only after asset verification and package nightly-tag readback. */
export function recordNightlyPublication(id, tag, api = github) {
  assert.ok(Number.isSafeInteger(id) && id > 0);
  assert.match(tag, nightlyTag);
  const endpoint = `${releasesPath}/${id}`;
  const release = api([endpoint]);
  assert.equal(release.tag_name, tag);
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, true);
  const marker = completionMarker(tag);
  if (!(release.body ?? '').split('\n').includes(marker)) {
    api(['--method', 'PATCH', endpoint, '--raw-field', `body=${release.body ?? ''}\n\n${marker}`]);
  }
  const saved = api([endpoint]);
  assert.equal(saved.tag_name, tag);
  assert.ok(saved.body.split('\n').includes(marker), 'Publication completion marker did not persist');
}

/** Called only after the completion marker has been persisted and read back. */
export function pruneNightlyReleases(currentTag, api = github) {
  const list = () => api([`${releasesPath}?per_page=100`, '--paginate', '--slurp']).flat();
  const expired = expiredNightlies(list(), currentTag);
  for (const release of expired) {
    // Recheck the retention window and identity before each destructive request.
    assert.ok(expiredNightlies(list(), currentTag).some(r => r.id === release.id && r.tag_name === release.tag_name),
      'Release inventory changed during retention');
    const current = api([`${releasesPath}/${release.id}`]);
    assert.equal(current.tag_name, release.tag_name);
    assert.equal(current.draft, false);
    assert.equal(current.prerelease, true);
    assert.equal(current.published_at, release.published_at);
    assert.ok(current.body?.split('\n').includes(completionMarker(current.tag_name)));
    api(['--method', 'DELETE', `${releasesPath}/${release.id}`]);
  }
  const remaining = list();
  assert.ok(expired.every(deleted => remaining.every(r => r.id !== deleted.id)), 'Release deletion did not persist');
  expiredNightlies(remaining, currentTag);
  // Release deletion intentionally preserves Git tags, backup tags and package versions.
  console.log(`Nightly retention: removed ${expired.length} old release(s); Git tags and packages preserved.`);
  return expired.map(r => r.tag_name);
}
