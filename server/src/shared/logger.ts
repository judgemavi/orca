import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';

type EntryName = 'server' | 'cli';

let logger: pino.Logger = pino({ level: 'silent' });

export function initLogger(opts: {
  dir: string;
  name: EntryName;
  level?: pino.LevelWithSilent;
  pretty?: boolean;
}): pino.Logger {
  mkdirSync(opts.dir, { recursive: true });
  const filePath = join(opts.dir, `${opts.name}.log`);
  const level = opts.level ?? 'info';

  const targets: pino.TransportTargetOptions[] = [
    {
      target: 'pino/file',
      options: { destination: filePath, mkdir: true },
      level,
    },
  ];

  if (opts.pretty) {
    targets.push({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss' },
      level,
    });
  }

  logger = pino({ level }, pino.transport({ targets }));

  return logger;
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) =>
    data ? logger.debug(data, msg) : logger.debug(msg),
  info: (msg: string, data?: Record<string, unknown>) =>
    data ? logger.info(data, msg) : logger.info(msg),
  warn: (msg: string, data?: Record<string, unknown>) =>
    data ? logger.warn(data, msg) : logger.warn(msg),
  error: (msg: string, data?: Record<string, unknown>) =>
    data ? logger.error(data, msg) : logger.error(msg),
};
