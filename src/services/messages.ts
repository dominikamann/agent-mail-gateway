import { GatewayError } from '../errors.js';
import { decodeMessageId, encodeMessageId } from '../mail/ids.js';
import { type ParsedMessage, parseMessage } from '../mail/parse.js';
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
  let lastUid: number | null = null;
  let i = 0;
  while (i < candidates.length && messages.length < q.limit) {
    const batch = candidates.slice(i, i + q.limit);
    i += batch.length;
    const fetched = (await ctx.imap.fetch(batch)).sort((a, b) => b.uid - a.uid);
    for (const f of fetched) {
      lastUid = f.uid;
      const parsed = await parseMessage(f.raw);
      if (!decideInbound(ctx.config, parsed).allowed) continue;
      messages.push(summary(encodeMessageId(validity, f.uid), parsed, f.seen));
      if (messages.length === q.limit) break;
    }
  }
  const last = lastUid;
  const more = last !== null && candidates.some((u) => u < last);
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
  const [fetched] = await ctx.imap.fetch([decoded.uid]);
  if (!fetched) throw notFound();
  const parsed = await parseMessage(fetched.raw);
  if (!decideInbound(ctx.config, parsed).allowed) throw notFound();
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
