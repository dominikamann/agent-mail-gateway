import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { resolveSince } from '../calendar/time.js';
import { GatewayError } from '../errors.js';
import { authenticate } from '../http/auth.js';
import { forwardMessage, replyMessage, respondToInvitation } from '../services/compose.js';
import type { MailboxContext } from '../services/context.js';
import { cancelEvent, createEvent, getEvent, listEvents, updateEvent } from '../services/events.js';
import type { Gateway } from '../services/gateway.js';
import {
  deleteMessage,
  getAttachment,
  getMessage,
  listMessages,
  mailboxInfo,
  markMessage,
} from '../services/messages.js';
import {
  eventPatchSchema,
  eventShape,
  forwardSchema,
  forwardShape,
  replySchema,
  replyShape,
  rsvpShape,
  searchShape,
  sendMessageSchema,
  sendMessageShape,
} from '../services/schemas.js';
import { sendMessage } from '../services/send.js';
import { VERSION } from '../version.js';

type ToolResult = {
  content: (
    | { type: 'text'; text: string }
    | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } }
  )[];
  isError?: boolean;
};

const json = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GatewayError) {
      return {
        ...json({ error: err.code, message: err.message, details: err.details }),
        isError: true,
      };
    }
    throw err;
  }
}

function searchQuery(
  ctx: MailboxContext,
  a: {
    text?: string;
    from?: string;
    subject?: string;
    since?: string;
    before?: string;
    unread?: boolean;
    limit: number;
    cursor?: string;
  },
) {
  const tz = ctx.config.timezone;
  return {
    text: a.text,
    from: a.from,
    subject: a.subject,
    unread: a.unread,
    since: a.since ? resolveSince(a.since, tz) : undefined,
    before: a.before ? resolveSince(a.before, tz) : undefined,
    limit: a.limit,
    cursor: a.cursor,
  };
}

