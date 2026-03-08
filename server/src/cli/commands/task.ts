import type { Command } from 'commander';
import { isAutoRun } from '../../config/config';
import { isDaemonRunning } from '../../queue/lock';
import type { JobQueue } from '../../queue/queue';
import type { ConfigStore } from '../../store/config';
import type { InteractionStore } from '../../store/interactions';
import type { TaskStore } from '../../store/tasks';
import type {
  AutoRunOverrides,
  InteractionType,
  Task,
  TaskStatus,
} from '../../types';
import { INTERACTION_TYPES } from '../../types';
import { deleteTask } from '../../workflows/delete';
import {
  acceptBreakdown,
  approvePlan,
  loadProposedTasksFromInteraction,
  rejectBreakdown,
} from '../../workflows/planning';
import { approveTask } from '../../workflows/review';
import {
  createTask,
  enqueueBreakdown,
  enqueueEvaluate,
  enqueueMerge,
  provideInput,
  requestChanges,
  resumeTask,
  stopTask,
  triggerReview,
  updateTask,
} from '../../workflows/tasks';
import { printJSON } from '../format';
import {
  allTasks,
  confirm,
  pendingTasks,
  pickTask,
  reviewTasks,
  runningTasks,
  stoppedTasks,
  textInput,
} from '../helpers';

export interface TaskCommandDeps {
  repoDir: string;
  taskStore: TaskStore;
  interactionStore: InteractionStore;
  configStore: ConfigStore;
  queue: JobQueue;
}

