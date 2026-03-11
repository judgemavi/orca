import { join } from 'node:path';
import { bootstrap } from '../bootstrap';
import { runCLI } from '../cli';
import { initLogger } from '../shared/logger';

export async function runCLIEntrypoint(repoDir: string) {
  initLogger({ dir: join(repoDir, '.orca', 'logs'), name: 'cli' });

  const ctx = await bootstrap({ repoDir });

  try {
    await runCLI(ctx);
  } finally {
    ctx.database.close();
  }
}
