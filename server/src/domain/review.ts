import type { ToolPluginRegistry } from '../plugin/registry';
import { createInteractionRunner } from '../shared/interaction-runner';
import type { InteractionStore } from '../store/interactions';
import type { AIReviewCheck, AIReviewFinding, Config } from '../types';
import { runTool } from '../worker/worker';
import { extractJSONObject } from './llm';

interface ParsedReviewPayload {
  approved?: boolean;
  feedback?: string;
  decision?: string;
  verdict?: string;
  status?: string;
  checks?: unknown[];
  findings?: unknown[];
}

export interface RunAIReviewInput {
  repoDir: string;
  taskID: string;
  title: string;
  description: string;
  diff: string;
  prompt?: string;
  config: Config;
  registry: ToolPluginRegistry;
  interactions: InteractionStore;
  toolOverride?: string;
  modelOverride?: string;
}

export interface RunAIReviewResult {
  taskId: string;
  approved: boolean;
  feedback: string;
  tool: string;
  model: string;
  interactionId: string;
  prompt: string;
  checks: AIReviewCheck[];
  findings: AIReviewFinding[];
}

export async function runAIReview(
  input: RunAIReviewInput,
): Promise<RunAIReviewResult> {
  const runInteraction = await createInteractionRunner({
    config: input.config,
    registry: input.registry,
    repoDir: input.repoDir,
    interactions: input.interactions,
    runTool,
  });

  const userPrompt = input.prompt ?? '';
  const {
    result: parsed,
    interactionId,
    tool,
    model,
  } = await runInteraction(
    {
      taskId: input.taskID,
      type: 'review',
      promptName: 'review',
      promptArgs: [
        input.title.trim() || 'Untitled task',
        input.description.trim(),
        input.diff.trim() || '(no diff provided)',
        userPrompt.trim() || 'No additional instructions.',
      ],
      toolOverride: input.toolOverride ?? '',
      modelOverride: input.modelOverride ?? '',
      resolveErrorMessage: 'unable to resolve review tool/model',
      exitErrorLabel: 'review',
    },
    (output) => parseReviewPayload(output),
    (parsed, context) => ({
      qualityJson: JSON.stringify({
        taskId: input.taskID,
        approved: parsed.approved,
        feedback: parsed.feedback,
        prompt: userPrompt,
        tool: context.tool,
      }),
    }),
  );

  return {
    taskId: input.taskID,
    approved: parsed.approved,
    feedback: parsed.feedback,
    tool,
    model,
    interactionId,
    prompt: userPrompt,
    checks: parsed.checks,
    findings: parsed.findings,
  };
}

function parseReviewPayload(output: string): {
  approved: boolean;
  feedback: string;
  checks: AIReviewCheck[];
  findings: AIReviewFinding[];
} {
  const payload = extractJSONObject<ParsedReviewPayload>(output);
  if (!payload) {
    throw new Error(`failed to parse review JSON from output`);
  }

  let approved: boolean | null = null;
  if (typeof payload.approved === 'boolean') {
    approved = payload.approved;
  } else {
    const decision = String(
      payload.decision ?? payload.verdict ?? payload.status ?? '',
    )
      .trim()
      .toLowerCase();
    if (decision === 'approve' || decision === 'approved') approved = true;
    if (
      decision === 'request-changes' ||
      decision === 'request_changes' ||
      decision === 'changes_requested' ||
      decision === 'reject' ||
      decision === 'rejected'
    ) {
      approved = false;
    }
  }

  if (approved === null) {
    throw new Error('review payload missing approved/decision field');
  }
  const feedback = String(payload.feedback ?? '').trim();
  if (!feedback) {
    throw new Error('review payload missing feedback');
  }

  const checks = Array.isArray(payload.checks)
    ? parseChecks(payload.checks)
    : [];
  const findings = Array.isArray(payload.findings)
    ? parseFindings(payload.findings)
    : [];

  return { approved, feedback, checks, findings };
}

function parseChecks(raw: unknown[]): AIReviewCheck[] {
  const out: AIReviewCheck[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const key = String(rec.key ?? '').trim();
    const label = String(rec.label ?? key).trim();
    if (!key) continue;
    out.push({ key, label, passed: Boolean(rec.passed) });
  }
  return out;
}

function parseFindings(raw: unknown[]): AIReviewFinding[] {
  const out: AIReviewFinding[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const summary = String(rec.summary ?? '').trim();
    if (!summary) continue;
    out.push({
      id: String(rec.id ?? `finding-${i}`),
      summary,
      detail: String(rec.detail ?? summary).trim(),
      passed: typeof rec.passed === 'boolean' ? rec.passed : true,
      filePath: typeof rec.filePath === 'string' ? rec.filePath : undefined,
      line:
        typeof rec.line === 'number' && Number.isFinite(rec.line)
          ? rec.line
          : undefined,
    });
  }
  return out;
}
