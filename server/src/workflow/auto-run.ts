import { isAutoRun } from '../config/config';
import type { OrcaDrizzleDB } from '../db/connection';
import * as configStore from '../store/config';
import * as taskStore from '../store/tasks';
import { resolveStepMeta } from './paths';
import type { WorkflowStore } from './store';

export async function shouldAutoRun(
  deps: {
    db: OrcaDrizzleDB;
    workflowStore: WorkflowStore;
  },
  taskId: string,
  stepName: string,
): Promise<boolean> {
  try {
    const [config, task] = await Promise.all([
      configStore.loadConfig(deps.db),
      taskStore.getTask(deps.db, taskId),
    ]);
    const compiled = deps.workflowStore.resolve(task?.workflow ?? undefined);
    let stepAutoRun: boolean | undefined;
    try {
      stepAutoRun = resolveStepMeta(compiled.machine, stepName).meta.autoRun;
    } catch {
      stepAutoRun = undefined;
    }
    return isAutoRun({
      config,
      stepName,
      stepAutoRun,
      taskOverrides: task?.autoRunOverrides,
    });
  } catch {
    return false;
  }
}
