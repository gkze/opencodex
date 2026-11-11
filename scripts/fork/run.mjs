// Run a child command without handing it this process's stdin, stdout or stderr.
//
// A GitHub Actions step ends when its output pipes close, not when its process exits. On
// 2026-11-11 the publish step refused promotion and node exited at 04:23:52, but the runner only
// ended the step at its 25-minute timeout and then terminated one orphan process, "MainThread"
// (pid 2266), that an earlier child had left holding the step's output. Here a child's output goes
// to a file that is printed once it exits, so a descendant it leaves behind can only hold that file;
// and a child that waits on stdin reads end-of-file and fails instead of waiting for a person.
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function runIsolated(command, args, options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'fork-run-'));
  const log = path.join(directory, 'output.log');
  const fd = openSync(log, 'w');
  let result;
  try {
    result = spawnSync(command, args, { ...options, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
  try {
    // Workflow commands such as `::error` annotations are read from stdout, so they still reach
    // the runner, only after the child has finished rather than while it runs.
    process.stdout.write(readFileSync(log));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`Command failed: ${[command, ...args].join(' ')} (${result.signal ? `signal ${result.signal}` : `exit ${result.status}`})`);
    error.status = result.status;
    error.signal = result.signal;
    throw error;
  }
}
