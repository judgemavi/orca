import { TASK_STATUSES, type TaskStatus } from '@orca/types';
import type { Command } from 'commander';
import { isAutoRun } from '../../config/config';
import { isDaemonRunning } from '../../queue/lock';
import { gitRun } from '../../shared/git';
import * as configStore from '../../store/config';
import * as taskStore from '../../store/tasks';
import type { AutoRunOverrides } from '../../types/api';
import type { AppDeps } from '../../types/deps';
import { getStepOutput, hasStepOutput } from '../../workflow/context';
import { completeStep, resolveStepMeta } from '../../workflow/engine';
import { getTransitionEvents } from '../../workflow/paths';
import type { AnyStateNode } from '../../workflow/paths';
import type { StepMeta } from '../../workflow/types';
import {
  createSyntheticStepInteraction,
  loadCurrentTaskStep,
} from '../../workflow/step-actions';
import { deleteTask } from '../../workflows/delete';
import {
  acceptBreakdown,
  loadProposedTasksFromInteraction,
  rejectBreakdown,
} from '../../workflows/planning';
import { resetToStep } from '../../workflows/rewind';
import {
  createTask,
  enqueueBreakdown,
  enqueueCurrentStep,
  enqueueEvaluate,
  provideInput,
  stopTask,
  updateTask,
} from '../../workflows/tasks';
import { printJSON } from '../format';

