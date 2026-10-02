import { GatewayError } from '../errors.js';
import { fingerprint, reviewMessage } from '../review/review.js';
import type { MailboxContext } from './context.js';
import { assertRecipientsAllowed, deliver } from './deliver.js';
import { loadAllowed } from './messages.js';
import type { SendMessageInput } from './schemas.js';

export async function sendMessage(
  ctx: MailboxContext,
  input: SendMessageInput,
): Promise<{ message_id: string; warnings: string[] }> {
  assertRecipientsAllowed(ctx, [...input.to, ...input.cc, ...input.bcc]);

  const attachments = input.attachments.map((a) => ({
    filename: a.filename,
    contentType: a.content_type,
    content: Buffer.from(a.content_base64, 'base64'),
  }));
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
    if (!/^re:/i.test(subject)) subject = `Re: ${subject}`;
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
    recipients,
    headerLines: [
      `To: ${input.to.join(', ')}`,
      ...(input.cc.length ? [`Cc: ${input.cc.join(', ')}`] : []),
      ...(input.bcc.length ? [`Bcc: ${input.bcc.join(', ')}`] : []),
      `Subject: ${subject}`,
    ],
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
