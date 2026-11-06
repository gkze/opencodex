// Recover a failed "Publish fork nightly" run when the failure says nothing about the stack.
//
// 1. Jobs GitHub never started. GitHub cancels a hosted job it cannot place on a runner within about fifteen minutes and
// annotates it "The job was not acquired by Runner of type hosted even after multiple attempts".
// That happens to macOS jobs whenever the shared macOS pool is short. Those jobs are re-run.
// 2. A promotion refused because the fork branch or a patch branch moved during the run
//    (nightly.mjs annotates it "Fork advanced during publication"). The refusal keeps that work,
//    and a fresh refresh includes it, so one is started instead of losing the night.
// Everything else (a real test, build, smoke or promotion failure) is left alone.
//
// One invocation owns every retry of its run and polls each re-run itself. A re-run that fails
// again also wakes a second watcher for the same run. That one queues behind this one (same
// concurrency group), then reads the final attempt and only repeats what this one decided.
import { pathToFileURL } from 'node:url';

export const maxAttempts = 6;
const failed = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure']);

export const unacquired = message => /was not acquired by Runner/i.test(message);
export const advanced = message => /Fork advanced during publication/.test(message);

/** jobs: [{id, name, conclusion}] for one attempt; annotations: Map<id, string[]>. */
export function decide({ jobs, annotations, attempt }) {
  const broken = jobs.filter(job => failed.has(job.conclusion));
  if (!broken.length) return { action: 'stop', reason: 'no failed jobs' };
  const says = (job, kind) => (annotations.get(job.id) ?? []).some(kind);
  const real = broken.filter(job => !says(job, unacquired) && !says(job, advanced));
  if (real.length) return { action: 'stop', reason: `not a runner shortage: ${real.map(job => job.name).join(', ')}` };
  const moved = broken.filter(job => says(job, advanced));
  if (moved.length) return { action: 'refresh', reason: `a maintained ref moved during the run: ${moved.map(job => job.name).join(', ')}` };
  if (attempt >= maxAttempts) return { action: 'give-up', reason: `still unassigned after ${attempt} attempts: ${broken.map(job => job.name).join(', ')}` };
  return { action: 'rerun', reason: `GitHub never started: ${broken.map(job => job.name).join(', ')}` };
}

async function main() {
  const { GH_TOKEN, GITHUB_REPOSITORY, RUN_ID } = process.env;
  if (!GH_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPOSITORY ?? '') || !/^\d+$/.test(RUN_ID ?? '')) throw new Error('GH_TOKEN, GITHUB_REPOSITORY and RUN_ID are required');
  const api = async (path, init = {}) => {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/${path}`, {
      ...init,
      headers: { authorization: `Bearer ${GH_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (!response.ok) throw new Error(`GitHub ${response.status} for ${init.method ?? 'GET'} ${path}`);
    return response.status === 201 || response.status === 204 ? null : response.json();
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const settled = async () => {
    for (;;) {
      const run = await api(`actions/runs/${RUN_ID}`);
      if (run.status === 'completed') return run;
      await sleep(60_000);
    }
  };
  for (;;) {
    const run = await settled();
    if (run.conclusion === 'success') return console.log(`Run ${RUN_ID} attempt ${run.run_attempt} succeeded.`);
    const jobs = [];
    for (let page = 1; ; page++) {
      const batch = (await api(`actions/runs/${RUN_ID}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`)).jobs;
      jobs.push(...batch);
      if (batch.length < 100) break;
    }
    const annotations = new Map();
    for (const job of jobs.filter(job => failed.has(job.conclusion))) {
      annotations.set(job.id, (await api(`check-runs/${job.id}/annotations?per_page=100`)).map(a => [a.title, a.message].filter(Boolean).join(': ')));
    }
    const decision = decide({ jobs, annotations, attempt: run.run_attempt });
    console.log(`Attempt ${run.run_attempt}: ${decision.action} (${decision.reason})`);
    if (decision.action === 'stop') return;
    if (decision.action === 'give-up') { process.exitCode = 1; return; }
    if (decision.action === 'refresh') {
      const active = (await api(`actions/workflows/fork-stack-refresh.yml/runs?branch=gkze/patches&per_page=20`)).workflow_runs
        .filter(other => other.status !== 'completed' && other.created_at > run.created_at);
      if (active.length) return console.log(`A newer refresh is already running: ${active[0].html_url}`);
      await api('actions/workflows/fork-stack-refresh.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'gkze/patches' }) });
      return console.log('Started a fresh Fork stack refresh.');
    }
    await api(`actions/runs/${RUN_ID}/rerun-failed-jobs`, { method: 'POST' });
    // Let the new attempt register before polling, so the old completed state is not read back.
    let registered = false;
    for (let i = 0; i < 30 && !registered; i++) {
      await sleep(10_000);
      registered = (await api(`actions/runs/${RUN_ID}`)).run_attempt > run.run_attempt;
    }
    if (!registered) throw new Error(`Re-run of ${RUN_ID} attempt ${run.run_attempt} never registered`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
