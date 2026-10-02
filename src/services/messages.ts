import { GatewayError } from '../errors.js';
import { decodeMessageId, encodeMessageId } from '../mail/ids.js';
import type { FetchedMessage, MessageMeta } from '../mail/imap.js';
import { type ParsedMessage, parseHeaders, parseMessage } from '../mail/parse.js';
import { decideInbound } from '../policy/inbound.js';
import { type MailboxContext, recordAudit } from './context.js';

export interface MessageSummary {
  id: string;
  from: string | null;
  from_name: string | null;
  to: string[];
  cc: string[];
  subject: string;
  date: string | null;
  preview: string;
  unread: boolean;
  has_attachments: boolean;
}

export interface MessageDetail extends MessageSummary {
  message_id: string | null;
  body_markdown: string;
  attachments: { index: number; filename: string; content_type: string; size: number }[];
}

export function mailboxInfo(ctx: MailboxContext) {
  const c = ctx.config;
  return {
    address: c.address,
    allow_receive_from: c.allow_receive_from,
    allow_send_to: c.allow_send_to,
    allow_delete: c.allow_delete,
    max_sends_per_hour: c.max_sends_per_hour,
    max_attachment_mb: c.max_attachment_mb,
    timezone: c.timezone,
  };
}

function summary(id: string, parsed: ParsedMessage, seen: boolean): MessageSummary {
  return {
    id,
    from: parsed.from,
    from_name: parsed.fromName,
    to: parsed.to,
    cc: parsed.cc,
    subject: parsed.subject,
    date: parsed.date,
    preview: parsed.preview,
    unread: !seen,
    has_attachments: parsed.attachments.length > 0,
  };
}

const notFound = () => new GatewayError('not_found', 'Message not found');

/** Messages larger than this are listed without a preview instead of being downloaded. */
export const PREVIEW_MAX_BYTES = 1024 * 1024;

/**
 * Parses an allowed message for a summary: the full source when it is small enough,
 * otherwise only its headers (no preview, attachments taken from the IMAP structure).
 */
export async function parseForSummary(
  ctx: MailboxContext,
  meta: MessageMeta,
  full?: FetchedMessage,
): Promise<ParsedMessage> {
  let source = full?.raw;
  if (!source && meta.size <= PREVIEW_MAX_BYTES) {
    source = (await ctx.imap.fetch([meta.uid]))[0]?.raw;
  }
  return parseMessage(source ?? Buffer.concat([meta.header, Buffer.from('\r\n\r\n')]));
}

const BATCH = 50;

export async function listMessages(
  ctx: MailboxContext,
  q: { unread?: boolean; since?: Date; limit: number; cursor?: string },
): Promise<{ messages: MessageSummary[]; next_cursor: string | null }> {
  const validity = await ctx.imap.uidValidity();
  let before = Number.POSITIVE_INFINITY;
  if (q.cursor) {
    const decoded = decodeMessageId(q.cursor);
    if (!decoded || decoded.uidValidity !== validity) {
      throw new GatewayError('validation_error', 'Invalid or expired cursor');
    }
    before = decoded.uid;
  }
  const candidates = (await ctx.imap.search({ unread: q.unread, since: q.since }))
    .filter((u) => u < before)
    .sort((a, b) => b - a);

  const messages: MessageSummary[] = [];
  let lastReturned: number | null = null;
  let i = 0;
  while (i < candidates.length && messages.length < q.limit) {
    const batch = candidates.slice(i, i + BATCH);
    i += batch.length;
    // Decide on headers only, so blocked mail is never downloaded.
    const allowed: MessageMeta[] = [];
    for (const meta of (await ctx.imap.fetchMeta(batch)).sort((a, b) => b.uid - a.uid)) {
      // IMAP SINCE only compares whole days; filter exactly on the arrival time.
      if (q.since && meta.internalDate && meta.internalDate < q.since) continue;
      if (!decideInbound(ctx.config, await parseHeaders(meta.header)).allowed) continue;
      allowed.push(meta);
      if (messages.length + allowed.length === q.limit) break;
    }
    const small = allowed.filter((m) => m.size <= PREVIEW_MAX_BYTES).map((m) => m.uid);
    const sources = new Map((await ctx.imap.fetch(small)).map((f) => [f.uid, f]));
    for (const meta of allowed) {
      let parsed: ParsedMessage;
      try {
        parsed = await parseForSummary(ctx, meta, sources.get(meta.uid));
      } catch (err) {
        ctx.log.warn(
          { mailbox: ctx.config.name, uid: meta.uid, err: (err as Error).message },
          'unparsable message skipped',
        );
        continue;
      }
      messages.push({
        ...summary(encodeMessageId(validity, meta.uid), parsed, meta.seen),
        has_attachments: meta.hasAttachments || parsed.attachments.length > 0,
      });
      lastReturned = meta.uid;
    }
  }
  const last = lastReturned;
  const more = messages.length === q.limit && last !== null && candidates.some((u) => u < last);
  return { messages, next_cursor: more && last !== null ? encodeMessageId(validity, last) : null };
}

export async function loadAllowed(
  ctx: MailboxContext,
  id: string,
): Promise<{ uid: number; seen: boolean; parsed: ParsedMessage }> {
  const decoded = decodeMessageId(id);
  if (!decoded) throw notFound();
  const validity = await ctx.imap.uidValidity();
  if (decoded.uidValidity !== validity) throw notFound();
  const [meta] = await ctx.imap.fetchMeta([decoded.uid]);
  if (!meta) throw notFound();
  if (!decideInbound(ctx.config, await parseHeaders(meta.header)).allowed) throw notFound();
  const [fetched] = await ctx.imap.fetch([decoded.uid]);
  if (!fetched) throw notFound();
  const parsed = await parseMessage(fetched.raw);
  return { uid: fetched.uid, seen: fetched.seen, parsed };
}

export async function getMessage(
  ctx: MailboxContext,
  id: string,
  markRead: boolean,
): Promise<MessageDetail> {
  const { uid, seen, parsed } = await loadAllowed(ctx, id);
  if (markRead && !seen) await ctx.imap.setSeen(uid, true);
  return {
    ...summary(id, parsed, markRead || seen),
    message_id: parsed.messageId,
    body_markdown: parsed.bodyMarkdown,
    attachments: parsed.attachments.map((a) => ({
      index: a.index,
      filename: a.filename,
      content_type: a.contentType,
      size: a.size,
    })),
  };
}

export async function getAttachment(ctx: MailboxContext, id: string, index: number) {
  const { parsed } = await loadAllowed(ctx, id);
  const a = parsed.attachments[index];
  if (!a) throw new GatewayError('not_found', 'Attachment not found');
  return { filename: a.filename, contentType: a.contentType, content: a.content };
}

export async function markMessage(ctx: MailboxContext, id: string, unread: boolean): Promise<void> {
  const { uid } = await loadAllowed(ctx, id);
  await ctx.imap.setSeen(uid, !unread);
}

export async function deleteMessage(ctx: MailboxContext, id: string): Promise<void> {
  if (!ctx.config.allow_delete) {
    throw new GatewayError('delete_not_allowed', 'Deleting is disabled for this mailbox');
  }
  const { uid, parsed } = await loadAllowed(ctx, id);
  await ctx.imap.moveToTrash(uid);
  recordAudit(ctx, 'delete', parsed.from ? [parsed.from] : [], 'ok');
}