export function registerTaskCommands(task: Command, deps: TaskCommandDeps) {
  task
    .command('list')
    .alias('ls')
    .option('-s, --status <status>', 'filter by status')
    .action(async (opts: { status?: string }) => {
      const status = (opts.status ?? '').trim();
      const data = status
        ? await deps.taskStore.listByStatus(status as TaskStatus)
        : await deps.taskStore.list();
      printJSON(data);
    });

  task.command('ready').action(async () => {
    printJSON(await deps.taskStore.getReady());
  });

  task
    .command('get <id>')
    .alias('g')
    .action(async (id: string) => {
      const taskItem = await deps.taskStore.get(id);
      if (!taskItem) throw new Error(`task not found: ${id}`);
      printJSON(taskItem);
    });

  task
    .command('create')
    .alias('new')
    .option('-t, --title <title>', 'task title')
    .option('-d, --description <description>', 'task description', '')
    .option('--parent <parent>', 'parent task id')
    .option(
      '--depends-on <ids>',
      'comma-separated task IDs this task depends on',
    )
    .option(
      '--disable-autorun <types>',
      'comma-separated interaction types to disable auto-run (e.g. review,merge)',
    )
    .option(
      '--enable-autorun <types>',
      'comma-separated interaction types to enable auto-run',
    )
    .action(
      async (opts: {
        title?: string;
        description: string;
        parent?: string;
        dependsOn?: string;
        disableAutorun?: string;
        enableAutorun?: string;
      }) => {
        let title = (opts.title ?? '').trim();
        if (!title) {
          title = await textInput('Task title', { required: true });
        }

        let description = opts.description;
        if (!(opts.description ?? '').trim() && canPrompt()) {
          description = await textInput('Task description (optional)');
        }

        let parent = (opts.parent ?? '').trim();
        if (!parent && canPrompt()) {
          const pickParent = await confirm('Attach to a parent task?', false);
          if (pickParent) {
            parent = (
              await pickTask(deps.taskStore, 'Select parent task', allTasks)
            ).id;
          }
        }

        const dependsOn = (opts.dependsOn ?? '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);

        const autoRunOverrides = parseAutoRunOverrides(
          opts.disableAutorun,
          opts.enableAutorun,
        );

        const serverUp = isDaemonRunning(deps.repoDir);
        const result = await createTask(
          {
            title,
            description,
            parentId: parent || null,
            dependsOn,
            autoRunOverrides:
              Object.keys(autoRunOverrides).length > 0
                ? autoRunOverrides
                : undefined,
          },
          {
            taskStore: deps.taskStore,
            queue: serverUp ? deps.queue : undefined,
          },
        );
        printJSON({
          ...result,
          daemon: serverUp,
          ...(!serverUp
            ? {
                note: 'no daemon running — auto-run disabled, use manual commands',
              }
            : {}),
        });
      },
    );

  task
    .command('update <id>')
    .option('-t, --title <title>', 'new title')
    .option('-d, --description <description>', 'new description')
    .option('--status <status>', 'new status')
    .option('--session-id <sessionID>', 'set session id')
    .option(
      '--disable-autorun <types>',
      'comma-separated interaction types to disable auto-run',
    )
    .option(
      '--enable-autorun <types>',
      'comma-separated interaction types to enable auto-run',
    )
    .option(
      '--reset-autorun [types]',
      'clear overrides, inherit from config (comma-separated or "all")',
    )
    .action(
      async (
        id: string,
        opts: {
          title?: string;
          description?: string;
          status?: string;
          sessionId?: string;
          disableAutorun?: string;
          enableAutorun?: string;
          resetAutorun?: string | true;
        },
      ) => {
        let autoRunOverrides: AutoRunOverrides | undefined;
        if (opts.resetAutorun !== undefined) {
          const existing = await deps.taskStore.get(id);
          autoRunOverrides = mergeAutoRunOverrides(
            existing?.autoRunOverrides ?? {},
            opts.disableAutorun,
            opts.enableAutorun,
            opts.resetAutorun,
          );
        } else {
          const parsed = parseAutoRunOverrides(
            opts.disableAutorun,
            opts.enableAutorun,
          );
          if (Object.keys(parsed).length > 0) autoRunOverrides = parsed;
        }

        const updated = await updateTask(
          {
            taskId: id,
            title: opts.title,
            description: opts.description,
            status: opts.status,
            sessionId: opts.sessionId,
            autoRunOverrides,
          },
          {
            taskStore: deps.taskStore,
            queue: deps.queue,
            configStore: deps.configStore,
          },
        );
        printJSON(updated);
      },
    );

  task
    .command('delete [id]')
    .option('-y, --yes', 'skip confirmation')
    .action(async (id: string | undefined, opts: { yes?: boolean }) => {
      const taskID = await resolveTaskID({
        id,
        taskStore: deps.taskStore,
        title: 'Select task to delete',
        filter: allTasks,
      });
      if (!opts.yes) {
        const ok = await confirm(`Delete task ${taskID}?`, false);
        if (!ok) {
          printJSON({ deleted: null, cancelled: true });
          return;
        }
      }
      const result = await deleteTask(taskID, {
        repoDir: deps.repoDir,
        taskStore: deps.taskStore,
        interactions: deps.interactionStore,
      });
      printJSON({ deleted: result.taskId, cleanup: result.cleanup });
    });

  task
    .command('start [id]')
    .alias('run')
    .option('-T, --tool <tool>', 'tool override')
    .option('-M, --model <model>', 'model override')
    .action(
      async (
        id: string | undefined,
        opts: { tool?: string; model?: string },
      ) => {
        const taskID = await resolveTaskID({
          id,
          taskStore: deps.taskStore,
          title: 'Select task to start',
          filter: pendingTasks,
        });
        const result = await enqueueEvaluate(taskID, opts, {
          taskStore: deps.taskStore,
          queue: deps.queue,
        });
        printJSON({ ...result, status: 'queued' });
      },
    );

  task.command('stop [id]').action(async (id?: string) => {
    const taskID = await resolveTaskID({
      id,
      taskStore: deps.taskStore,
      title: 'Select running task to stop',
      filter: runningTasks,
    });
    const result = await stopTask(taskID, {
      taskStore: deps.taskStore,
      queue: deps.queue,
    });
    printJSON(result);
  });

  task
    .command('resume [id]')
    .option('-f, --feedback <feedback>', 'reviewer feedback', '')
    .option('-T, --tool <tool>', 'tool override')
    .option('-M, --model <model>', 'model override')
    .action(
      async (
        id: string | undefined,
        opts: { feedback?: string; tool?: string; model?: string },
      ) => {
        const taskID = await resolveTaskID({
          id,
          taskStore: deps.taskStore,
          title: 'Select stopped task to resume',
          filter: stoppedTasks,
        });
        let feedback = (opts.feedback ?? '').trim();
        if (!feedback && canPrompt()) {
          feedback = await textInput('Reviewer feedback for resume (optional)');
        }
        const result = await resumeTask(taskID, feedback, opts, {
          taskStore: deps.taskStore,
          queue: deps.queue,
        });
        printJSON({ ...result, status: 'queued' });
      },
    );

  task.command('approve [id]').action(async (id?: string) => {
    const taskID = await resolveTaskID({
      id,
      taskStore: deps.taskStore,
      title: 'Select task to approve',
      filter: reviewTasks,
    });
    const updated = await approveTask(taskID, {
      taskStore: deps.taskStore,
      queue: deps.queue,
      configStore: deps.configStore,
    });
    printJSON(updated);
  });

  task.command('approve-plan <id>').action(async (id: string) => {
    const updated = await approvePlan(id, {
      taskStore: deps.taskStore,
      queue: deps.queue,
      configStore: deps.configStore,
    });
    printJSON(updated);
  });

  task
    .command('request-changes [id]')
    .alias('rc')
    .option('-f, --feedback <feedback>', 'reviewer feedback')
    .option('-T, --tool <tool>', 'tool override')
    .option('-M, --model <model>', 'model override')
    .action(
      async (
        id: string | undefined,
        opts: { feedback?: string; tool?: string; model?: string },
      ) => {
        const taskID = await resolveTaskID({
          id,
          taskStore: deps.taskStore,
          title: 'Select task to request changes',
          filter: reviewTasks,
        });
        let feedback = (opts.feedback ?? '').trim();
        if (!feedback) {
          feedback = await textInput('Review feedback', { required: true });
        }
        const result = await requestChanges(taskID, feedback, {
          taskStore: deps.taskStore,
          interactionStore: deps.interactionStore,
          queue: deps.queue,
          tool: opts.tool,
          model: opts.model,
        });
        printJSON({ ...result, status: 'queued' });
      },
    );

  task
    .command('evaluate [id]')
    .option('-T, --tool <tool>', 'tool override')
    .option('-M, --model <model>', 'model override')
    .action(
      async (
        id: string | undefined,
        opts: { tool?: string; model?: string },
      ) => {
        const taskID = await resolveTaskID({
          id,
          taskStore: deps.taskStore,
          title: 'Select task to evaluate',
          filter: allTasks,
        });
        const result = await enqueueEvaluate(taskID, opts, {
          taskStore: deps.taskStore,
          queue: deps.queue,
        });
        printJSON({ ...result, status: 'queued' });
      },
    );

  task
    .command('breakdown [id]')
    .option('-T, --tool <tool>', 'tool override')
    .option('-M, --model <model>', 'model override')
    .action(
      async (
        id: string | undefined,
        opts: { tool?: string; model?: string },
      ) => {
        const taskID = await resolveTaskID({
          id,
          taskStore: deps.taskStore,
          title: 'Select task to break down',
          filter: pendingTasks,
        });
        const result = await enqueueBreakdown(taskID, opts, {
          taskStore: deps.taskStore,
          queue: deps.queue,
        });
        printJSON({ ...result, status: 'queued' });
      },
    );

  task
    .command('accept-breakdown [id]')
    .option('--operation <id>', 'interaction id from breakdown')
    .action(async (id: string | undefined, opts: { operation?: string }) => {
      const operationID = (opts.operation ?? '').trim();
      if (!operationID) throw new Error('--operation is required');
      const parentID = id?.trim() || null;
      const proposed = await loadProposedTasksFromInteraction(operationID, {
        interactions: deps.interactionStore,
      });
      if (proposed.length === 0) {
        throw new Error(
          'No proposed tasks found for interaction ' + operationID,
        );
      }
      const accepted = await acceptBreakdown(parentID, proposed, {
        taskStore: deps.taskStore,
        queue: deps.queue,
      });
      printJSON({
        created: accepted.createdIds.length,
        taskIds: accepted.createdIds,
        parentId: accepted.parentId,
        operationId: operationID,
      });
    });

  task
    .command('reject-breakdown')
    .option('--operation <id>', 'interaction id from breakdown')
    .action(async (opts: { operation?: string }) => {
      const operationID = (opts.operation ?? '').trim();
      if (!operationID) throw new Error('--operation is required');
      await rejectBreakdown('', operationID, {
        interactions: deps.interactionStore,
      });
      printJSON({ rejected: true, operationId: operationID });
    });

  task
    .command('provide-input [id]')
    .option('--answer <answer>', 'answer to pending question')
    .action(async (id: string | undefined, opts: { answer?: string }) => {
      const taskID = await resolveTaskID({
        id,
        taskStore: deps.taskStore,
        title: 'Select task with pending question',
        filter: stoppedTasks,
      });
      const taskItem = await deps.taskStore.get(taskID);
      if (!taskItem) throw new Error(`task not found: ${taskID}`);
      if (!taskItem.pendingQuestion) {
        throw new Error('task has no pending question');
      }
      console.log(`Question: ${taskItem.pendingQuestion}`);

      let answer = (opts.answer ?? '').trim();
      if (!answer) {
        if (!canPrompt())
          throw new Error('--answer is required in non-interactive mode');
        answer = await textInput('Your answer', { required: true });
      }

      const result = await provideInput(taskID, answer, {
        taskStore: deps.taskStore,
        queue: deps.queue,
      });
      printJSON(result);
    });

  task
    .command('wait [ids...]')
    .alias('w')
    .description('Wait for task(s) to reach a target status')
    .option('--any', 'wait for ANY task (ignores ids)')
    .option(
      '--until <statuses>',
      'comma-separated target statuses',
      'review,failed,stopped,merged',
    )
    .option('--auto', 'auto-determine wait targets from config auto-run flags')
    .option('--timeout <seconds>', 'max wait time in seconds', '600')
    .option('--poll <ms>', 'poll interval in ms', '3000')
    .action(
      async (
        ids: string[],
        opts: {
          any?: boolean;
          until: string;
          auto?: boolean;
          timeout: string;
          poll: string;
        },
      ) => {
        let targets: Set<string>;
        if (opts.auto) {
          const config = await deps.configStore.load();
          const waitStatuses: string[] = ['failed', 'stopped'];
          if (!isAutoRun(config, 'review')) {
            waitStatuses.push('review');
          } else if (!isAutoRun(config, 'merge')) {
            waitStatuses.push('approved');
          } else {
            waitStatuses.push('merged');
          }
          targets = new Set(waitStatuses);
        } else {
          targets = new Set(
            opts.until
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          );
        }
        const timeoutMs =
          Math.max(1, Number.parseInt(opts.timeout, 10) || 600) * 1000;
        const pollMs = Math.max(500, Number.parseInt(opts.poll, 10) || 3000);
        const watchIds = ids.map((id) => id.trim()).filter(Boolean);
        const watchAny = opts.any || watchIds.length === 0;
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
          const tasks = watchAny
            ? await deps.taskStore.list()
            : await Promise.all(watchIds.map((id) => deps.taskStore.get(id)));

          for (const t of tasks) {
            if (!t) continue;
            if (targets.has(t.status)) {
              printJSON({ timedOut: false, task: t });
              return;
            }
          }

          await new Promise((r) => setTimeout(r, pollMs));
        }

        const allTasksList = await deps.taskStore.list();
        const counts = {
          queued: 0,
          running: 0,
          review: 0,
          pending: 0,
          stopped: 0,
          failed: 0,
          merged: 0,
        };
        for (const t of allTasksList) {
          if (t.status in counts) counts[t.status as keyof typeof counts]++;
        }
        const watching = watchAny
          ? allTasksList
              .filter(
                (t) => t.status !== 'merged' && t.status !== 'broken_down',
              )
              .map((t) => t.id)
          : watchIds;

        printJSON({
          timedOut: true,
          tasks: counts,
          watching,
          note: `timed out after ${opts.timeout}s, still processing`,
        });
      },
    );

  task.command('reviews <id>').action(async (id: string) => {
    printJSON(await deps.taskStore.listReviews(id));
  });

  task
    .command('interactions <id>')
    .option('--type <type>', 'type filter')
    .action(async (id: string, opts: { type?: string }) => {
      const type = (opts.type ?? '').trim();
      const data = type
        ? await deps.interactionStore.listByType(id, type)
        : await deps.interactionStore.list(id);
      printJSON(data);
    });

  const depsCmd = task.command('deps').description('Manage task dependencies');
  depsCmd
    .command('add <id> <dependsOn>')
    .action(async (id: string, dependsOn: string) => {
      await deps.taskStore.addDependency(id, dependsOn);
      printJSON(await deps.taskStore.get(id));
    });
  depsCmd
    .command('remove <id> <dependsOn>')
    .action(async (id: string, dependsOn: string) => {
      await deps.taskStore.removeDependency(id, dependsOn);
      printJSON(await deps.taskStore.get(id));
    });

  const planCmd = task.command('plan').description('Task plan commands');
  planCmd.command('get <id>').action(async (id: string) => {
    printJSON({ taskId: id, plan: await deps.taskStore.getPlan(id) });
  });
  planCmd
    .command('set <id>')
    .option('--text <text>', 'plan text')
    .option('--file <path>', 'read plan text from file')
    .action(async (id: string, opts: { text?: string; file?: string }) => {
      const fromText = (opts.text ?? '').trim();
      let fromFile = '';
      if (opts.file?.trim()) {
        fromFile = (await Bun.file(opts.file.trim()).text()).trim();
      }
      const content = fromText || fromFile;
      await deps.taskStore.setPlan(id, content);
      printJSON({ taskId: id, plan: content });
    });

  task
    .command('merge [id]')
    .alias('mg')
    .description('Merge a task into integration branch')
    .action(async (id?: string) => {
      const taskID = await resolveTaskID({
        id,
        taskStore: deps.taskStore,
        title: 'Select task to merge',
        filter: (t) => t.status === 'approved' || t.status === 'review',
      });
      const result = await enqueueMerge(taskID, {
        taskStore: deps.taskStore,
        queue: deps.queue,
      });
      printJSON({ ...result, status: 'queued' });
    });

  task
    .command('ai-review [id]')
    .alias('ar')
    .option('-T, --tool <tool>', 'review tool')
    .option('-M, --model <model>', 'review model')
    .option('--prompt <prompt>', 'additional review instructions')
    .action(
      async (
        id: string | undefined,
        opts: { tool?: string; model?: string; prompt?: string },
      ) => {
        const taskID = await resolveTaskID({
          id,
          taskStore: deps.taskStore,
          title: 'Select task for AI review',
          filter: reviewTasks,
        });
        const result = await triggerReview(taskID, opts, {
          taskStore: deps.taskStore,
          interactionStore: deps.interactionStore,
          queue: deps.queue,
        });
        printJSON({ ...result, status: 'queued' });
      },
    );
}

