// Keep one issue, "Fork nightly needs attention", in step with what the nightly cannot fix alone.
//
// The watcher calls this after each finished refresh or publish (and after its own recovery).
// The issue opens when a run failed for a reason recovery cannot fix, when a patch branch has a
// revision the published stack does not include (a held patch), or when the published stack leaves
// a registered patch out entirely (a dropped patch). It closes when none of those is true.
// Everything is read again from GitHub and git each time, so a missed event costs nothing.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const title = 'Fork nightly needs attention';
const generic = /^Process completed with exit code \d+\.?$/;

/** Notes worth quoting for a failed job: its annotations, minus the generic exit-code line when there is more. */
export const notesFor = annotations => {
  const specific = annotations.filter(note => !generic.test(note));
  return specific.length ? specific : annotations;
};

/** The body for the current problems, or null when there are none.
 * failure: null | {workflow, url, jobs: [{name, notes: string[]}]}
 * held: [{id, branch, head, shipped, review: null | sha, reason: null | string}]
 * dropped: [{id, branch, head, reason: null | string}] */
export function compose({ owner, repository, refresh, failure, held, dropped = [] }) {
  if (!failure && !held.length && !dropped.length) return null;
  const state = JSON.stringify({ failure: failure && failure.jobs.map(job => job.name), held: held.map(patch => [patch.id, patch.head, patch.review]), ...(dropped.length ? { dropped: dropped.map(patch => [patch.id, patch.head]) } : {}) });
  const lines = [
    `@${owner}, the fork nightly needs a person. The nightly keeps this issue up to date and closes it when the nightly is healthy again.`,
    '',
  ];
  if (failure) {
    lines.push('## Failed run', '', `[${failure.workflow}](${failure.url}) failed, and re-running it cannot fix it:`, '');
    for (const job of failure.jobs) {
      lines.push(`- **${job.name}**${job.notes.length ? ':' : ''}`);
      for (const note of job.notes) lines.push(`  > ${note.replaceAll('\n', '\n  > ')}`);
    }
    lines.push('');
  }
  if (held.length) {
    lines.push('## Held patches', '', 'The published stack does not include the current revision of these patch branches. It ships each one at its last accepted revision.', '');
    for (const patch of held) {
      lines.push(`- \`${patch.id}\`: \`${patch.branch}\` is at ${patch.head.slice(0, 12)}; the stack ships ${patch.shipped.slice(0, 12)}.${patch.reason ? ` Last refresh: ${patch.reason}` : ''}`);
      if (patch.review) {
        lines.push(`  The repair agent proposed a rework on [\`review/${patch.id}\`](https://github.com/${repository}/commit/${patch.review}). Review it, and accept it with:`,
          '  ```bash',
          `  git push --force-with-lease=refs/heads/${patch.branch}:${patch.head} origin ${patch.review}:refs/heads/${patch.branch}`,
          '  ```');
      } else lines.push(`  Rebase it onto upstream \`dev\` as one squashed commit, or see [the refresh log](${refresh}).`);
    }
    lines.push('');
  }
  if (dropped.length) {
    lines.push('## Dropped patches', '', 'The published stack does not include these patches at all: neither the branch revision nor the last accepted one replays onto upstream.', '');
    for (const patch of dropped) {
      lines.push(`- \`${patch.id}\`: \`${patch.branch}\` is at ${patch.head.slice(0, 12)}.${patch.reason ? ` Last refresh: ${patch.reason}` : ''}`,
        `  Rebase it onto upstream \`dev\` as one squashed commit, or see [the refresh log](${refresh}).`);
    }
    lines.push('');
  }
  lines.push(`<!-- fork-nightly-state: ${state} -->`);
  return lines.join('\n');
}

export const stateOf = body => body?.match(/<!-- fork-nightly-state: (.*) -->/)?.[1] ?? null;

