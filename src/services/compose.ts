import { buildReplyIcs } from '../calendar/ics.js';
import { GatewayError } from '../errors.js';
import { FORWARD_SEPARATOR, reviewMessage } from '../review/review.js';
import type { MailboxContext } from './context.js';
import { assertSendCapacity, deliver } from './deliver.js';
import { loadAllowed } from './messages.js';
import type { SendMessageInput } from './schemas.js';
import { sendMessage } from './send.js';

type Attachments = SendMessageInput['attachments'];

const unique = (list: string[]) => [...new Set(list.map((a) => a.toLowerCase()))];

/** Replies to a received message; recipients and subject come from the original. */
export async function replyMessage(
  ctx: MailboxContext,
  id: string,
  input: { body_markdown: string; reply_all: boolean; attachments: Attachments },
): Promise<{ message_id: string; warnings: string[] }> {
  const { parsed } = await loadAllowed(ctx, id);
  const self = ctx.config.address.toLowerCase();
  const to = unique(parsed.replyTo.length > 0 ? parsed.replyTo : parsed.from ? [parsed.from] : []);
  if (to.length === 0) {
    throw new GatewayError('validation_error', 'The original message has no sender to reply to');
  }
  const cc = input.reply_all
    ? unique([...parsed.to, ...parsed.cc]).filter((a) => a !== self && !to.includes(a))
    : [];
  return sendMessage(ctx, {
    to,
    cc,
    bcc: [],
    subject: parsed.subject,
    body_markdown: input.body_markdown,
    attachments: input.attachments,
    reply_to_id: id,
  });
}

/** Forwards a received message with an optional note, the original text and its attachments. */
export async function forwardMessage(
  ctx: MailboxContext,
  id: string,
  input: {
    to: string[];
    cc: string[];
    bcc: string[];
    body_markdown?: string;
    include_attachments: boolean;
  },
): Promise<{ message_id: string; warnings: string[] }> {
  const { parsed } = await loadAllowed(ctx, id);
  const sender = parsed.fromName
    ? `${parsed.fromName} <${parsed.from}>`
    : (parsed.from ?? 'unknown');
  const header = [
    FORWARD_SEPARATOR,
    `From: ${sender}`,
    ...(parsed.date ? [`Date: ${parsed.date}`] : []),
    `Subject: ${parsed.subject}`,
    ...(parsed.to.length ? [`To: ${parsed.to.join(', ')}`] : []),
  ].join('  \n');
  const body = [input.body_markdown?.trim(), header, parsed.bodyMarkdown]
    .filter(Boolean)
    .join('\n\n');
  const attachments = input.include_attachments
    ? parsed.attachments
        .filter(
          (a) =>
            !/^(text\/calendar|application\/ics)/i.test(a.contentType) &&
            !/\.ics$/i.test(a.filename),
        )
        .map((a) => ({
          filename: a.filename,
          content_type: a.contentType,
          content_base64: a.content.toString('base64'),
        }))
    : [];
  return sendMessage(ctx, {
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: /^\s*(fwd?|wg)\s*:/i.test(parsed.subject) ? parsed.subject : `Fwd: ${parsed.subject}`,
    body_markdown: body,
    attachments,
  });
}

const PARTSTAT = { accept: 'ACCEPTED', decline: 'DECLINED', tentative: 'TENTATIVE' } as const;
const VERB = { accept: 'Accepted', decline: 'Declined', tentative: 'Tentative' } as const;

/** Answers a received calendar invitation (iCalendar REPLY to the organizer). */
export async function respondToInvitation(
  ctx: MailboxContext,
  id: string,
  response: 'accept' | 'decline' | 'tentative',
  comment?: string,
): Promise<{ message_id: string; warnings: string[] }> {
  const { parsed } = await loadAllowed(ctx, id);
  const inv = parsed.invitation;
  if (!inv || (inv.method !== null && inv.method !== 'REQUEST')) {
    throw new GatewayError('validation_error', 'This message contains no invitation to answer');
  }
  if (!inv.organizer || !inv.start) {
    throw new GatewayError('validation_error', 'The invitation has no organizer or start time');
  }
  // A comment is free text written by the agent: it goes through the same review as any mail.
  const note = comment?.trim() || null;
  assertSendCapacity(ctx);
  const reviewWarnings = note
    ? await reviewMessage(ctx, {
        to: [inv.organizer],
        cc: [],
        bcc: [],
        subject: `${VERB[response]}: ${inv.title}`,
        body_markdown: note,
        attachments: [],
        replyTo: { from: parsed.from, subject: parsed.subject, body_markdown: parsed.bodyMarkdown },
      })
    : [];
  const content = buildReplyIcs({
    uid: inv.uid,
    sequence: inv.sequence,
    title: inv.title,
    start: inv.start,
    end: inv.end,
    allDay: inv.allDay,
    organizer: inv.organizer,
    attendee: ctx.config.address,
    partstat: PARTSTAT[response],
    comment: note,
  });
  const { messageId, warnings } = await deliver(
    ctx,
    {
      to: [inv.organizer],
      cc: [],
      bcc: [],
      subject: `${VERB[response]}: ${inv.title}`,
      markdown:
        note ??
        `${ctx.config.address} ${VERB[response].toLowerCase()} the invitation "${inv.title}".`,
      attachments: [],
      inReplyTo: parsed.messageId ?? undefined,
      icalEvent: { method: 'REPLY', content },
    },
    'send',
  );
  return { message_id: messageId, warnings: [...reviewWarnings, ...warnings] };
}