export function createMcpServer(ctx: MailboxContext): McpServer {
  const server = new McpServer({ name: 'agent-mail-gateway', version: VERSION });
  const id = z.string().describe('Message id from list_messages');

  server.registerTool(
    'get_mailbox_info',
    {
      description: 'Your mailbox address and who you may receive mail from and send mail to.',
      inputSchema: {},
    },
    async () => run(async () => json(mailboxInfo(ctx))),
  );

  server.registerTool(
    'list_messages',
    {
      description:
        'List received messages (newest first). Only mail from allowed senders is visible.',
      inputSchema: searchShape,
    },
    async (a) => run(async () => json(await listMessages(ctx, searchQuery(ctx, a)))),
  );

  server.registerTool(
    'search_messages',
    {
      description:
        'Search received messages by text, sender, subject and/or date range (newest first). At least one criterion is required.',
      inputSchema: searchShape,
    },
    async (a) =>
      run(async () => {
        if (!a.text && !a.from && !a.subject && !a.since && !a.before) {
          throw new GatewayError(
            'validation_error',
            'Give at least one of text, from, subject, since or before',
          );
        }
        return json(await listMessages(ctx, searchQuery(ctx, a)));
      }),
  );

  server.registerTool(
    'reply_message',
    {
      description:
        'Reply to a received message in the same thread. Recipients (sender, or everyone with reply_all) and the "Re:" subject are filled in for you.',
      inputSchema: { id: z.string().describe('Message id to reply to'), ...replyShape },
    },
    async ({ id: messageId, ...rest }) =>
      run(async () => json(await replyMessage(ctx, messageId, replySchema.parse(rest)))),
  );

  server.registerTool(
    'forward_message',
    {
      description:
        'Forward a received message (original text and, by default, its attachments) with an optional note.',
      inputSchema: { id: z.string().describe('Message id to forward'), ...forwardShape },
    },
    async ({ id: messageId, ...rest }) =>
      run(async () => json(await forwardMessage(ctx, messageId, forwardSchema.parse(rest)))),
  );

  server.registerTool(
    'respond_to_invitation',
    {
      description:
        'Accept, decline or tentatively accept a calendar invitation you received (read_message shows it under "invitation"). The organizer gets a standard calendar reply.',
      inputSchema: { id: z.string().describe('Message id of the invitation'), ...rsvpShape },
    },
    async (a) => run(async () => json(await respondToInvitation(ctx, a.id, a.response, a.comment))),
  );

  server.registerTool(
    'read_message',
    {
      description:
        'Read one message with its body as Markdown. Marks it as read unless mark_read is false.',
      inputSchema: { id, mark_read: z.boolean().default(true) },
    },
    async (a) => run(async () => json(await getMessage(ctx, a.id, a.mark_read))),
  );

  server.registerTool(
    'get_attachment',
    {
      description: 'Download an attachment of a message.',
      inputSchema: { id, index: z.number().int().min(0) },
    },
    async (a) =>
      run(async () => {
        const att = await getAttachment(ctx, a.id, a.index);
        return {
          content: [
            {
              type: 'resource',
              resource: {
                uri: `attachment://${a.id}/${a.index}/${encodeURIComponent(att.filename)}`,
                mimeType: att.contentType,
                blob: att.content.toString('base64'),
              },
            },
          ],
        };
      }),
  );

  server.registerTool(
    'mark_message',
    { description: 'Mark a message as read or unread.', inputSchema: { id, unread: z.boolean() } },
    async (a) =>
      run(async () => {
        await markMessage(ctx, a.id, a.unread);
        return json({ ok: true });
      }),
  );

  server.registerTool(
    'delete_message',
    {
      description: 'Move a message to Trash (only if the mailbox allows deleting).',
      inputSchema: { id },
    },
    async (a) =>
      run(async () => {
        await deleteMessage(ctx, a.id);
        return json({ ok: true });
      }),
  );

  server.registerTool(
    'send_message',
    {
      description:
        'Send an email written in Markdown. Every recipient must be on the allow list. Attachments are base64.',
      inputSchema: sendMessageShape,
    },
    async (a) => run(async () => json(await sendMessage(ctx, sendMessageSchema.parse(a)))),
  );

  server.registerTool(
    'create_event',
    {
      description:
        'Send a calendar invitation. Times without offset use the given or mailbox time zone.',
      inputSchema: eventShape,
    },
    async (a) => run(async () => json(await createEvent(ctx, a))),
  );

  server.registerTool(
    'update_event',
    {
      description: 'Change an event you created; attendees get an updated invitation.',
      inputSchema: { id: z.string(), ...eventPatchSchema.shape },
    },
    async ({ id: eventId, ...patch }) =>
      run(async () => json(await updateEvent(ctx, eventId, patch))),
  );

  server.registerTool(
    'cancel_event',
    {
      description: 'Cancel an event you created; attendees get a cancellation.',
      inputSchema: { id: z.string() },
    },
    async (a) => run(async () => json(await cancelEvent(ctx, a.id))),
  );

  server.registerTool(
    'get_event',
    {
      description: 'One event you created, with who accepted, declined or answered tentatively.',
      inputSchema: { id: z.string() },
    },
    async (a) => run(async () => json(getEvent(ctx, a.id))),
  );

  server.registerTool(
    'list_events',
    { description: 'Events created by this mailbox.', inputSchema: {} },
    async () => run(async () => json({ events: listEvents(ctx) })),
  );

  return server;
}

export function registerMcp(app: FastifyInstance, gateway: Gateway): void {
  app.post('/mcp', { schema: { hide: true } }, async (req, reply) => {
    const ctx = authenticate(gateway, req);
    const server = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  const notAllowed = async (_req: unknown, reply: FastifyReply) =>
    reply.status(405).send({
      error: 'method_not_allowed',
      message: 'Use POST for MCP requests',
      details: {},
    });
  app.get('/mcp', { schema: { hide: true } }, notAllowed);
  app.delete('/mcp', { schema: { hide: true } }, notAllowed);
}
