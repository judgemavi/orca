import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { EventSink } from '../api/ws';
import type { Executor } from '../executor/executor';
import type { ToolPluginRegistry } from '../plugin/registry';
import type { JobQueue } from '../queue/queue';
import type { ConfigStore } from '../store/config';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import type { TaskStore } from '../store/tasks';
import { errorResult, jsonResult } from './helpers';
import { adminTools } from './tools/admin';
import { exploreTools } from './tools/explore';
import { interactionTools } from './tools/interactions';
import { memoryTools } from './tools/memory';
import { mergeTools } from './tools/merge';
import { planningTools } from './tools/planning';
import { queueTools } from './tools/queue';
import { reviewTools } from './tools/review';
import { statusTools } from './tools/status';
import { taskTools } from './tools/tasks';
import { worktreeTools } from './tools/worktree';
import type { Tool } from './types';

export interface MCPDeps {
  repoDir: string;
  configStore: ConfigStore;
  registry: ToolPluginRegistry;
  taskStore: TaskStore;
  interactionStore: InteractionStore;
  memoryStore: MemoryStore;
  executor: Executor;
  eventSink?: EventSink;
  queue?: JobQueue;
}

export async function startMCPServer(deps: MCPDeps): Promise<void> {
  const server = new Server(
    { name: 'orca', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  const tools: Tool[] = [
    ...adminTools({
      repoDir: deps.repoDir,
      configStore: deps.configStore,
      registry: deps.registry,
      taskStore: deps.taskStore,
      interactions: deps.interactionStore,
      memory: deps.memoryStore,
    }),
    ...taskTools({
      repoDir: deps.repoDir,
      taskStore: deps.taskStore,
      interactions: deps.interactionStore,
      executor: deps.executor,
      sink: deps.eventSink,
      queue: deps.queue,
    }),
    ...planningTools({
      repoDir: deps.repoDir,
      configStore: deps.configStore,
      registry: deps.registry,
      taskStore: deps.taskStore,
      interactions: deps.interactionStore,
      memory: deps.memoryStore,
    }),
    ...reviewTools({
      repoDir: deps.repoDir,
      configStore: deps.configStore,
      registry: deps.registry,
      taskStore: deps.taskStore,
      executor: deps.executor,
      interactions: deps.interactionStore,
    }),
    ...mergeTools({
      repoDir: deps.repoDir,
      taskStore: deps.taskStore,
      configStore: deps.configStore,
      interactions: deps.interactionStore,
      memory: deps.memoryStore,
      registry: deps.registry,
    }),
    ...interactionTools(deps.interactionStore),
    ...exploreTools({
      repoDir: deps.repoDir,
      memory: deps.memoryStore,
      interactions: deps.interactionStore,
      configStore: deps.configStore,
      registry: deps.registry,
    }),
    ...worktreeTools(deps.repoDir),
    ...memoryTools(deps.repoDir, deps.memoryStore),
    ...statusTools({
      taskStore: deps.taskStore,
      interactions: deps.interactionStore,
      memory: deps.memoryStore,
    }),
    ...(deps.queue ? queueTools({ queue: deps.queue }) : []),
  ];

  const byName = new Map<string, Tool>();
  for (const tool of tools) {
    byName.set(tool.name, tool);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...byName.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = String(request?.params?.name ?? '');
    const input = request?.params?.arguments ?? {};
    const tool = byName.get(name);
    if (!tool) {
      return errorResult(`unknown tool: ${name}`);
    }

    try {
      const result = await tool.handler(input);
      return jsonResult(result);
    } catch (error) {
      return errorResult(error);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Keep alive until the MCP client disconnects — prevents the caller
  // from returning (and closing the database) while requests are in flight.
  await new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
}
