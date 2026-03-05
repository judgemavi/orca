import { watch } from 'node:fs';
import type { Command } from 'commander';
import { mergeTaskWithGit } from '../../domain/integrator';
import { triggerPostMergeHooks } from '../../domain/post-merge';
import type { Executor } from '../../executor/executor';
import type { ToolPluginRegistry } from '../../plugin/registry';
import type { JobQueue } from '../../queue/queue';
import type { ConfigStore } from '../../store/config';
import type { InteractionStore } from '../../store/interactions';
import type { MemoryStore } from '../../store/memory';
import type { TaskStore } from '../../store/tasks';
import type { Task, TaskStatus } from '../../types';
import { JOB_PRIORITIES } from '../../types';
import { deleteTask } from '../../workflows/delete';
import {
  approvePlan,
  breakdownTask,
  evaluateTaskWorkflow,
  requestPlanChanges,
} from '../../workflows/planning';
import { approveTask, requestChanges } from '../../workflows/review';
import {
  resumeTask,
  startTask,
  startTasks,
  stopTask,
} from '../../workflows/run';
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

export function registerTaskCommands(
  task: Command,
  deps: {
    repoDir: string;
    taskStore: TaskStore;
    interactionStore: InteractionStore;
    memoryStore: MemoryStore;
    configStore: ConfigStore;
    registry: ToolPluginRegistry;
    executor: Executor;
    queue?: JobQueue;
  },
) {
  task
    .command('list')
    .option('--status <status>', 'filter by status')
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

  task.command('get <id>').action(async (id: string) => {
    const taskItem = await deps.taskStore.get(id);
    if (!taskItem) throw new Error(`task not found: ${id}`);
    printJSON(taskItem);
  });

  task
    .command('create')
    .option('--title <title>', 'task title')
    .option('--description <description>', 'task description', '')
    .option('--parent <parent>', 'parent task id')
    .action(
      async (opts: {
        title?: string;
        description: string;
        parent?: string;
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

        const created = await deps.taskStore.create({
          title,
          description,
          parentId: parent || null,
        });
        if (deps.queue) {
          await deps.queue.enqueue({
            type: 'evaluate',
            taskId: created.id,
            priority: JOB_PRIORITIES.evaluate,
          });
          console.log('Evaluation queued.');
        }
        printJSON(created);
      },
    );

  task
    .command('update <id>')
    .option('--title <title>', 'new title')
    .option('--description <description>', 'new description')
    .option('--status <status>', 'new status')
    .option('--session-id <sessionID>', 'set session id')
    .action(
      async (
        id: string,
        opts: {
          title?: string;
          description?: string;
          status?: string;
          sessionId?: string;
        },
      ) => {
        await deps.taskStore.update(id, {
          title: opts.title,
          description: opts.description,
          status: opts.status as TaskStatus,
          sessionId: opts.sessionId,
        });
        printJSON(await deps.taskStore.get(id));
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
    .option('--tool <tool>', 'tool override')
    .option('--model <model>', 'model override')
    .option('--context <context>', 'extra context')
    .action(
      async (
        id: string | undefined,
        opts: { tool?: string; model?: string; context?: string },
      ) => {
        const taskID = await resolveTaskID({
          id,
          taskStore: deps.taskStore,
          title: 'Select task to start',
          filter: pendingTasks,
        });
        const result = await startTask(deps.executor, taskID, {
          toolOverride: opts.tool ?? '',
          modelOverride: opts.model ?? '',
          context: opts.context ?? '',
        });
        printJSON(result);
      },
    );

  task.command('start-pending').action(async () => {
    const result = await startTasks(deps.executor);
    printJSON(result);
  });

  task.command('stop [id]').action(async (id?: string) => {
    const taskID = await resolveTaskID({
      id,
      taskStore: deps.taskStore,
      title: 'Select running task to stop',
      filter: runningTasks,
    });
    await stopTask(deps.executor, deps.taskStore, taskID);
    printJSON({ taskId: taskID, status: 'stopped' });
  });

  task
    .command('resume [id]')
    .option('--feedback <feedback>', 'reviewer feedback', '')
    .option('--tool <tool>', 'tool override')
    .option('--model <model>', 'model override')
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
        const result = await resumeTask(
          deps.executor,
          deps.taskStore,
          taskID,
          feedback,
          {
            toolOverride: opts.tool ?? '',
            modelOverride: opts.model ?? '',
          },
        );
        printJSON(result);
      },
    );

  task.command('approve [id]').action(async (id?: string) => {
    const taskID = await resolveTaskID({
      id,
      taskStore: deps.taskStore,
      title: 'Select task to approve',
      filter: reviewTasks,
    });
    const updated = await approveTask(taskID, { taskStore: deps.taskStore });
    printJSON(updated);
  });

  task.command('approve-plan <id>').action(async (id: string) => {
    const updated = await approvePlan(id, { taskStore: deps.taskStore });
    printJSON(updated);
  });

  task
    .command('request-changes [id]')
    .option('--feedback <feedback>', 'reviewer feedback')
    .action(async (id: string | undefined, opts: { feedback?: string }) => {
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
        interactions: deps.interactionStore,
        executor: deps.executor,
      });
      printJSON(result);
    });

  task.command('evaluate [id]').action(async (id?: string) => {
    const taskID = await resolveTaskID({
      id,
      taskStore: deps.taskStore,
      title: 'Select task to evaluate',
      filter: allTasks,
    });
    const evaluation = await evaluateTaskWorkflow(taskID, {
      repoDir: deps.repoDir,
      taskStore: deps.taskStore,
      interactions: deps.interactionStore,
      configStore: deps.configStore,
      registry: deps.registry,
    });
    printJSON(evaluation);
  });

  task.command('breakdown [id]').action(async (id?: string) => {
    const taskID = await resolveTaskID({
      id,
      taskStore: deps.taskStore,
      title: 'Select task to break down',
      filter: pendingTasks,
    });
    const breakdown = await breakdownTask(
      { taskId: taskID },
      { taskStore: deps.taskStore },
    );
    printJSON(breakdown.proposed);
  });

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
    .description('Merge a task into integration branch')
    .action(async (id?: string) => {
      const taskID = await resolveTaskID({
        id,
        taskStore: deps.taskStore,
        title: 'Select task to merge',
        filter: (t) => t.status === 'approved' || t.status === 'review',
      });
      const config = await deps.configStore.load();
      const result = await mergeTaskWithGit(taskID, {
        repoDir: deps.repoDir,
        integrationBranch: config.project.integrationBranch,
        validationCommands: config.validation.commands,
        taskStore: deps.taskStore,
      });
      if (result.status === 'merged') {
        await deps.taskStore.updateStatus(taskID, 'merged');
        triggerPostMergeHooks(taskID, {
          repoDir: deps.repoDir,
          taskStore: deps.taskStore,
          interactions: deps.interactionStore,
          memoryStore: deps.memoryStore,
          configStore: deps.configStore,
        });
      } else {
        await deps.taskStore.updateStatus(taskID, 'failed');
      }
      printJSON(result);
    });

  task
    .command('request-plan-changes [id]')
    .description('Add plan feedback and regenerate plan')
    .requiredOption('--feedback <feedback>', 'plan feedback')
    .action(async (id: string | undefined, opts: { feedback: string }) => {
      const taskID = await resolveTaskID({
        id,
        taskStore: deps.taskStore,
        title: 'Select task for plan changes',
        filter: pendingTasks,
      });
      const feedback = opts.feedback.trim();
      if (!feedback) throw new Error('feedback is required');

      const result = await requestPlanChanges(taskID, feedback, {
        repoDir: deps.repoDir,
        taskStore: deps.taskStore,
        interactions: deps.interactionStore,
        configStore: deps.configStore,
        registry: deps.registry,
        memory: deps.memoryStore,
      });
      printJSON({
        taskId: taskID,
        reviewId: result.reviewId,
        plan: result.plan,
      });
    });

  task
    .command('logs [id]')
    .description('View task interaction logs')
    .option('--type <type>', 'filter by interaction type')
    .option('--attempt <n>', 'filter by attempt number')
    .option('--json', 'raw JSON output')
    .option('--follow', 'tail the log file')
    .action(
      async (
        id: string | undefined,
        opts: {
          type?: string;
          attempt?: string;
          json?: boolean;
          follow?: boolean;
        },
      ) => {
        const taskID = await resolveTaskID({
          id,
          taskStore: deps.taskStore,
          title: 'Select task for logs',
          filter: allTasks,
        });

        const type = (opts.type ?? '').trim();
        const attempt = opts.attempt ? Number(opts.attempt) : undefined;

        let interactions = type
          ? await deps.interactionStore.listByType(taskID, type)
          : await deps.interactionStore.list(taskID);

        if (attempt !== undefined) {
          interactions = interactions.filter((i) => i.attempt === attempt);
        }

        if (interactions.length === 0) {
          throw new Error(
            `no interactions found for task ${taskID}${type ? ` type=${type}` : ''}${attempt !== undefined ? ` attempt=${attempt}` : ''}`,
          );
        }

        if (opts.json) {
          console.log(JSON.stringify(interactions, null, 2));
          return;
        }

        const latest = interactions[0]!;
        const content = await deps.interactionStore.readLog(latest.id);
        console.log(content);

        if (opts.follow) {
          const row = await deps.interactionStore.get(latest.id);
          if (!row?.logPath) return;
          const logPath = row.logPath;
          let offset = content.length;
          const watcher = watch(logPath, async () => {
            const full = await Bun.file(logPath)
              .text()
              .catch(() => '');
            if (full.length > offset) {
              process.stdout.write(full.slice(offset));
              offset = full.length;
            }
          });
          process.on('SIGINT', () => {
            watcher.close();
            process.exit(0);
          });
          await new Promise(() => {});
        }
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
