import type { Hono } from 'hono';
import type { InteractionStore } from '../../store/interactions';

export function registerQualityHandlers(
  app: Hono,
  interactions: InteractionStore,
) {
  app.get('/tasks/:id/quality', async (c) => {
    const taskID = c.req.param('id');
    const latest = (await interactions.listByPhase(taskID, 'run')).find(
      (interaction) => interaction.qualityJson?.trim(),
    );

    if (!latest?.qualityJson) {
      return c.json({ data: { taskId: taskID, quality: null } });
    }

    try {
      return c.json({
        data: {
          taskId: taskID,
          quality: JSON.parse(latest.qualityJson),
        },
      });
    } catch {
      return c.json({
        data: {
          taskId: taskID,
          quality: null,
          malformed: true,
        },
      });
    }
  });
}
