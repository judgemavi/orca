import type { Command } from 'commander';
import type { JobQueue } from '../../queue/queue';
import type { Job, JobStatus } from '../../types';
import { isJSONMode, printJSON, printTable } from '../format';

export function registerQueueCommands(
  program: Command,
  deps: { queue: JobQueue },
) {
  const { queue } = deps;

  const cmd = program
    .command('queue')
    .description('Inspect and manage the job queue')
    .option('--status <status>', 'filter by status')
    .option('--task <id>', 'filter by task id')
    .option('--json', 'output raw JSON')
    .action(
      async (opts: { status?: string; task?: string; json?: boolean }) => {
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
