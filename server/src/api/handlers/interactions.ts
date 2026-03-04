import type { Hono } from 'hono';
import type { InteractionStore } from '../../store/interactions';
import { asBoolean } from './utils';

export function registerInteractionHandlers(
  app: Hono,
  interactions: InteractionStore,
) {
  app.get('/tasks/:id/interactions', async (c) => {
    const taskID = c.req.param('id');
    const fields = c.req.query('fields')?.trim() ?? '';
    const phase = c.req.query('phase')?.trim() ?? '';
    const status = c.req.query('status')?.trim() ?? '';

    if (fields === 'stub') {
      let stubs = await interactions.listStubs(taskID);
      if (phase) stubs = stubs.filter((s) => s.phase === phase);
      if (status) stubs = stubs.filter((s) => s.status === status);
      stubs = stubs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      return c.json({ data: stubs });
    }

    let data = phase
      ? await interactions.listByPhase(taskID, phase)
      : await interactions.list(taskID);
    if (status) {
      data = data.filter((item) => item.status === status);
    }

    data = data.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return c.json({ data });
  });

  app.get('/tasks/:id/interactions/:interactionID', async (c) => {
    const taskID = c.req.param('id');
    const interactionID = c.req.param('interactionID');
    const skipContent = c.req.query('content') === '0';

    const interaction = await interactions.get(interactionID);
    if (!interaction || interaction.taskId !== taskID) {
      return c.json({ error: 'interaction not found' }, 404);
    }

    if (skipContent) {
      return c.json({ data: interaction });
    }

    const raw = await interactions.readLog(interactionID);
    const formatted = stripAnsi(raw);

    return c.json({
      data: {
        ...interaction,
        content: formatted,
        rawContent: raw,
      },
    });
  });

  app.get('/tasks/:id/interactions/:interactionID/stream', async (c) => {
    const taskID = c.req.param('id');
    const interactionID = c.req.param('interactionID');

    const interaction = await interactions.get(interactionID);
    if (!interaction || interaction.taskId !== taskID) {
      return c.text('interaction not found', 404);
    }

    const raw = await interactions.readLog(interactionID);
    const sendRaw = asBoolean(c.req.query('raw'));
    const lines = (sendRaw ? raw : stripAnsi(raw)).split('\n');

    const stream = new ReadableStream<string>({
      start(controller) {
        for (const line of lines) {
          if (!line.trim()) continue;
          const payload = line.replace(/\r/g, '');
          controller.enqueue(`data: ${payload}\n\n`);
        }
        controller.enqueue('event: done\ndata: {}\n\n');
        controller.close();
      },
    });

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');
    return c.body(stream);
  });

  app.get('/operations', async (c) => {
    const targetID = c.req.query('targetId')?.trim() ?? '';
    const requestedType = c.req.query('type')?.trim() ?? '';
    const running = await interactions.listByStatus('running');

    const mapped = running
      .map((item) => ({
        id: item.id,
        type: item.phase,
        targetId: item.taskId ?? '',
        status: item.status,
        createdAt: item.startedAt,
        updatedAt: item.finishedAt ?? item.startedAt,
      }))
      .filter((item) => (targetID ? item.targetId === targetID : true))
      .filter((item) => (requestedType ? item.type === requestedType : true));

    return c.json({ data: mapped });
  });

  app.get('/costs', async (c) => {
    return c.json({
      data: {
        total: await interactions.projectTotal(),
        byTool: await interactions.projectSummary(),
      },
    });
  });

  app.get('/costs/run/:id', async (c) => {
    const runID = c.req.param('id');
    return c.json({
      data: {
        runId: runID,
        total: await interactions.runTotal(runID),
        byTool: await interactions.runSummary(runID),
      },
    });
  });
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}
