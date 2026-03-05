import { Hono } from 'hono';
import { monitorAlerts } from '../../domain/monitor';
import type { EventSink } from '../ws';

export function monitorRoutes(sink: EventSink) {
  return new Hono().get('/monitor/alerts', (c) => {
    const limit = Number.parseInt(c.req.query('limit') ?? '100', 10);
    const data = monitorAlerts(
      sink.list(1000),
      Number.isFinite(limit) ? limit : 100,
    );
    return c.json(data);
  });
}
