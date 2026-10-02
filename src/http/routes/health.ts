import type { FastifyInstance } from 'fastify';
import type { Gateway } from '../../services/gateway.js';

export function registerHealth(app: FastifyInstance, gateway: Gateway): void {
  app.get('/health', { schema: { hide: true } }, async () => {
    const mailboxes = gateway.contexts.map((c) => ({ name: c.config.name, state: c.imap.state() }));
    const status = mailboxes.every((m) => m.state === 'connected') ? 'ok' : 'degraded';
    return { status, mailboxes };
  });
}
