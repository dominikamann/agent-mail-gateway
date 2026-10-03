import type { FastifyInstance } from 'fastify';
import type { Gateway } from '../../services/gateway.js';

/**
 * Overall status for health checks, without a key. With a mailbox key, also that mailbox's
 * connection state (mailbox names are not shown to anyone without a key).
 */
export function registerHealth(app: FastifyInstance, gateway: Gateway): void {
  app.get('/health', { schema: { hide: true } }, async (req) => {
    const status = (states: string[]) =>
      states.every((s) => s === 'connected') ? 'ok' : 'degraded';
    const key = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '')?.[1];
    const ctx = key ? gateway.byKey(key) : null;
    if (!ctx) return { status: status(gateway.contexts.map((c) => c.imap.state())) };
    const state = ctx.imap.state();
    return { status: status([state]), mailboxes: [{ name: ctx.config.name, state }] };
  });
}
