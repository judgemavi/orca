import { describe, expect, test } from 'bun:test';
import { isAutoRun, sanitizeConfig } from '../../src/config/config';
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_CONFIG,
} from '../../src/db/schema';
import { ToolPluginRegistry } from '../../src/plugin/registry';
import type { Config } from '../../src/db/schema';
import { SYSTEM_INTERACTION_TYPES } from '../../src/types/api';

// ---------------------------------------------------------------------------
// isAutoRun
// ---------------------------------------------------------------------------
describe('isAutoRun', () => {
  const baseConfig: Config = structuredClone(DEFAULT_CONFIG);

  test('returns true by default (no overrides, no stepAutoRun)', () => {
    expect(isAutoRun({ config: baseConfig, stepName: 'code' })).toBe(true);
  });

  test('global autoRun=false overrides everything', () => {
    const config = { ...baseConfig, autoRun: false };
    expect(isAutoRun({ config, stepName: 'code', stepAutoRun: true })).toBe(false);
  });

  test('task override takes precedence over step def', () => {
    expect(isAutoRun({
      config: baseConfig,
      stepName: 'review',
      stepAutoRun: true,
      taskOverrides: { review: false },
    })).toBe(false);
  });

  test('task override=true overrides step def=false', () => {
    expect(isAutoRun({
      config: baseConfig,
      stepName: 'review',
      stepAutoRun: false,
      taskOverrides: { review: true },
    })).toBe(true);
  });

  test('step def autoRun=false gates when no task override', () => {
    expect(isAutoRun({
      config: baseConfig,
      stepName: 'code',
      stepAutoRun: false,
    })).toBe(false);
  });

  test('global autoRun=false beats task override=true', () => {
    const config = { ...baseConfig, autoRun: false };
    expect(isAutoRun({
      config,
      stepName: 'code',
      stepAutoRun: true,
      taskOverrides: { code: true },
    })).toBe(false);
  });

  test('custom step name with no def defaults to true', () => {
    expect(isAutoRun({
      config: baseConfig,
      stepName: 'my-custom-step',
    })).toBe(true);
  });

  test('dotted step name falls back to leaf name in task overrides', () => {
    expect(isAutoRun({
      config: baseConfig,
      stepName: 'implement.code',
      taskOverrides: { code: false },
    })).toBe(false);
  });

  test('dotted step name prefers exact match over leaf fallback', () => {
    expect(isAutoRun({
      config: baseConfig,
      stepName: 'implement.code',
      taskOverrides: { 'implement.code': true, code: false },
    })).toBe(true);
  });

  test('dotted step leaf fallback works for review', () => {
    expect(isAutoRun({
      config: baseConfig,
      stepName: 'implement.review',
      stepAutoRun: true,
      taskOverrides: { review: false },
    })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sanitizeConfig
// ---------------------------------------------------------------------------
describe('sanitizeConfig', () => {
  const registry = new ToolPluginRegistry(true);
  const makeConfig = (): Config => structuredClone(DEFAULT_CONFIG);

  test('strips legacy interactions field', () => {
    const config = makeConfig();
    (config as unknown as Record<string, unknown>).interactions = {
      code: { tool: 'claude', model: '' },
      review: { tool: 'claude', model: '' },
    };

    sanitizeConfig(config, registry);
    expect((config as unknown as Record<string, unknown>).interactions).toBeUndefined();
  });

  // --- schema versioning ---

  test('throws on future schema version', () => {
    const config = makeConfig();
    config.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
    expect(() => sanitizeConfig(config, registry)).toThrow(/newer than supported/);
  });

  test('migrates v1 postMerge.retro → memory.retro', () => {
    const config = makeConfig();
    delete config.schemaVersion;
    (config as unknown as Record<string, unknown>).postMerge = { enabled: true, retro: false, memorySync: true };
    delete (config as unknown as Record<string, unknown>).memory;

    const changes = sanitizeConfig(config, registry);
    expect(config.memory!.retro).toBe(false);
    expect(config.memory!.sync).toBe(true);
    expect(config.schemaVersion!).toBe(CURRENT_SCHEMA_VERSION);
    expect(changes.some((c) => c.includes('postMerge.retro → memory.retro'))).toBe(true);
    expect(changes.some((c) => c.includes('postMerge.memorySync → memory.sync'))).toBe(true);
  });

  test('migrates v1 postMerge.memorySync=false → memory.sync=false', () => {
    const config = makeConfig();
    config.schemaVersion = 1;
    (config as unknown as Record<string, unknown>).postMerge = { enabled: true, memorySync: false };
    delete (config as unknown as Record<string, unknown>).memory;

    sanitizeConfig(config, registry);
    expect(config.memory!.sync).toBe(false);
  });

  test('v1 config missing postMerge still upgrades schema', () => {
    const config = makeConfig();
    (config as unknown as Record<string, unknown>).schemaVersion = undefined;
    sanitizeConfig(config, registry);
    expect(config.schemaVersion!).toBe(CURRENT_SCHEMA_VERSION);
  });

  test('v2 config is not re-migrated', () => {
    const config = makeConfig();
    config.schemaVersion = 2;
    config.memory = { enabled: true, retro: false, sync: true };
    const changes = sanitizeConfig(config, registry);
    expect(config.memory.retro).toBe(false);
    expect(changes.every((c) => !c.includes('schemaVersion upgraded'))).toBe(true);
  });

  // --- memory config defaults ---

  test('DEFAULT_CONFIG includes memory config', () => {
    const config = makeConfig();
    expect(config.memory).toEqual({ enabled: true, retro: true, sync: true });
    expect(config.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------
describe('type constants', () => {
  test('SYSTEM_INTERACTION_TYPES has system-controlled types', () => {
    expect(SYSTEM_INTERACTION_TYPES).toContain('evaluate');
    expect(SYSTEM_INTERACTION_TYPES).toContain('breakdown');
    expect(SYSTEM_INTERACTION_TYPES).toContain('merge');
    expect(SYSTEM_INTERACTION_TYPES).toContain('retro');
    expect(SYSTEM_INTERACTION_TYPES).toContain('explore');
    expect(SYSTEM_INTERACTION_TYPES).not.toContain('code');
  });
});
