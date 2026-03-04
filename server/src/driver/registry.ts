import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ClaudeDriver } from './claude';
import { CodexDriver } from './codex';
import type { Driver } from './types';

export class DriverRegistry {
  private readonly drivers = new Map<string, Driver>();

  constructor(withBuiltins = true) {
    if (withBuiltins) {
      this.register('claude', new ClaudeDriver());
      this.register('codex', new CodexDriver());
    }
  }

  get(name: string): Driver | undefined {
    return this.drivers.get(normalizeDriverName(name));
  }

  registered(): string[] {
    return [...this.drivers.keys()].sort((a, b) => a.localeCompare(b));
  }

  available(): string[] {
    return [...this.drivers.entries()]
      .filter(([, driver]) => binaryExists(driver.binary()))
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b));
  }

  register(name: string, driver: Driver): void {
    const normalized = normalizeDriverName(name);
    if (!normalized) throw new Error('driver name is required');
    if (!isDriver(driver)) {
      throw new Error(`invalid driver registration for ${normalized}`);
    }
    this.drivers.set(normalized, driver);
  }

  async loadUserDrivers(dir: string): Promise<void> {
    const normalized = dir.trim();
    if (!normalized || !existsSync(normalized)) return;

    const files = await readdir(normalized);
    const candidates = files
      .filter((name) => /\.(mjs|cjs|js|ts)$/i.test(name))
      .sort((a, b) => a.localeCompare(b));

    for (const file of candidates) {
      const absolute = `${normalized.replace(/\/+$/g, '')}/${file}`;
      const mod = await import(pathToFileURL(absolute).href);
      const maybe = mod.default ?? mod.driver ?? mod.Driver ?? mod;
      if (!isDriver(maybe)) {
        throw new Error(
          `user driver ${file} does not implement Driver interface`,
        );
      }
      this.register(maybe.name().toLowerCase(), maybe as Driver);
    }
  }
}

export async function loadDriverRegistry(
  repoDir: string,
): Promise<DriverRegistry> {
  const registry = new DriverRegistry(true);
  await registry.loadUserDrivers(`${repoDir}/.orca/drivers`);
  return registry;
}

export function fallbackDriverRegistry(): DriverRegistry {
  return new DriverRegistry(true);
}

export function availableTools(registry: DriverRegistry): string[] {
  return registry.available();
}

export function toolModels(registry: DriverRegistry, name: string): string[] {
  return registry.get(name)?.models() ?? [];
}

export function toolDefinition(
  registry: DriverRegistry,
  name: string,
): Driver | null {
  return registry.get(name) ?? null;
}

function isDriver(value: unknown): value is Driver {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Driver;
  return (
    typeof candidate.name === 'function' &&
    typeof candidate.binary === 'function' &&
    typeof candidate.models === 'function' &&
    typeof candidate.headlessArgs === 'function' &&
    typeof candidate.resumeArgs === 'function' &&
    typeof candidate.parseEvent === 'function' &&
    typeof candidate.parseSessionID === 'function'
  );
}

function normalizeDriverName(name: string): string {
  return name.trim().toLowerCase();
}

function binaryExists(binary: string): boolean {
  const normalized = binary.trim();
  if (!normalized) return false;
  if (normalized.includes('/')) return existsSync(normalized);
  return Boolean(Bun.which(normalized));
}
