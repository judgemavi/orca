import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { OrcaDrizzleDB } from '../../db/connection';
import { sessions } from '../../db/schema';

export function sessionRoutes(db: OrcaDrizzleDB) {
  return new Hono().get('/sessions', async (c) => {
    const rows = await db
      .select({
        id: sessions.id,
        type: sessions.type,
        tool: sessions.tool,
        taskId: sessions.taskId,
        cols: sessions.cols,
        rows: sessions.rows,
        createdAt: sessions.createdAt,
      })
      .from(sessions)
      .where(eq(sessions.status, 'running'))
      .orderBy(desc(sessions.createdAt));

    return c.json(rows.map((row) => ({ ...row, taskId: row.taskId ?? '' })));
  });
}
