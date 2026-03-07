import type { Command } from 'commander';
import type { JobQueue } from '../../queue/queue';
import type { TaskStore } from '../../store/tasks';
import type { Job, JobStatus, Task } from '../../types';
import { isJSONMode, printJSON, printTable } from '../format';

export function registerQueueCommands(
  program: Command,
  deps: { queue: JobQueue; taskStore: TaskStore },
) {
  const { queue, taskStore } = deps;

  const cmd = program
    .command('queue').alias('q')
    .description('Inspect and manage the job queue')
    .option('--status <status>', 'filter by status')
    .option('--task <id>', 'filter by task id')
    .option('--watch', 'live view of tasks + queue (refreshes every 2s)')
    .option('--interval <ms>', 'refresh interval for --watch in ms', '2000')
    .option('--json', 'output raw JSON')
    .action(
      async (opts: {
        status?: string;
        task?: string;
        watch?: boolean;
        interval: string;
        json?: boolean;
      }) => {
        if (opts.watch) {
          await runWatch(queue, taskStore, opts.interval);
          return;
        }

        const status = (opts.status ?? '').trim() as JobStatus | '';
        const taskId = (opts.task ?? '').trim();

        let jobs = await queue.list({
          status: status || undefined,
          taskId: taskId || undefined,
          limit: 100,
        });

        if (!status) {
          jobs = jobs.filter(
            (j) => j.status === 'queued' || j.status === 'running',
          );
        }

        if (isJSONMode() || opts.json) {
          printJSON(jobs);
          return;
        }

        console.log(formatJobTable(jobs));
      },
    );

  cmd
    .command('counts')
    .description('Show job counts by status')
    .action(async () => {
      const counts = await queue.counts();
      if (isJSONMode()) {
        printJSON(counts);
        return;
      }
      const statuses = [
        'queued',
        'running',
        'completed',
        'failed',
        'cancelled',
      ];
      for (const s of statuses) {
        const count = counts[s] ?? 0;
        console.log(`${s}:`.padEnd(12) + count);
      }
    });

  cmd
    .command('get <id>')
    .description('Show full job detail')
    .option('--json', 'output raw JSON')
    .action(async (id: string, opts: { json?: boolean }) => {
      const job = await queue.get(id.trim());
      if (!job) throw new Error(`job not found: ${id}`);
      if (isJSONMode() || opts.json) {
        printJSON(job);
        return;
      }
      console.log(formatJobDetail(job));
    });

  cmd
    .command('cancel <id>')
    .description('Cancel a queued job')
    .action(async (id: string) => {
      const job = await queue.get(id.trim());
      if (!job) throw new Error(`job not found: ${id}`);
      if (job.status !== 'queued') {
        throw new Error(`cannot cancel job in status: ${job.status}`);
      }
      const cancelled = await queue.cancel(id.trim());
      if (isJSONMode()) {
        printJSON({ jobId: id, cancelled });
        return;
      }
      console.log(cancelled ? `cancelled: ${id}` : `failed to cancel: ${id}`);
    });

  cmd
    .command('drain')
    .description('Cancel all queued jobs')
    .action(async () => {
      const cancelled = await queue.drain();
      if (isJSONMode()) {
        printJSON({ cancelled });
        return;
      }
      console.log(`cancelled ${cancelled} job(s)`);
    });
}

