import type { Command } from 'commander';
import type { OrcaDrizzleDB } from '../../db/connection';
import {
  loadOrchestratorPrompt,
  ORCHESTRATOR_ALLOWED_TOOLS,
  resolveSupervisor,
} from '../../orchestrator/bootstrap';
import { type ToolPluginRegistry, toolDefinition } from '../../plugin/registry';
import * as configStore from '../../store/config';

export function registerOrcCommand(
  program: Command,
  deps: {
    repoDir: string;
    db: OrcaDrizzleDB;
    registry: ToolPluginRegistry;
  },
) {
  program
    .command('orc')
    .description('Launch interactive orchestrator supervisor in terminal')
    .option('--tool <tool>', 'supervisor tool override')
    .option('--model <model>', 'supervisor model override')
    .action(async (opts: { tool?: string; model?: string }) => {
      await runOrcInteractive(deps, opts);
    });
}

async function runOrcInteractive(
  deps: {
    repoDir: string;
    db: OrcaDrizzleDB;
    registry: ToolPluginRegistry;
  },
  opts: { tool?: string; model?: string },
): Promise<void> {
  const resolved = await resolveSupervisor(deps.db, deps.registry);
  const toolName = (opts.tool ?? '').trim() || resolved.toolName;
  const tool = toolDefinition(deps.registry, toolName);
  if (!tool) {
    throw new Error(`supervisor tool not available: ${toolName}`);
  }
  const model = await resolveSupervisorModel({
    db: deps.db,
    toolName,
    toolModels: tool.models(),
    fallbackModel: resolved.model,
    override: (opts.model ?? '').trim(),
  });

  const systemPrompt = await loadOrchestratorPrompt(deps.repoDir);
  const args = await tool.interactiveArgs({
    model,
    systemPrompt,
    allowedTools: [...ORCHESTRATOR_ALLOWED_TOOLS],
    repoDir: deps.repoDir,
  });

  const child = Bun.spawn({
    cmd: [tool.binary(), ...args],
    cwd: deps.repoDir,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const stop = () => {
    try {
      child.kill();
    } catch {}
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const code = await child.exited;
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);

  if (code !== 0) {
    throw new Error(`supervisor exited with code ${code}`);
  }
}

async function resolveSupervisorModel(input: {
  db: OrcaDrizzleDB;
  toolName: string;
  toolModels: string[];
  fallbackModel: string;
  override: string;
}): Promise<string> {
  if (input.override) return input.override;
  if (input.fallbackModel && input.toolModels.includes(input.fallbackModel)) {
    return input.fallbackModel;
  }

  const config = await configStore.loadConfig(input.db);
  const candidates = [
    input.toolName === config.orchestrator.tool
      ? config.orchestrator.model
      : '',
    input.toolModels[0] ?? '',
  ].filter((value) => value.trim());

  const resolved = candidates.find((value) => input.toolModels.includes(value));
  if (resolved) return resolved;
  if (input.toolModels[0]?.trim()) return input.toolModels[0];
  throw new Error(`no model configured for supervisor tool ${input.toolName}`);
}
