import { GatewayError } from '../errors.js';
import { fingerprint, reviewMessage } from '../review/review.js';
import type { MailboxContext } from './context.js';
import { assertRecipientsAllowed, deliver } from './deliver.js';
import { loadAllowed } from './messages.js';
import type { AttachmentInput, SendMessageInput } from './schemas.js';

const CALENDAR = /^(text\/calendar|application\/ics)/i;
const tooLarge = (ctx: MailboxContext) =>
  new GatewayError('attachment_too_large', `Attachments exceed ${ctx.config.max_attachment_mb} MB`);

/**
 * Turns text, base64 or "file from a received message" into attachment bytes. Stops as soon as
 * the size limit is exceeded and loads each referenced message only once. `text` is set for
 * text written by the agent, so policies can check it.
 */
async function resolveAttachments(ctx: MailboxContext, list: AttachmentInput[]) {
  const limit = ctx.config.max_attachment_mb * 1024 * 1024;
  const loaded = new Map<string, Awaited<ReturnType<typeof loadAllowed>>>();
  const out: { filename: string; contentType: string; content: Buffer; text?: string }[] = [];
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
      out.push({
        filename: a.filename ?? original.filename,
        contentType: a.content_type ?? original.contentType,
        content: original.content,
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
      const type = a.content_type ?? 'application/octet-stream';
      const isText = /^text\//i.test(type) || /^application\/(json|xml|csv)/i.test(type);
      out.push({
        filename: a.filename!,
        contentType: type,
        content,
        ...(isText ? { text: content.toString('utf8') } : {}),
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
    })),
  };
  // Stage 1 rules and optional stage 2 LLM; throws review_rejected before any send slot is used.
  const reviewWarnings = await reviewMessage(ctx, {
    ...draft,
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
  ctx.store.recordFingerprint(ctx.config.name, fingerprint(recipients, draft), ctx.now());
  return { message_id: messageId, warnings: [...reviewWarnings, ...warnings] };
}
