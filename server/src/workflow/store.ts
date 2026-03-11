import { builtinWorkflows } from './presets';
import {
  cleanupSchemas,
  generateSchemas,
  schemaPath,
  systemSchemaPath,
} from './schema';
import type { CompiledWorkflow } from './types';

export class WorkflowStore {
  private readonly custom: Record<string, CompiledWorkflow>;
  private schemasDir: string | null = null;

  constructor(customWorkflows?: Record<string, CompiledWorkflow>) {
    this.custom = customWorkflows ?? {};
  }

  get(name: string): CompiledWorkflow | null {
    return builtinWorkflows[name] ?? this.custom[name] ?? null;
  }

  list(): string[] {
    return [
      ...Object.keys(builtinWorkflows),
      ...Object.keys(this.custom),
    ].sort();
  }

  resolve(name?: string): CompiledWorkflow {
    const workflowName = name || 'standard';
    const workflow = this.get(workflowName);
    if (!workflow) {
      throw new Error(`workflow "${workflowName}" not found`);
    }
    return workflow;
  }

  /** All registered workflows (builtin + custom). */
  all(): Record<string, CompiledWorkflow> {
    return { ...builtinWorkflows, ...this.custom };
  }

  /**
   * Generate JSON schema files for all LLM steps.
   * Call once at daemon startup.
   */
  async initSchemas(repoDir: string): Promise<void> {
    this.schemasDir = `${repoDir.replace(/\/+$/, '')}/.orca/schemas`;
    await generateSchemas(this.schemasDir, this.all());
  }

  /**
   * Get the on-disk schema path for a workflow step.
   * Returns null if schemas haven't been generated.
   */
  getSchemaPath(workflowName: string, stepName: string): string | null {
    if (!this.schemasDir) return null;
    return schemaPath(this.schemasDir, workflowName, stepName);
  }

  /**
   * Get the on-disk schema path for a system step (evaluate, retro).
   * Returns null if schemas haven't been generated.
   */
  getSystemSchemaPath(stepName: string): string | null {
    if (!this.schemasDir) return null;
    return systemSchemaPath(this.schemasDir, stepName);
  }

  /**
   * Remove generated schema files.
   * Call on daemon shutdown.
   */
  cleanup(): void {
    if (this.schemasDir) {
      cleanupSchemas(this.schemasDir);
      this.schemasDir = null;
    }
  }
}
