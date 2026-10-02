import type { FastifyRequest } from 'fastify';
import { GatewayError } from '../errors.js';
import type { MailboxContext } from '../services/context.js';
import type { Gateway } from '../services/gateway.js';

declare module 'fastify' {
  interface FastifyRequest {
    mailbox: MailboxContext | null;
  }
}

export function authenticate(gateway: Gateway, req: FastifyRequest): MailboxContext {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  const ctx = match ? gateway.byKey(match[1]!) : null;
  if (!ctx) throw new GatewayError('unauthorized', 'Missing or invalid API key');
  return ctx;
}

export function mailboxOf(req: FastifyRequest): MailboxContext {
  if (!req.mailbox) throw new GatewayError('unauthorized', 'Missing or invalid API key');
  return req.mailbox;
}