export function registerTaskCommands(task: Command, deps: AppDeps) {
  task
    .command('list')
    .alias('ls')
    .option('-s, --status <status>', 'filter by status')
    .action(async (opts: { status?: string }) => {
      const status = (opts.status ?? '').trim();
      const data = status
        ? await taskStore.listTasks(deps.db, status as TaskStatus)
        : await taskStore.listTasks(deps.db);
      printJSON(data);
    });

  task.command('ready').action(async () => {
    printJSON(await taskStore.getReadyTasks(deps.db));
  });

  task
    .command('get <id>')
    .alias('g')
    .action(async (id: string) => {
      const taskItem = await taskStore.getTask(deps.db, id).catch(() => null);
      if (!taskItem) throw new Error(`task not found: ${id}`);
      printJSON(taskItem);
    });

  task
    .command('create')
    .alias('new')
    .requiredOption('-t, --title <title>', 'task title')
    .option('-d, --description <description>', 'task description', '')
    .option('--parent <parent>', 'parent task id')
    .option(
      '--depends-on <ids>',
      'comma-separated task IDs this task depends on',
    )
    .option(
      '--disable-autorun <steps>',
      'per-task override: comma-separated step names to disable auto-run (e.g. review,merge)',
    )
    .option(
      '--enable-autorun <steps>',
      'per-task override: comma-separated step names to enable auto-run',
    )
    .action(
      async (opts: {
        title: string;
        description: string;
        parent?: string;
        dependsOn?: string;
        disableAutorun?: string;
        enableAutorun?: string;
      }) => {
        const title = opts.title.trim();
        if (!title) throw new Error('--title is required');

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
            description: opts.description,
            parentId: (opts.parent ?? '').trim() || null,
            dependsOn,
            autoRunOverrides:
              Object.keys(autoRunOverrides).length > 0
                ? autoRunOverrides
                : undefined,
          },
          {
            db: deps.db,
            sink: deps.sink,
            queue: serverUp ? deps.queue : undefined,
            workflowStore: deps.workflowStore,
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
      '--disable-autorun <steps>',
      'per-task override: comma-separated step names to disable auto-run',
    )
    .option(
      '--enable-autorun <steps>',
      'per-task override: comma-separated step names to enable auto-run',
    )
    .option(
      '--reset-autorun [steps]',
      'clear per-task overrides, inherit from workflow def (comma-separated or "all")',
    )
    .action(
      async (
        id: string,
        opts: {
          title?: string;
          description?: string;
          status?: string;
          disableAutorun?: string;
          enableAutorun?: string;
          resetAutorun?: string | true;
        },
      ) => {
        let autoRunOverrides: AutoRunOverrides | undefined;
        if (opts.resetAutorun !== undefined) {
          const existing = await taskStore
            .getTask(deps.db, id)
            .catch(() => null);
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
            autoRunOverrides,
          },
          {
            db: deps.db,
            sink: deps.sink,
            queue: deps.queue,
          },
        );
        printJSON(updated);
      },
    );

  task.command('delete <id>').action(async (id: string) => {
    const result = await deleteTask(id, {
      repoDir: deps.repoDir,
      db: deps.db,
      sink: deps.sink,
      interactions: deps.interactionStore,
    });
    printJSON({ deleted: result.taskId, cleanup: result.cleanup });
  });

  task.command('stop <id>').action(async (id: string) => {
    const result = await stopTask(id, {
      db: deps.db,
      sink: deps.sink,
      queue: deps.queue,
    });
    printJSON(result);
  });

  task
    .command('evaluate <id>')
    .option('-T, --tool <tool>', 'tool override')
    .option('-M, --model <model>', 'model override')
    .action(async (id: string, opts: { tool?: string; model?: string }) => {
      const result = await enqueueEvaluate(id, opts, {
        db: deps.db,
        sink: deps.sink,
        queue: deps.queue,
      });
      printJSON({ ...result, status: 'queued' });
    });

  task
    .command('breakdown <id>')
    .option('-T, --tool <tool>', 'tool override')
    .option('-M, --model <model>', 'model override')
    .action(async (id: string, opts: { tool?: string; model?: string }) => {
      const result = await enqueueBreakdown(id, opts, {
        db: deps.db,
        sink: deps.sink,
        queue: deps.queue,
      });
      printJSON({ ...result, status: 'queued' });
    });

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
          `No proposed tasks found for interaction ${operationID}`,
        );
      }
      const accepted = await acceptBreakdown(parentID, proposed, {
        db: deps.db,
        sink: deps.sink,
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
    .command('reset <id>')
    .description(
      'Reset task to a previous interaction (deletes later interactions, reverts git)',
    )
    .requiredOption('--interaction <interactionId>', 'interaction to reset to')
    .option('--run', 'also enqueue the step for re-execution')
    .action(
      async (id: string, opts: { interaction: string; run?: boolean }) => {
        const result = await resetToStep(
          { taskId: id, interactionId: opts.interaction, enqueue: opts.run },
          {
            interactionStore: deps.interactionStore,
            queue: deps.queue,
            repoDir: deps.repoDir,
            db: deps.db,
          },
        );
        printJSON(result);
      },
    );

  task
    .command('diff <id>')
    .description('Show git diff for an interaction (from commitSha)')
    .requiredOption(
      '--interaction <interactionId>',
      'interaction to get diff for',
    )
    .action(async (id: string, opts: { interaction: string }) => {
      const interaction = await deps.interactionStore.get(opts.interaction);
      if (!interaction || interaction.taskId !== id) {
        throw new Error('interaction not found');
      }
      const sha = interaction.commitSha?.trim();
      if (!sha) {
        printJSON({ diff: '', filesChanged: [] });
        return;
      }
      try {
        const [diffResult, namesResult] = await Promise.all([
          gitRun(deps.repoDir, ['diff', `${sha}~1..${sha}`]),
          gitRun(deps.repoDir, ['diff', `${sha}~1..${sha}`, '--name-only']),
        ]);
        printJSON({
          diff: diffResult.exitCode === 0 ? diffResult.stdout : '',
          filesChanged:
            namesResult.exitCode === 0
              ? namesResult.stdout
                  .split('\n')
                  .map((f: string) => f.trim())
                  .filter(Boolean)
              : [],
        });
      } catch {
        printJSON({ diff: '', filesChanged: [] });
      }
    });

  task
    .command('provide-input <id>')
    .requiredOption('--answer <answer>', 'answer to pending question')
    .action(async (id: string, opts: { answer: string }) => {
      const result = await provideInput(id, opts.answer, {
        db: deps.db,
        sink: deps.sink,
        queue: deps.queue,
        workflowStore: deps.workflowStore,
        interactionStore: deps.interactionStore,
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
          const config = await configStore.loadConfig(deps.db);
          const compiled = deps.workflowStore.resolve();
          const waitStatuses: string[] = ['failed', 'stopped'];
          let gated = false;
          const rootNode = compiled.machine.root as unknown as AnyStateNode;
          for (const [name, child] of Object.entries(rootNode.states ?? {})) {
            if (child.type === 'final') continue;
            const meta = (child.meta ?? {}) as StepMeta;
            if (
              !isAutoRun({
                config,
                stepName: name,
                stepAutoRun: meta.autoRun,
              })
            ) {
              waitStatuses.push('stopped');
              gated = true;
              break;
            }
          }
          if (!gated) waitStatuses.push('merged');
          targets = new Set(waitStatuses);
        } else {
          targets = new Set(
            opts.until
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          );
        }
        const knownStatuses = new Set(Object.values(TASK_STATUSES) as string[]);
        const statusTargets = new Set<string>();
        const stepTargets = new Set<string>();
        for (const t of targets) {
          if (knownStatuses.has(t)) statusTargets.add(t);
          else stepTargets.add(t);
        }

        const timeoutMs =
          Math.max(1, Number.parseInt(opts.timeout, 10) || 600) * 1000;
        const pollMs = Math.max(500, Number.parseInt(opts.poll, 10) || 3000);
        const watchIds = ids.map((id) => id.trim()).filter(Boolean);
        const watchAny = opts.any || watchIds.length === 0;
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
          const tasks = watchAny
            ? await taskStore.listTasks(deps.db)
            : await Promise.all(
                watchIds.map((id) =>
                  taskStore.getTask(deps.db, id).catch(() => null),
                ),
              );

          for (const t of tasks) {
            if (!t) continue;
            if (statusTargets.has(t.status)) {
              printJSON({ timedOut: false, task: t });
              return;
            }
            for (const step of stepTargets) {
              const interactions = await deps.interactionStore.listByType(
                t.id,
                step,
              );
              if (interactions.length === 0) continue;
              const latest = interactions[0];
              const anyRunning = interactions.some(
                (ix) => ix.status === 'running',
              );
              if (latest?.status === 'completed' && !anyRunning) {
                printJSON({ timedOut: false, task: t, completedStep: step });
                return;
              }
            }
          }

          await new Promise((r) => setTimeout(r, pollMs));
        }

        const allTasksList = await taskStore.listTasks(deps.db);
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
      await taskStore.addDependency(deps.db, deps.sink, id, dependsOn);
      printJSON(await taskStore.getTask(deps.db, id).catch(() => null));
    });
  depsCmd
    .command('remove <id> <dependsOn>')
    .action(async (id: string, dependsOn: string) => {
      await taskStore.removeDependency(deps.db, deps.sink, id, dependsOn);
      printJSON(await taskStore.getTask(deps.db, id).catch(() => null));
    });

  const stepCmd = task.command('step').description('Workflow step commands');
  stepCmd
    .command('output <id> <stepName>')
    .description('Get output from a completed workflow step')
    .action(async (id: string, stepName: string) => {
      const output = await getStepOutput(id, stepName, deps.interactionStore);
      printJSON({ taskId: id, stepName, output });
    });

  task
    .command('complete-step <id>')
    .alias('cs')
    .description('Complete current step with a specific outcome/branch')
    .requiredOption('-o, --outcome <outcome>', 'branch/outcome name')
    .option('--output <text>', 'output text to forward as feedback')
    .action(async (id: string, opts: { outcome: string; output?: string }) => {
      if (await deps.interactionStore.hasRunningForTask(id)) {
        throw new Error('a step is currently running — wait for it to complete');
      }
      const t = await taskStore.getTask(deps.db, id).catch(() => null);
      if (!t) throw new Error(`task not found: ${id}`);
      if (!t.currentStep) throw new Error('task has no current step');

      const compiled = deps.workflowStore.resolve(t.workflow ?? undefined);
      let stepMeta: StepMeta | undefined;
      try {
        stepMeta = resolveStepMeta(compiled.machine, t.currentStep).meta;
      } catch {
        stepMeta = undefined;
      }

      if (stepMeta?.type !== 'decision') {
        const has = await hasStepOutput(
          id,
          t.currentStep,
          deps.interactionStore,
        );
        if (!has) {
          throw new Error(
            `no completed output for step "${t.currentStep}" — run the step first`,
          );
        }
      }

      if (stepMeta?.type === 'decision') {
        const has = await hasStepOutput(
          id,
          t.currentStep,
          deps.interactionStore,
        );
        if (!has) {
          const ix = await deps.interactionStore.begin({
            taskId: id,
            type: t.currentStep,
            tool: 'manual',
          });
          await deps.interactionStore.finish(ix.id, {
            status: 'completed',
            output: JSON.stringify({
              result: opts.outcome,
              output: opts.output ?? '',
            }),
            durationMs: 0,
          });
        }
      }

      const result = await completeStep(
        id,
        opts.outcome,
        {
          db: deps.db,
          sink: deps.sink,
          queue: deps.queue,
          workflowStore: deps.workflowStore,
        },
        opts.output ? { output: opts.output } : undefined,
      );
      printJSON({ taskId: id, outcome: opts.outcome, ...result });
    });

  task
    .command('manual-step <id>')
    .alias('ms')
    .description('Manually provide output for a context or decision step')
    .requiredOption('--output <text>', 'the output text')
    .option('-o, --outcome <outcome>', 'outcome/branch name')
    .action(async (id: string, opts: { output: string; outcome?: string }) => {
      if (await deps.interactionStore.hasRunningForTask(id)) {
        throw new Error('a step is currently running — wait for it to complete');
      }
      const { currentStep, step, stateNode } = await loadCurrentTaskStep(id, {
        db: deps.db,
        workflowStore: deps.workflowStore,
      });
      if (step.type !== 'context' && step.type !== 'decision') {
        throw new Error(
          `step "${currentStep}" (type: ${step.type}) does not support manual entry`,
        );
      }

      const branchNames = stateNode ? getTransitionEvents(stateNode) : [];
      const outcome = opts.outcome ?? branchNames[0] ?? 'done';
      const interactionId = await createSyntheticStepInteraction(
        deps.interactionStore,
        {
          taskId: id,
          stepName: currentStep,
          outcome,
          output: opts.output,
        },
      );

      const result = await completeStep(id, outcome, {
        db: deps.db,
        sink: deps.sink,
        queue: deps.queue,
        workflowStore: deps.workflowStore,
      });

      printJSON({
        taskId: id,
        interactionId,
        step: currentStep,
        outcome,
        ...result,
      });
    });

  stepCmd
    .command('list <id>')
    .alias('ls')
    .description('List workflow steps for a task')
    .action(async (id: string) => {
      const t = await taskStore.getTask(deps.db, id).catch(() => null);
      if (!t) throw new Error(`task not found: ${id}`);

      const compiled = await deps.workflowStore.resolve(
        t.workflow ?? undefined,
      );
      const steps: Record<string, { type: string; executor: string | null }> =
        {};
      const rootNode = compiled.machine.root as unknown as AnyStateNode;
      for (const [name, child] of Object.entries(rootNode.states ?? {})) {
        if (child.type === 'final') continue;
        const meta = (child.meta ?? {}) as StepMeta;
        steps[name] = { type: meta.type ?? 'unknown', executor: meta.executor ?? null };
      }
      printJSON({
        taskId: id,
        workflow: compiled.name,
        currentStep: t.currentStep,
        steps,
      });
    });

  task
    .command('run-step <id>')
    .alias('rs')
    .description('Enqueue the current workflow step for execution')
    .option('-T, --tool <tool>', 'tool override')
    .option('-M, --model <model>', 'model override')
    .option('--prompt <prompt>', 'additional instructions')
    .option('-f, --feedback <feedback>', 'feedback when resuming a stopped task')
    .action(
      async (
        id: string,
        opts: {
          tool?: string;
          model?: string;
          prompt?: string;
          feedback?: string;
        },
      ) => {
        const result = await enqueueCurrentStep(
          id,
          {
            prompt: opts.prompt ?? '',
            tool: opts.tool ?? '',
            model: opts.model ?? '',
            ...(opts.feedback ? { feedback: opts.feedback } : {}),
          },
          { db: deps.db, sink: deps.sink, queue: deps.queue },
        );
        printJSON({ ...result, status: 'queued' });
      },
    );
}

function parseAutoRunOverrides(
  disable?: string,
  enable?: string,
): AutoRunOverrides {
  const overrides: AutoRunOverrides = {};
  for (const raw of (disable ?? '').split(',')) {
    const step = raw.trim();
    if (step) overrides[step] = false;
  }
  for (const raw of (enable ?? '').split(',')) {
    const step = raw.trim();
    if (step) overrides[step] = true;
  }
  return overrides;
}

function mergeAutoRunOverrides(
  existing: AutoRunOverrides,
  disable?: string,
  enable?: string,
  reset?: string | true,
): AutoRunOverrides {
  let result = { ...existing };

  if (reset === true || reset === 'all' || reset === '') {
    result = {};
  } else if (reset) {
    for (const raw of reset.split(',')) {
      const step = raw.trim();
      if (step) delete result[step];
    }
  }

  for (const raw of (disable ?? '').split(',')) {
    const step = raw.trim();
    if (step) result[step] = false;
  }
  for (const raw of (enable ?? '').split(',')) {
    const step = raw.trim();
    if (step) result[step] = true;
  }
  return result;
}
