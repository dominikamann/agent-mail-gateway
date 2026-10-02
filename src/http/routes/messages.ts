import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { toUtc } from '../../calendar/time.js';
import {
  deleteMessage,
  getAttachment,
  getMessage,
  listMessages,
  markMessage,
} from '../../services/messages.js';
import { dateTimeString, sendMessageSchema } from '../../services/schemas.js';
import { sendMessage } from '../../services/send.js';
import { mailboxOf } from '../auth.js';

const idParams = z.object({ id: z.string() });
const tags = ['messages'];

export const messageRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/messages',
    {
      schema: {
        tags,
        summary: 'List allowed messages in INBOX, newest first',
        querystring: z.object({
          unread: z.stringbool().optional(),
          since: z.union([z.iso.date(), dateTimeString]).optional(),
          limit: z.coerce.number().int().min(1).max(50).default(20),
          cursor: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const ctx = mailboxOf(req);
      const q = req.query;
      const since = q.since
        ? toUtc(q.since.length === 10 ? `${q.since}T00:00` : q.since, ctx.config.timezone)
        : undefined;
      return listMessages(ctx, { unread: q.unread, since, limit: q.limit, cursor: q.cursor });
    },
  );

  app.get(
    '/messages/:id',
    {
      schema: {
        tags,
        summary: 'Read a message as Markdown',
        params: idParams,
        querystring: z.object({ mark_read: z.stringbool().default(true) }),
      },
    },
    async (req) => getMessage(mailboxOf(req), req.params.id, req.query.mark_read),
  );

  app.get(
    '/messages/:id/attachments/:index',
    {
      schema: {
        tags,
        summary: 'Download an attachment',
        params: z.object({ id: z.string(), index: z.coerce.number().int().min(0) }),
      },
    },
    async (req, reply) => {
      const a = await getAttachment(mailboxOf(req), req.params.id, req.params.index);
      return reply
        .type(a.contentType)
        .header(
          'content-disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
        )
        .send(a.content);
    },
  );

  app.patch(
    '/messages/:id',
    {
      schema: {
        tags,
        summary: 'Mark read or unread',
        params: idParams,
        body: z.object({ unread: z.boolean() }),
      },
    },
    async (req) => {
      await markMessage(mailboxOf(req), req.params.id, req.body.unread);
      return { ok: true };
    },
  );

  app.delete(
    '/messages/:id',
    { schema: { tags, summary: 'Move to Trash (requires allow_delete)', params: idParams } },
    async (req) => {
      await deleteMessage(mailboxOf(req), req.params.id);
      return { ok: true };
    },
  );

  app.post(
    '/messages',
    { schema: { tags, summary: 'Send a message written in Markdown', body: sendMessageSchema } },
    async (req) => sendMessage(mailboxOf(req), req.body),
  );
};
