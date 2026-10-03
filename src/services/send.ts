import { GatewayError } from '../errors.js';
import { fingerprint, reviewMessage } from '../review/review.js';
import type { MailboxContext } from './context.js';
import { assertRecipientsAllowed, deliver } from './deliver.js';
import { loadAllowed } from './messages.js';
import type { AttachmentInput, SendMessageInput } from './schemas.js';

/** Turns text, base64 or "file from a received message" into attachment bytes. */
async function resolveAttachments(ctx: MailboxContext, list: AttachmentInput[]) {
  const out: { filename: string; contentType: string; content: Buffer }[] = [];
  for (const a of list) {
    if (a.from_message) {
      const { parsed } = await loadAllowed(ctx, a.from_message.id);
      const original = parsed.attachments[a.from_message.index];
      if (!original) throw new GatewayError('not_found', 'Attachment not found');
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
      });
    } else {
      out.push({
        filename: a.filename!,
        contentType: a.content_type ?? 'application/octet-stream',
        content: Buffer.from(a.content_base64!, 'base64'),
      });
    }
  }
  return out;
}

export async function sendMessage(
  ctx: MailboxContext,
  input: SendMessageInput,
): Promise<{ message_id: string; warnings: string[] }> {
  assertRecipientsAllowed(ctx, [...input.to, ...input.cc, ...input.bcc]);

  const attachments = await resolveAttachments(ctx, input.attachments);
  const total = attachments.reduce((sum, a) => sum + a.content.length, 0);
  if (total > ctx.config.max_attachment_mb * 1024 * 1024) {
    throw new GatewayError(
      'attachment_too_large',
      `Attachments exceed ${ctx.config.max_attachment_mb} MB`,
    );
  }

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
    attachments: attachments.map((a) => ({ filename: a.filename, size: a.content.length })),
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
