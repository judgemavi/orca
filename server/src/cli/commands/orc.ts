import type { Command } from 'commander';
import { type DriverRegistry, toolDefinition } from '../../driver/registry';
import type { Driver } from '../../driver/types';
import {
  loadOrchestratorPrompt,
  ORCHESTRATOR_ALLOWED_TOOLS,
  resolveSupervisor,
  writeMCPConfig,
} from '../../orchestrator/bootstrap';
import type { ConfigStore } from '../../store/config';

export function registerOrcCommand(
  program: Command,
  deps: {
    repoDir: string;
    configStore: ConfigStore;
    registry: DriverRegistry;
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
    configStore: ConfigStore;
    registry: DriverRegistry;
  },
  opts: { tool?: string; model?: string },
): Promise<void> {
  const resolved = await resolveSupervisor(deps.configStore, deps.registry);
  const toolName = (opts.tool ?? '').trim() || resolved.toolName;
  const tool = toolDefinition(deps.registry, toolName);
  if (!tool) {
    throw new Error(`supervisor tool not available: ${toolName}`);
  }
  if (!isSupervisorDriver(tool)) {
    throw new Error(`driver ${toolName} does not support interactive mode`);
  }

  const model = await resolveSupervisorModel({
    configStore: deps.configStore,
    toolName,
    toolModels: tool.models(),
    fallbackModel: resolved.model,
    override: (opts.model ?? '').trim(),
  });

  const mcpConfigPath = await writeMCPConfig(deps.repoDir, tool);
  const systemPrompt = await loadOrchestratorPrompt(deps.repoDir);
  const args = tool.interactiveArgs(
    mcpConfigPath,
    ORCHESTRATOR_ALLOWED_TOOLS,
    systemPrompt,
    model,
  );

  const child = Bun.spawn({
    cmd: [tool.binary(), ...args],
    cwd: deps.repoDir,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      ORCA_MCP_CONFIG: mcpConfigPath,
    },
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
  configStore: ConfigStore;
  toolName: string;
  toolModels: string[];
  fallbackModel: string;
  override: string;
}): Promise<string> {
  if (input.override) return input.override;
  if (input.fallbackModel && input.toolModels.includes(input.fallbackModel)) {
    return input.fallbackModel;
  }

  const config = await input.configStore.load();
  const candidates = [
    input.toolName === config.orchestrator.supervisorTool
      ? config.orchestrator.supervisorModel
      : '',
    input.toolName === config.defaultTool ? config.defaultModel : '',
    input.toolModels[0] ?? '',
  ].filter((value) => value.trim());

  const resolved = candidates.find((value) => input.toolModels.includes(value));
  if (resolved) return resolved;
  if (input.toolModels[0]?.trim()) return input.toolModels[0];
  throw new Error(`no model configured for supervisor tool ${input.toolName}`);
}

interface InteractiveDriver extends Driver {
  interactiveArgs(
    mcpConfig: string,
    allowedTools: string[],
    context: string,
    model: string,
  ): string[];
}

function isSupervisorDriver(value: unknown): value is InteractiveDriver {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as InteractiveDriver).interactiveArgs === 'function';
}
