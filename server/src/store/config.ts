import deepmerge from 'deepmerge';
import { eq } from 'drizzle-orm';
import type { EventSink } from '../api/ws';
import type { OrcaDrizzleDB } from '../db/connection';
import {
  CONFIG_KEY,
  type Config,
  configSchema,
  config as configTable,
  DEFAULT_CONFIG,
} from '../db/schema';

type DeepPartial<T> =
  T extends Array<infer U>
    ? DeepPartial<U>[]
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

export async function loadConfig(db: OrcaDrizzleDB): Promise<Config> {
  const rows = await db
    .select()
    .from(configTable)
    .where(eq(configTable.key, CONFIG_KEY))
    .limit(1);
  const row = rows[0];
  if (!row) {
    const config = configSchema.parse(structuredClone(DEFAULT_CONFIG));
    await saveConfig(db, undefined, config);
    return config;
  }
  return configSchema.parse(row.value);
}

export async function saveConfig(
  db: OrcaDrizzleDB,
  sink: EventSink | undefined,
  config: Config,
): Promise<void> {
  const parsedConfig = configSchema.parse(config);
  const rows = await db
    .insert(configTable)
    .values({ key: CONFIG_KEY, value: parsedConfig })
    .onConflictDoUpdate({
      target: configTable.key,
      set: { value: parsedConfig },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('config not found');
  sink?.broadcast('config.updated', row.value);
}

export async function patchConfig(
  db: OrcaDrizzleDB,
  sink: EventSink | undefined,
  config: DeepPartial<Config>,
): Promise<void> {
  const current = await loadConfig(db);
  const next = configSchema.parse(deepmerge(current, config));
  await saveConfig(db, sink, next);
}
