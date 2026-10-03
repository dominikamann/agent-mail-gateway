import { GatewayError } from '../errors.js';
import { fingerprint, reviewMessage } from '../review/review.js';
import type { MailboxContext } from './context.js';
import { assertRecipientsAllowed, assertSendCapacity, deliver } from './deliver.js';
import { loadAllowed } from './messages.js';
import type { AttachmentInput, SendMessageInput } from './schemas.js';

/**
 * The content as text if it is UTF-8, UTF-16 (with BOM) or Windows-1252 text with few control
 * characters, else null. Compressed or binary data has far more control bytes and stays binary.
 */
function asText(content: Buffer): string | null {
  let text: string;
  try {
    if (content[0] === 0xff && content[1] === 0xfe)
      text = new TextDecoder('utf-16le', { fatal: true }).decode(content);
    else if (content[0] === 0xfe && content[1] === 0xff)
      text = new TextDecoder('utf-16be', { fatal: true }).decode(content);
    else text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    // Not UTF: e.g. a CSV exported by Excel. Windows-1252 decodes every byte.
    text = new TextDecoder('windows-1252').decode(content);
  }
  let control = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 9 || (c > 13 && c < 32)) control++;
  }
  return control <= text.length * 0.01 ? text : null;
}

const CALENDAR = /^(text\/calendar|application\/ics)/i;
const tooLarge = (ctx: MailboxContext) =>
  new GatewayError('attachment_too_large', `Attachments exceed ${ctx.config.max_attachment_mb} MB`);

/**
 * Turns text, base64 or "file from a received message" into attachment bytes. Stops as soon as
 * the size limit is exceeded and loads each referenced message only once. `text` is set for
 * every text file, so policies can check it; `binary` only for unreadable files the agent wrote.
 */
async function resolveAttachments(ctx: MailboxContext, list: AttachmentInput[]) {
  const limit = ctx.config.max_attachment_mb * 1024 * 1024;
  const loaded = new Map<string, Awaited<ReturnType<typeof loadAllowed>>>();
  const out: {
    filename: string;
    contentType: string;
    content: Buffer;
    text?: string;
    binary?: boolean;
  }[] = [];
  let total = 0;
  for (const a of list) {
    if (a.from_message) {
      let source = loaded.get(a.from_message.id);
      if (!source) {
        source = await loadAllowed(ctx, a.from_message.id);
        loaded.set(a.from_message.id, source);
      }
      const original = source.parsed.attachments[a.from_message.index];
      if (!original) throw new GatewayError('not_found', 'Attachment not found');
      if (CALENDAR.test(original.contentType) || /\.ics$/i.test(original.filename)) {
        throw new GatewayError(
          'validation_error',
          'Calendar files from received mail cannot be re-attached; use respond_to_invitation or create_event',
        );
      }
      // Received files: text is policy-checked; binaries are never blocked (not the agent's).
      const text = asText(original.content);
      out.push({
        filename: a.filename ?? original.filename,
        contentType: a.content_type ?? original.contentType,
        content: original.content,
        ...(text !== null ? { text } : {}),
      });
    } else if (a.content_text !== undefined) {
      out.push({
        filename: a.filename!,
        contentType: a.content_type ?? 'text/plain; charset=utf-8',
        content: Buffer.from(a.content_text, 'utf8'),
        text: a.content_text,
      });
    } else {
      const content = Buffer.from(a.content_base64!, 'base64');
      const text = asText(content);
      out.push({
        filename: a.filename!,
        contentType: a.content_type ?? 'application/octet-stream',
        content,
        // Whatever the declared type: if it reads as text, policies check it.
        ...(text !== null ? { text } : { binary: true }),
      });
    }
    total += out[out.length - 1]!.content.length;
    if (total > limit) throw tooLarge(ctx);
  }
  return out;
}

export async function sendMessage(
  ctx: MailboxContext,
  input: SendMessageInput,
): Promise<{ message_id: string; warnings: string[] }> {
  assertRecipientsAllowed(ctx, [...input.to, ...input.cc, ...input.bcc]);

  const attachments = await resolveAttachments(ctx, input.attachments);

  let subject = input.subject;
  let inReplyTo: string | undefined;
  let references: string[] | undefined;
  let replyTo: { from: string | null; subject: string; body_markdown: string } | undefined;
  if (input.reply_to_id) {
    const { parsed } = await loadAllowed(ctx, input.reply_to_id);
    replyTo = { from: parsed.from, subject: parsed.subject, body_markdown: parsed.bodyMarkdown };
    if (parsed.messageId) {
      inReplyTo = parsed.messageId;
      references = [...parsed.references, parsed.messageId];
    }
    // Re (en), AW/Antw (de), SV (sv/no/da), VS (fi), Odp (pl), Rif (it), RE/Réf (fr)
    if (!/^\s*(re|aw|antw|sv|vs|odp|rif|réf)\s*:/i.test(subject)) subject = `Re: ${subject}`;
  }

  const recipients = [...input.to, ...input.cc, ...input.bcc];
  const draft = {
    subject,
    body_markdown: input.body_markdown,
    attachments: attachments.map((a) => ({
      filename: a.filename,
      size: a.content.length,
      ...(a.text !== undefined ? { text: a.text } : {}),
      ...(a.binary ? { binary: true } : {}),
    })),
  };
  // No review (and no model calls) when the send limit is already reached.
  assertSendCapacity(ctx);
  // The same message already on its way (review or SMTP still running) counts as a duplicate.
  const fp = fingerprint(recipients, draft);
  const sending = inFlight(ctx);
  const duplicateInFlight = (sending.get(fp) ?? 0) > 0;
  sending.set(fp, (sending.get(fp) ?? 0) + 1);
  try {
    return await reviewAndSend();
  } finally {
    const left = (sending.get(fp) ?? 1) - 1;
    if (left > 0) sending.set(fp, left);
    else sending.delete(fp);
  }

  async function reviewAndSend(): Promise<{ message_id: string; warnings: string[] }> {
    // Stage 1 rules and optional stage 2 LLM; throws review_rejected before any send slot is used.
    const reviewWarnings = await reviewMessage(ctx, {
      ...draft,
      duplicateInFlight,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      replyTo,
    });

    const { messageId, warnings } = await deliver(
      ctx,
      {
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject,
        markdown: input.body_markdown,
        attachments,
        inReplyTo,
        references,
      },
      'send',
    );
    ctx.store.recordFingerprint(ctx.config.name, fp, ctx.now());
    return { message_id: messageId, warnings: [...reviewWarnings, ...warnings] };
  }
}

/** Fingerprints of messages being reviewed or sent right now (with count), per mailbox. */
const sendingByMailbox = new WeakMap<MailboxContext, Map<string, number>>();
function inFlight(ctx: MailboxContext): Map<string, number> {
  let map = sendingByMailbox.get(ctx);
  if (!map) {
    map = new Map();
    sendingByMailbox.set(ctx, map);
  }
  return map;
}
