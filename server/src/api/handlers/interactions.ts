import { Hono } from 'hono';
import { gitRun } from '../../shared/git';
import type { InteractionStore } from '../../store/interactions';
import { asBoolean } from './utils';

interface InteractionRouteDeps {
  interactions: InteractionStore;
  repoDir: string;
}

export function interactionRoutes(deps: InteractionRouteDeps) {
  const { interactions, repoDir } = deps;
  return new Hono()
    .get('/tasks/:id/interactions', async (c) => {
      const taskID = c.req.param('id');
      const fields = c.req.query('fields')?.trim() ?? '';
      const type = c.req.query('type')?.trim() ?? '';
      const status = c.req.query('status')?.trim() ?? '';

      if (fields === 'stub') {
        let stubs = await interactions.listStubs(taskID);
        stubs = stubs.filter((s) => s.type !== 'explore');
        if (type) stubs = stubs.filter((s) => s.type === type);
        if (status) stubs = stubs.filter((s) => s.status === status);
        stubs = sortByLinkedList(stubs);
        return c.json(stubs);
      }

      let data = type
        ? await interactions.listByType(taskID, type)
        : await interactions.list(taskID);
      data = data.filter((item) => item.type !== 'explore');
      if (status) {
        data = data.filter((item) => item.status === status);
      }

      data = sortByLinkedList(data);
      return c.json(data);
    })

    .get('/tasks/:id/interactions/:interactionID', async (c) => {
      const taskID = c.req.param('id');
      const interactionID = c.req.param('interactionID');
      const skipContent = c.req.query('content') === '0';

      const interaction = await interactions.get(interactionID);
      if (!interaction || interaction.taskId !== taskID) {
        return c.json({ error: 'interaction not found' }, 404);
      }

      if (skipContent) {
        return c.json(interaction);
      }

      const raw = await interactions.readLog(interactionID);
      const formatted = stripAnsi(raw);

      return c.json({
        ...interaction,
        content: formatted,
        rawContent: raw,
      });
    })

    .get('/tasks/:id/interactions/:interactionID/stream', async (c) => {
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
    })

    .get('/tasks/:id/interactions/:interactionID/diff', async (c) => {
      const taskID = c.req.param('id');
      const interactionID = c.req.param('interactionID');

      const interaction = await interactions.get(interactionID);
      if (!interaction || interaction.taskId !== taskID) {
        return c.json({ error: 'interaction not found' }, 404);
      }

      const sha = interaction.commitSha?.trim();
      if (!sha) {
        return c.json({ diff: '', filesChanged: [] });
      }

      try {
        const [diffResult, namesResult] = await Promise.all([
          gitRun(repoDir, ['diff', `${sha}~1..${sha}`]),
          gitRun(repoDir, ['diff', `${sha}~1..${sha}`, '--name-only']),
        ]);
        const diff = diffResult.exitCode === 0 ? diffResult.stdout : '';
        const filesChanged =
          namesResult.exitCode === 0
            ? namesResult.stdout
                .split('\n')
                .map((f) => f.trim())
                .filter(Boolean)
            : [];
        return c.json({ diff, filesChanged });
      } catch {
        return c.json({ diff: '', filesChanged: [] });
      }
    })

    .get('/operations', async (c) => {
      const targetID = c.req.query('targetId')?.trim() ?? '';
      const requestedType = c.req.query('type')?.trim() ?? '';
      const running = await interactions.listByStatus('running');

      const mapped = running
        .map((item) => ({
          id: item.id,
          type: item.type,
          targetId: item.taskId ?? '',
          status: item.status,
          createdAt: item.startedAt,
          updatedAt: item.finishedAt ?? item.startedAt,
        }))
        .filter((item) => (targetID ? item.targetId === targetID : true))
        .filter((item) => (requestedType ? item.type === requestedType : true));

      return c.json(mapped);
    });
}

function stripAnsi(value: string): string {
  // biome-ignore lint: regex is safe
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function sortByLinkedList<
  T extends { id: string; previousInteractionId?: string | null },
>(items: T[]): T[] {
  if (items.length <= 1) return items;
  const byPrev = new Map<string | null, T>();
  for (const item of items) {
    byPrev.set(item.previousInteractionId ?? null, item);
  }
  const sorted: T[] = [];
  let current = byPrev.get(null);
  while (current && sorted.length < items.length) {
    sorted.push(current);
    current = byPrev.get(current.id);
  }
  if (sorted.length < items.length) {
    const inSorted = new Set(sorted.map((s) => s.id));
    for (const item of items) {
      if (!inSorted.has(item.id)) sorted.push(item);
    }
  }
  return sorted;
}
