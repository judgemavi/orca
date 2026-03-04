import { eq } from 'drizzle-orm';
import type { EventSink } from '../api/ws';
import {
  defaultConfig,
  mergePatchConfig,
  validateConfig,
} from '../config/config';
import type { OrcaDrizzleDB } from '../db/connection';
import { config as configTable } from '../db/schema';
import type { Config } from '../types';

const CONFIG_KEY = 'config';

export class ConfigStore {
  constructor(
    private readonly db: OrcaDrizzleDB,
    private readonly sink?: EventSink,
  ) {}

  async load(): Promise<Config> {
    const rows = await this.db
      .select({ value: configTable.value })
      .from(configTable)
      .where(eq(configTable.key, CONFIG_KEY))
      .limit(1);
    const row = rows[0] ?? null;
    if (!row) return defaultConfig();
    const parsed = JSON.parse(row.value) as Config;
    return validateConfig(parsed);
  }

  async save(config: Config): Promise<Config> {
    const validated = validateConfig(config);
    const value = JSON.stringify(validated);
    await this.db
      .insert(configTable)
      .values({ key: CONFIG_KEY, value })
      .onConflictDoUpdate({
        target: configTable.key,
        set: { value },
      });
    this.sink?.broadcast('config.updated', validated);
    return validated;
  }

  async patch(rawPatch: unknown): Promise<Config> {
    const current = await this.load();
    const next = mergePatchConfig(current, rawPatch);
    return this.save(next);
  }
}
