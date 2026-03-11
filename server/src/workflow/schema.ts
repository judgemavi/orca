import { rmSync } from 'node:fs';
import { log } from '../shared/logger';
import type { CompiledWorkflow, StepMeta } from './types';
import type { AnyStateNode } from './paths';
import { getTransitionEvents } from './paths';

/**
 * Recursively collect all LLM-executor steps (tool executor, non-code)
 * from an XState state tree, including nested compound states.
 */
function collectLLMSteps(
  node: AnyStateNode,
  prefix = '',
): Array<{ path: string; meta: StepMeta }> {
  const result: Array<{ path: string; meta: StepMeta }> = [];
  for (const [name, child] of Object.entries(node.states ?? {})) {
    const fullName = prefix ? `${prefix}.${name}` : name;
    const meta = (child.meta ?? {}) as StepMeta;

    if (child.states && Object.keys(child.states).length > 0) {
      // Compound state — recurse
      result.push(...collectLLMSteps(child, fullName));
    } else if (meta.executor === 'tool' && meta.type !== 'code' && meta.type !== undefined) {
      result.push({ path: fullName, meta });
    }
  }
  return result;
}

/**
 * Build a standard JSON schema for workflow step structured output.
 * All workflow steps return `{ result: <branch_key>, output: "<text>" }`.
 */
export function buildStepJsonSchema(
  _meta: StepMeta,
  branchNames: string[],
): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      result: {
        type: 'string',
        enum: branchNames.length > 0 ? branchNames : ['done'],
        description: 'The branch outcome for this step',
      },
      output: {
        type: 'string',
        description: 'Full analysis/output text',
      },
    },
    required: ['result', 'output'],
    additionalProperties: false,
  };
}

/**
 * Get branch names (transition event names) for a state node.
 */
export function getStateBranchNames(stateNode: AnyStateNode): string[] {
  return getTransitionEvents(stateNode);
}

// ---------------------------------------------------------------------------
// System step schemas (not workflow-driven)
// ---------------------------------------------------------------------------

export const evaluateSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    needsBreakdown: {
      type: 'boolean',
      description: 'Whether the task needs breakdown into subtasks',
    },
    confidence: { type: 'number', description: 'Confidence score 0-1' },
    reasoning: {
      type: 'string',
      description: 'Explanation for the evaluation',
    },
    suggestedSubtaskCount: {
      type: 'integer',
      description: 'Number of subtasks if breakdown needed',
    },
    needsUserInput: {
      type: 'boolean',
      description: 'Whether user clarification is needed',
    },
    userInputQuestion: {
      type: ['string', 'null'],
      description: 'Question to ask the user if input needed',
    },
  },
  required: [
    'needsBreakdown',
    'confidence',
    'reasoning',
    'suggestedSubtaskCount',
    'needsUserInput',
    'userInputQuestion',
  ],
  additionalProperties: false,
};

const retroEntrySchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    content: { type: 'string', description: 'Memory entry content' },
    category: {
      type: 'string',
      enum: ['pattern', 'pitfall', 'preference', 'convention'],
    },
    tags: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number', description: 'Confidence score 0-1' },
    supersedes: {
      type: ['string', 'null'],
      description: 'ID of memory entry this supersedes',
    },
    filePaths: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'content',
    'category',
    'tags',
    'confidence',
    'supersedes',
    'filePaths',
  ],
  additionalProperties: false,
};

export const retroSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: retroEntrySchema,
    },
  },
  required: ['entries'],
  additionalProperties: false,
};

const systemSchemas: Record<string, Record<string, unknown>> = {
  evaluate: evaluateSchema,
  retro: retroSchema,
};

// ---------------------------------------------------------------------------
// Generation / cleanup
// ---------------------------------------------------------------------------

/**
 * Generate JSON schema files for all LLM-executor workflow steps
 * and system steps (evaluate, retro).
 */
export async function generateSchemas(
  schemasDir: string,
  workflows: Record<string, CompiledWorkflow>,
): Promise<void> {
  await Bun.$`mkdir -p ${schemasDir}`;
  let count = 0;

  for (const workflow of Object.values(workflows)) {
    const root = workflow.machine.root as unknown as AnyStateNode;
    const llmSteps = collectLLMSteps(root);
    for (const { path: stepPath, meta } of llmSteps) {
      const stateNode = resolveStateNode(root, stepPath);
      const branches = stateNode ? getStateBranchNames(stateNode) : [];
      const schema = buildStepJsonSchema(meta, branches);
      const filePath = schemaPath(schemasDir, workflow.name, stepPath);
      await Bun.write(filePath, JSON.stringify(schema, null, 2) + '\n');
      count++;
    }
  }

  // System step schemas
  for (const [name, schema] of Object.entries(systemSchemas)) {
    const path = systemSchemaPath(schemasDir, name);
    await Bun.write(path, JSON.stringify(schema, null, 2) + '\n');
    count++;
  }

  log.info(`generated ${count} schema(s)`, { dir: schemasDir });
}

function resolveStateNode(root: AnyStateNode, dottedPath: string): AnyStateNode | null {
  const segments = dottedPath.split('.');
  let node: AnyStateNode = root;
  for (const seg of segments) {
    const child = node.states?.[seg];
    if (!child) return null;
    node = child;
  }
  return node;
}

/**
 * Remove the schemas directory and all generated files.
 */
export function cleanupSchemas(schemasDir: string): void {
  try {
    rmSync(schemasDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Get the schema file path for a workflow step.
 */
export function schemaPath(
  schemasDir: string,
  workflowName: string,
  stepName: string,
): string {
  return `${schemasDir}/${workflowName}.${stepName}.json`;
}

/**
 * Get the schema file path for a system step (evaluate, retro).
 */
export function systemSchemaPath(schemasDir: string, stepName: string): string {
  return `${schemasDir}/_system.${stepName}.json`;
}