async function runWatch(
  queue: JobQueue,
  taskStore: TaskStore,
  intervalStr: string,
): Promise<void> {
  const intervalMs = Math.max(500, Number.parseInt(intervalStr, 10) || 2000);

  const render = async () => {
    const [jobs, tasks, counts] = await Promise.all([
      queue.list({ limit: 50 }),
      taskStore.list(),
      queue.counts(),
    ]);

    const activeJobs = jobs.filter(
      (j) => j.status === 'queued' || j.status === 'running',
    );
    const recentDone = jobs
      .filter((j) => j.status === 'completed' || j.status === 'failed')
      .slice(0, 5);

    const lines: string[] = [];
    const now = Date.now();

    const q = counts.queued ?? 0;
    const r = counts.running ?? 0;
    const c = counts.completed ?? 0;
    const f = counts.failed ?? 0;
    lines.push(
      `── orca ── queued:${q} running:${r} done:${c} failed:${f} ── ${new Date().toLocaleTimeString()} ──`,
    );
    lines.push('');

    const tasksByStatus = new Map<string, Task[]>();
    for (const task of tasks) {
      const list = tasksByStatus.get(task.status) ?? [];
      list.push(task);
      tasksByStatus.set(task.status, list);
    }

    const activeStatuses = [
      'running',
      'review',
      'planned',
      'pending',
      'stopped',
      'failed',
    ];
    let hasActive = false;
    for (const status of activeStatuses) {
      const statusTasks = tasksByStatus.get(status);
      if (!statusTasks || statusTasks.length === 0) continue;
      hasActive = true;
      for (const task of statusTasks.slice(0, 10)) {
        const id = task.id.slice(0, 7);
        const title =
          task.title.length > 50 ? `${task.title.slice(0, 47)}...` : task.title;
        const badge = statusBadge(task.status);
        const extra =
          task.status === 'stopped' && task.pendingQuestion
            ? ' [needs input]'
            : '';
        lines.push(` ${badge}  ${id}  ${title}${extra}`);
      }
    }

    if (!hasActive) {
      lines.push(' (no active tasks)');
    }

    if (activeJobs.length > 0) {
      lines.push('');
      lines.push('Jobs:');
      for (const job of activeJobs) {
        const id = job.id.slice(0, 8);
        const taskId = job.taskId ? job.taskId.slice(0, 7) : '-';
        const age = formatAge(now - new Date(job.createdAt).getTime());
        const badge = job.status === 'running' ? 'RUN' : 'QUE';
        lines.push(
          ` [${badge}] ${id}  ${job.type.padEnd(10)} task:${taskId}  ${age}`,
        );
      }
    }

    if (recentDone.length > 0) {
      lines.push('');
      lines.push('Recent:');
      for (const job of recentDone) {
        const id = job.id.slice(0, 8);
        const taskId = job.taskId ? job.taskId.slice(0, 7) : '-';
        const icon = job.status === 'completed' ? 'OK' : 'ERR';
        const err = job.error ? ` ${job.error.slice(0, 40)}` : '';
        lines.push(
          ` [${icon}] ${id}  ${job.type.padEnd(10)} task:${taskId}${err}`,
        );
      }
    }

    process.stdout.write('\x1B[2J\x1B[H');
    console.log(lines.join('\n'));
  };

  await render();
  const timer = setInterval(render, intervalMs);
  const stop = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
}

function statusBadge(status: string): string {
  switch (status) {
    case 'running':
      return 'RUN ';
    case 'review':
      return 'REV ';
    case 'planned':
      return 'PLAN';
    case 'pending':
      return 'PEND';
    case 'stopped':
      return 'STOP';
    case 'failed':
      return 'FAIL';
    case 'approved':
      return 'APPR';
    case 'merged':
      return 'MRGD';
    default:
      return status.slice(0, 4).toUpperCase().padEnd(4);
  }
}

function formatJobTable(jobs: Job[]): string {
  if (jobs.length === 0) return '(no jobs)';
  const now = Date.now();
  const rows = jobs.map((job) => ({
    ID: job.id.slice(0, 8),
    TYPE: job.type,
    TASK: job.taskId ? job.taskId.slice(0, 7) : '-',
    STATUS: job.status,
    PRI: job.priority,
    AGE: formatAge(now - new Date(job.createdAt).getTime()),
  }));
  return printTable(rows);
}

function formatJobDetail(job: Job): string {
  const lines = [
    `ID:          ${job.id}`,
    `Type:        ${job.type}`,
    `Status:      ${job.status}`,
    `Priority:    ${job.priority}`,
    `Task:        ${job.taskId ?? '-'}`,
    `Created:     ${job.createdAt}`,
    `Started:     ${job.startedAt ?? '-'}`,
    `Completed:   ${job.completedAt ?? '-'}`,
  ];
  if (job.error) lines.push(`Error:       ${job.error}`);
  if (job.payload) lines.push(`Payload:     ${JSON.stringify(job.payload)}`);
  if (job.result) lines.push(`Result:      ${JSON.stringify(job.result)}`);
  return lines.join('\n');
}

function formatAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}
