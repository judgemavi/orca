import type { Command } from 'commander';
import { isAutoRun } from '../../config/config';
import { mergeTaskWithGit } from '../../domain/integrator';
import { triggerPostMergeHooks } from '../../domain/post-merge';
import type { Executor } from '../../executor/executor';
import type { ToolPluginRegistry } from '../../plugin/registry';
import { unblockDependents } from '../../queue/chain';
import { isDaemonRunning } from '../../queue/lock';
import type { JobQueue } from '../../queue/queue';
import type { ConfigStore } from '../../store/config';
import type { InteractionStore } from '../../store/interactions';
import type { MemoryStore } from '../../store/memory';
import type { TaskStore } from '../../store/tasks';
import type {
  AutoRunOverrides,
  InteractionType,
  Task,
  TaskStatus,
} from '../../types';
import { INTERACTION_TYPES, JOB_PRIORITIES } from '../../types';
import { deleteTask } from '../../workflows/delete';
import {
  acceptBreakdown,
  approvePlan,
  breakdownTask,
  evaluateTaskWorkflow,
  loadProposedTasksFromInteraction,
  rejectBreakdown,
  requestPlanChanges,
} from '../../workflows/planning';
import {
  approveTask,
  requestChanges,
  runAIReviewWorkflow,
} from '../../workflows/review';
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
        const created = await deps.taskStore.create({
          title,
          description,
          parentId: parent || null,
          autoRunOverrides:
            Object.keys(autoRunOverrides).length > 0
              ? autoRunOverrides
              : undefined,
        });

        if (dependsOn.length > 0) {
          await deps.taskStore.updateDependencies(created.id, dependsOn);
        }

        const serverUp = isDaemonRunning(deps.repoDir);
        if (deps.queue && dependsOn.length === 0 && serverUp) {
          await deps.queue.enqueue({
            type: 'evaluate',
            taskId: created.id,
            priority: JOB_PRIORITIES.evaluate,
          });
        }
        const result = await deps.taskStore.get(created.id);
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

        await deps.taskStore.update(id, {
          title: opts.title,
          description: opts.description,
          status: opts.status as TaskStatus,
          sessionId: opts.sessionId,
          ...(autoRunOverrides !== undefined ? { autoRunOverrides } : {}),
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
    .alias('run')
    .option('-T, --tool <tool>', 'tool override')
    .option('-M, --model <model>', 'model override')
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
    .alias('rc')
    .option('-f, --feedback <feedback>', 'reviewer feedback')
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

      const updatedDescription = taskItem.description
        ? `${taskItem.description}\n\n---\n**User clarification:** ${answer}`
        : `**User clarification:** ${answer}`;

      await deps.taskStore.update(taskID, {
        description: updatedDescription,
        pendingQuestion: null,
        status: 'pending',
      });

      if (deps.queue) {
        await deps.queue.enqueue({
          type: 'evaluate',
          taskId: taskID,
          priority: JOB_PRIORITIES.evaluate,
        });
      }
      printJSON({ taskId: taskID, status: 'queued' });
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
          // Walk the chain: review → merge → retro
          // Wait at the first step where auto-run is OFF, or at merged if all auto
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

          for (const task of tasks) {
            if (!task) continue;
            if (targets.has(task.status)) {
              printJSON({ timedOut: false, task });
              return;
            }
          }

          await new Promise((r) => setTimeout(r, pollMs));
        }

        // Timeout — return current state
        const allTasks = await deps.taskStore.list();
        const counts = {
          queued: 0,
          running: 0,
          review: 0,
          pending: 0,
          stopped: 0,
          failed: 0,
          merged: 0,
        };
        for (const t of allTasks) {
          if (t.status in counts) counts[t.status as keyof typeof counts]++;
        }
        const watching = watchAny
          ? allTasks
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

  planCmd
    .command('generate')
    .option('--goal <goal>', 'planning goal')
    .option('-T, --tool <tool>', 'tool name')
    .option('-M, --model <model>', 'model name')
    .action(async (opts: { goal?: string; tool?: string; model?: string }) => {
      let goal = (opts.goal ?? '').trim();
      if (!goal) {
        if (!canPrompt())
          throw new Error('--goal is required in non-interactive mode');
        goal = await textInput('Planning goal', { required: true });
      }
      const breakdown = await breakdownTask(
        { goal },
        { taskStore: deps.taskStore },
      );
      const interaction = await deps.interactionStore.begin({
        taskId: null,
        type: 'breakdown',
        tool: (opts.tool ?? '').trim() || 'planner',
      });
      await deps.interactionStore.finish(interaction.id, {
        status: 'completed',
        model: (opts.model ?? '').trim() || '',
        qualityJson: JSON.stringify({ goal, proposed: breakdown.proposed }),
      });
      printJSON({
        status: 'breaking_down',
        operationId: interaction.id,
        proposed: breakdown.proposed,
      });
    });

  planCmd
    .command('accept')
    .option('--operation <id>', 'operation interaction id')
    .action(async (opts: { operation?: string }) => {
      const operationID = (opts.operation ?? '').trim();
      if (!operationID) throw new Error('--operation is required');
      const proposed = await loadProposedTasksFromInteraction(operationID, {
        interactions: deps.interactionStore,
      });
      const accepted = await acceptBreakdown(null, proposed, {
        taskStore: deps.taskStore,
      });
      printJSON({
        created: accepted.createdIds.length,
        taskIds: accepted.createdIds,
        operationId: operationID,
      });
    });

  planCmd
    .command('reject')
    .option('--operation <id>', 'operation interaction id')
    .action(async (opts: { operation?: string }) => {
      const operationID = (opts.operation ?? '').trim();
      if (!operationID) throw new Error('--operation is required');
      await rejectBreakdown('', operationID, {
        interactions: deps.interactionStore,
      });
      printJSON({ rejected: true, operationId: operationID });
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
        if (deps.queue) {
          await unblockDependents(taskID, {
            configStore: deps.configStore,
            taskStore: deps.taskStore,
            queue: deps.queue,
          });
        }
      } else {
        await deps.taskStore.updateStatus(taskID, 'failed');
      }
      printJSON(result);
    });

  task
    .command('request-plan-changes [id]')
    .alias('rpc')
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
        const result = await runAIReviewWorkflow(taskID, {
          repoDir: deps.repoDir,
          configStore: deps.configStore,
          registry: deps.registry,
          taskStore: deps.taskStore,
          interactions: deps.interactionStore,
          prompt: opts.prompt ?? '',
          toolOverride: opts.tool ?? '',
          modelOverride: opts.model ?? '',
        });
        printJSON(result);
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
