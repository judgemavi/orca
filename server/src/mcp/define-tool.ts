import { type ZodTypeAny, z } from 'zod';
import type { Tool } from './types';

interface ToolDefinition<TSchema extends ZodTypeAny> {
  name: string;
  description: string;
  schema: TSchema;
  handler: (input: z.output<TSchema>) => Promise<unknown> | unknown;
}

export function defineTool<TSchema extends ZodTypeAny>(
  definition: ToolDefinition<TSchema>,
): Tool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: z.toJSONSchema(definition.schema) as Record<string, unknown>,
    handler: async (rawInput: unknown) =>
      definition.handler(definition.schema.parse(rawInput)),
  };
}
