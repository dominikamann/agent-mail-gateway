import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { mailboxInfo } from '../../services/messages.js';
import { mailboxOf } from '../auth.js';

export const mailboxRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/mailbox',
    { schema: { tags: ['mailbox'], summary: 'Mailbox address, allow lists and limits' } },
    async (req) => mailboxInfo(mailboxOf(req)),
  );
};
