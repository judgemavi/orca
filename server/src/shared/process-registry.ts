import type { Subprocess } from 'bun';
import kill from 'tree-kill';
import { log } from './logger';

interface TrackedProcess {
  label: string;
  proc: Subprocess;
}

const tracked = new Map<number, TrackedProcess>();

export function trackProcess(proc: Subprocess, label: string): void {
  const pid = proc.pid;
  if (!pid) return;
  tracked.set(pid, { label, proc });
  proc.exited.then(() => tracked.delete(pid)).catch(() => tracked.delete(pid));
}

export function untrackProcess(proc: Subprocess): void {
  if (proc.pid) tracked.delete(proc.pid);
}

export function killAllTracked(signal: string = 'SIGTERM'): Promise<number> {
  const entries = [...tracked.entries()];
  tracked.clear();

  let killed = 0;
  const promises = entries.map(([pid, { label }]) =>
    treeKill(pid, signal)
      .then(() => {
        killed++;
        log.info('killed process', { label, pid });
      })
      .catch(() => {
        log.warn('failed to kill process, may have already exited', { label, pid });
      }),
  );

  return Promise.all(promises).then(() => killed);
}

export function trackedCount(): number {
  return tracked.size;
}

function treeKill(pid: number, signal: string): Promise<void> {
  return new Promise((resolve, reject) => {
    kill(pid, signal, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
