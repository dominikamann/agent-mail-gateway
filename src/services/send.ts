import { asText, extractText, isPdf } from '../attachments/extract.js';
import { dangerousAttachment } from '../attachments/filetype.js';
import { GatewayError } from '../errors.js';
import { isCalendarFile } from '../mail/parse.js';
import { fingerprint, reviewMessage, scanOutgoing } from '../review/review.js';
import type { MailboxContext } from './context.js';
import { assertRecipientsAllowed, assertSendCapacity, deliver } from './deliver.js';
import { assertNotBlocked, loadAllowed } from './messages.js';
import type { AttachmentInput, SendMessageInput } from './schemas.js';

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
      assertNotBlocked(source.verdict, a.from_message.index);
      if (isCalendarFile(original)) {
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

/**
 * Text of PDFs and images for the policies (only when policies are configured: reading images
 * may call a model). A file that cannot be read stays as it was (binary, if the agent wrote it).
 */
async function readForPolicies(
  ctx: MailboxContext,
  files: Awaited<ReturnType<typeof resolveAttachments>>,
): Promise<void> {
  if (!ctx.config.review.policies) return;
  for (const f of files) {
    if (f.text !== undefined) continue;
    if (!isPdf(f) && !ctx.config.attachments.read_images) continue;
    try {
      const text = await extractText(f, {
        readImages: ctx.config.attachments.read_images,
        fetch: ctx.fetch,
        dataDir: ctx.dataDir,
      });
      if (text) {
        f.text = text;
        delete f.binary;
      }
    } catch (err) {
      ctx.log.warn(
        { mailbox: ctx.config.name, err: (err as Error).message },
        'could not read file',
      );
    }
  }
}

export async function sendMessage(
  ctx: MailboxContext,
  input: SendMessageInput,
): Promise<{ message_id: string; warnings: string[] }> {
  assertRecipientsAllowed(ctx, [...input.to, ...input.cc, ...input.bcc]);

  const attachments = await resolveAttachments(ctx, input.attachments);
  const blockedExtensions = ctx.config.attachments.blocked_extensions;
  const dangerous = attachments.map((a) =>
    dangerousAttachment(a.filename, a.content, blockedExtensions),
  );

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
    await scanOutgoing(ctx, attachments, recipients);
    await readForPolicies(ctx, attachments);
    // Stage 1 rules and optional stage 2 LLM; throws review_rejected before any send slot is used.
    const reviewWarnings = await reviewMessage(ctx, {
      ...draft,
      attachments: attachments.map((a, i) => ({
        filename: a.filename,
        size: a.content.length,
        ...(a.text !== undefined ? { text: a.text } : {}),
        ...(a.binary ? { binary: true } : {}),
        ...(dangerous[i] ? { dangerous: dangerous[i]! } : {}),
      })),
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
