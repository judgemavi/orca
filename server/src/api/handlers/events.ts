import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { EventSink } from '../ws';

export function eventRoutes(sink: EventSink) {
  return new Hono().get('/events', (c) => {
    const lastEventId = Number(
      c.req.header('Last-Event-ID') ?? c.req.query('lastEventId') ?? '0',
    );

    return streamSSE(c, async (stream) => {
      // Replay missed events
      if (lastEventId > 0) {
        const missed = sink.since(lastEventId);
        for (const event of missed) {
          await stream.writeSSE({
            id: String(event.id),
            data: JSON.stringify(event),
          });
        }
      }

      // Subscribe to live events
      let closed = false;
      const unsubscribe = sink.subscribe(async (event) => {
        if (closed) return;
        try {
          await stream.writeSSE({
            id: String(event.id),
            data: JSON.stringify(event),
          });
        } catch {
          closed = true;
        }
      });

      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });

      // Keep alive until client disconnects
      while (!closed) {
        await stream.sleep(30_000);
      }
    });
  });
}
