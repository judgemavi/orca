import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import type { OrcaDrizzleDB } from '../../db/connection'
import { sessions } from '../../db/schema'

export function registerSessionHandlers(app: Hono, db: OrcaDrizzleDB) {
  app.get('/sessions', async (c) => {
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
      .orderBy(desc(sessions.createdAt))

    return c.json({ data: rows.map((row) => ({ ...row, taskId: row.taskId ?? '' })) })
  })
}
