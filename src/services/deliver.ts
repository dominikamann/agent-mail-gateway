import { markdownToHtml } from '../convert/md-to-html.js';
import { GatewayError } from '../errors.js';
import { composeMail } from '../mail/smtp.js';
import { disallowed } from '../policy/address.js';
import { type MailboxContext, recordAudit } from './context.js';

export interface DeliverInput {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  markdown: string;
  attachments: { filename: string; contentType: string; content: Buffer }[];
  inReplyTo?: string;
  references?: string[];
  icalEvent?: { method: 'REQUEST' | 'CANCEL'; content: string };
}

const HOUR_MS = 3_600_000;

export function assertRecipientsAllowed(ctx: MailboxContext, addresses: string[]): void {
  const bad = disallowed(addresses, ctx.config.allow_send_to);
  if (bad.length > 0) {
    recordAudit(ctx, 'send_rejected', bad, 'rejected', 'recipient_not_allowed');
    throw new GatewayError('recipient_not_allowed', 'One or more recipients are not allowed', {
      addresses: bad,
    });
  }
}

function assertRateLimit(ctx: MailboxContext): void {
  const limit = ctx.config.max_sends_per_hour;
  if (limit === 0) return;
  const now = ctx.now();
  const recent = ctx.store.sendsSince(ctx.config.name, now - HOUR_MS + 1);
  if (recent.length >= limit) {
    const retryAfterMs = recent[0]! + HOUR_MS - now;
    throw new GatewayError('rate_limited', `Send limit of ${limit} per hour reached`, {
      retry_after_seconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    });
  }
}

export async function deliver(
  ctx: MailboxContext,
  input: DeliverInput,
  action: 'send' | 'event_create' | 'event_update' | 'event_cancel',
): Promise<{ messageId: string; warnings: string[] }> {
  const recipients = [
    ...new Set([...input.to, ...input.cc, ...input.bcc].map((a) => a.toLowerCase())),
  ];
  assertRecipientsAllowed(ctx, recipients);
  assertRateLimit(ctx);

  const { raw, messageId } = await composeMail({
    from: ctx.config.address,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    html: markdownToHtml(input.markdown),
    text: input.markdown,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments: input.attachments,
    icalEvent: input.icalEvent,
  });

  try {
    await ctx.smtp.send({ from: ctx.config.address, to: recipients }, raw);
  } catch (err) {
    recordAudit(ctx, action, recipients, 'error', (err as Error).message);
    throw new GatewayError('send_failed', 'The mail server did not accept the message');
  }
  ctx.store.recordSend(ctx.config.name, ctx.now());

  const warnings: string[] = [];
  try {
    await ctx.imap.appendToSent(raw);
  } catch (err) {
    ctx.log.warn({ mailbox: ctx.config.name, err: (err as Error).message }, 'copy to Sent failed');
    warnings.push('copy_to_sent_failed');
  }
  recordAudit(ctx, action, recipients, 'ok');
  return { messageId, warnings };
}