async function resolveTaskID(input: {
  id?: string;
  taskStore: TaskStore;
  title: string;
  filter: (task: Task) => boolean;
}): Promise<string> {
  const taskID = (input.id ?? '').trim();
  if (taskID) return taskID;
  if (!canPrompt()) {
    throw new Error('task id required in non-interactive mode');
  }
  const picked = await pickTask(input.taskStore, input.title, input.filter);
  return picked.id;
}

function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY) && !Bun.argv.includes('--json');
}

function parseAutoRunOverrides(
  disable?: string,
  enable?: string,
): AutoRunOverrides {
  const overrides: AutoRunOverrides = {};
  const validTypes = new Set<string>(INTERACTION_TYPES);
  for (const raw of (disable ?? '').split(',')) {
    const type = raw.trim() as InteractionType;
    if (type && validTypes.has(type)) overrides[type] = false;
  }
  for (const raw of (enable ?? '').split(',')) {
    const type = raw.trim() as InteractionType;
    if (type && validTypes.has(type)) overrides[type] = true;
  }
  return overrides;
}

function mergeAutoRunOverrides(
  existing: AutoRunOverrides,
  disable?: string,
  enable?: string,
  reset?: string | true,
): AutoRunOverrides {
  const validTypes = new Set<string>(INTERACTION_TYPES);
  let result = { ...existing };

  if (reset === true || reset === 'all' || reset === '') {
    result = {};
  } else if (reset) {
    for (const raw of reset.split(',')) {
      const type = raw.trim() as InteractionType;
      if (type && validTypes.has(type)) delete result[type];
    }
  }

  for (const raw of (disable ?? '').split(',')) {
    const type = raw.trim() as InteractionType;
    if (type && validTypes.has(type)) result[type] = false;
  }
  for (const raw of (enable ?? '').split(',')) {
    const type = raw.trim() as InteractionType;
    if (type && validTypes.has(type)) result[type] = true;
  }
  return result;
}
