import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

function pidPath(repoDir: string): string {
  return `${repoDir}/.orca/daemon.pid`;
}

export function writeDaemonPid(repoDir: string): void {
  mkdirSync(`${repoDir}/.orca`, { recursive: true });
  writeFileSync(pidPath(repoDir), String(process.pid), 'utf8');
}

export function clearDaemonPid(repoDir: string): void {
  const path = pidPath(repoDir);
  try {
    const content = readFileSync(path, 'utf8').trim();
    if (content === String(process.pid)) unlinkSync(path);
  } catch {
    // already gone
  }
}

export function isDaemonRunning(repoDir: string): boolean {
  const path = pidPath(repoDir);
  if (!existsSync(path)) return false;

  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isFinite(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err?.code === 'EPERM') return true; // process alive, different permissions
    // ESRCH = no such process — stale PID file
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
    return false;
  }
}