async function main() {
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_REPOSITORY_OWNER, RUN_ID } = process.env;
  if (!GH_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPOSITORY ?? '') || !/^\d+$/.test(RUN_ID ?? '')) throw new Error('GH_TOKEN, GITHUB_REPOSITORY and RUN_ID are required');
  const api = async (path, init = {}) => {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/${path}`, {
      ...init,
      headers: { authorization: `Bearer ${GH_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (!response.ok) throw new Error(`GitHub ${response.status} for ${init.method ?? 'GET'} ${path}`);
    return response.status === 204 ? null : response.json();
  };
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

  const run = await api(`actions/runs/${RUN_ID}`);
  // A newer refresh or publish will report the state it leaves, so this one does not.
  for (const workflow of ['fork-stack-refresh.yml', 'fork-nightly-publish.yml']) {
    const runs = (await api(`actions/workflows/${workflow}/runs?branch=gkze/patches&per_page=20`)).workflow_runs;
    const newer = runs.find(other => other.status !== 'completed' && other.id !== run.id && other.created_at >= run.created_at);
    if (newer) return console.log(`Leaving the issue to ${newer.html_url}`);
  }
  if (run.status !== 'completed') return console.log(`Run ${run.id} is running again; its watcher will report.`);

  const annotationsOf = async job => (await api(`check-runs/${job.id}/annotations?per_page=100`)).map(a => [a.title, a.message].filter(Boolean).join(': '));
  const jobsOf = async (id, attempt) => (await api(`actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`)).jobs;
  let failure = null;
  if (run.conclusion !== 'success') {
    const jobs = (await jobsOf(run.id, run.run_attempt)).filter(job => ['failure', 'cancelled', 'timed_out', 'startup_failure'].includes(job.conclusion));
    failure = { workflow: run.name, url: run.html_url, jobs: await Promise.all(jobs.map(async job => ({ name: job.name, notes: notesFor(await annotationsOf(job)) }))) };
  }
  // The refresh that produced this state: the run itself, or the one whose stack the publish ran.
  const refresh = run.path.endsWith('fork-stack-refresh.yml') ? run
    : (await api(`actions/workflows/fork-stack-refresh.yml/runs?head_sha=${run.head_sha}&status=success&per_page=1`)).workflow_runs[0] ?? null;
  const reasons = new Map();
  if (refresh) for (const job of await jobsOf(refresh.id, refresh.run_attempt)) {
    for (const note of await annotationsOf(job)) {
      const noted = note.match(/^(?:Held|Dropped) ([a-z][a-z0-9-]*): (.*)$/s);
      if (noted) reasons.set(noted[1], noted[2]);
    }
  }

  git('fetch', '--quiet', 'origin', '+refs/heads/gkze/patches:refs/remotes/origin/gkze/patches');
  const tip = git('rev-parse', 'refs/remotes/origin/gkze/patches');
  const registry = JSON.parse(git('show', `${tip}:scripts/fork/orchestrator/registry.json`));
  const remote = new Map(git('ls-remote', 'origin', 'refs/heads/codex/*', 'refs/heads/review/*').split('\n').filter(Boolean).map(line => line.split('\t').reverse()));
  const held = [], dropped = [];
  for (const patch of registry.patches) {
    const head = remote.get(`refs/heads/${patch.branch}`);
    const message = git('log', '-1', '--format=%B', `--grep=^Patch-Id: ${patch.id}$`, tip);
    const shipped = message.match(/^Patch-Source: ([0-9a-f]{40})$/m)?.[1];
    // A registered patch with no commit in the published stack was left out of it.
    if (head && !message) { dropped.push({ id: patch.id, branch: patch.branch, head, reason: reasons.get(patch.id) ?? null }); continue; }
    if (!head || !shipped || head === shipped) continue;
    held.push({ id: patch.id, branch: patch.branch, head, shipped, review: remote.get(`refs/heads/review/${patch.id}`) ?? null, reason: reasons.get(patch.id) ?? null });
  }

  const body = compose({ owner: GITHUB_REPOSITORY_OWNER, repository: GITHUB_REPOSITORY, refresh: refresh?.html_url ?? run.html_url, failure, held, dropped });
  // Newest first. Upstream's issue-quality workflow can close a bot-authored issue as "not
  // planned" when someone comments. That issue is reopened rather than replaced.
  const ours = (await api('issues?state=all&sort=created&direction=desc&per_page=100')).filter(issue => !issue.pull_request && issue.title === title && issue.user.login === 'github-actions[bot]');
  let open = ours.find(issue => issue.state === 'open');
  if (!body) {
    if (!open) return console.log('The nightly is healthy.');
    await api(`issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `The nightly is healthy again as of [${run.name}](${run.html_url}).` }) });
    await api(`issues/${open.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });
    return console.log(`Closed #${open.number}.`);
  }
  if (!open && ours[0]?.state_reason === 'not_planned') {
    open = await api(`issues/${ours[0].number}`, { method: 'PATCH', body: JSON.stringify({ state: 'open' }) });
    console.log(`Reopened #${open.number}, which was closed while it still applied.`);
  }
  if (!open) {
    const created = await api('issues', { method: 'POST', body: JSON.stringify({ title, body }) });
    return console.log(`Opened #${created.number}.`);
  }
  if (open.body === body) return console.log(`#${open.number} is current.`);
  await api(`issues/${open.number}`, { method: 'PATCH', body: JSON.stringify({ body }) });
  // Body edits do not notify anyone, so a change in what needs attention gets a comment too.
  if (stateOf(open.body) !== stateOf(body)) await api(`issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `What needs attention changed after [${run.name}](${run.html_url}). The description is current.` }) });
  console.log(`Updated #${open.number}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
