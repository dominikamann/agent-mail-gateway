import { z } from 'zod';

export const dateTimeString = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/i,
    'ISO 8601 date-time, e.g. 2026-10-05T14:00 or 2026-10-05T14:00:00+02:00',
  );

export const sinceString = z
  .union([z.iso.date(), dateTimeString])
  .describe('Only messages received at or after this date (YYYY-MM-DD) or date-time');

const email = z.email();

export const attachmentInput = z.object({
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).default('application/octet-stream'),
  content_base64: z.base64(),
});

export const sendMessageShape = {
  to: z.array(email).min(1).describe('Recipients; every address must be on allow_send_to'),
  cc: z.array(email).default([]),
  bcc: z.array(email).default([]),
  subject: z.string().max(998),
  body_markdown: z.string().describe('Message body in Markdown'),
  attachments: z.array(attachmentInput).default([]),
  reply_to_id: z.string().optional().describe('id of a received message this replies to'),
};
export const sendMessageSchema = z.object(sendMessageShape);
export type SendMessageInput = z.output<typeof sendMessageSchema>;

export const eventShape = {
  title: z.string().min(1).max(500),
  start: dateTimeString,
  end: dateTimeString,
  timezone: z
    .string()
    .optional()
    .describe('IANA zone for times without offset; defaults to the mailbox timezone'),
  location: z.string().max(500).optional(),
  description_markdown: z.string().optional(),
  attendees: z.array(email).min(1),
};
export const eventSchema = z.object(eventShape);
export const eventPatchSchema = eventSchema.partial();
export type EventInput = z.output<typeof eventSchema>;
export type EventPatch = z.output<typeof eventPatchSchema>;

export const searchShape = {
  text: z.string().min(1).optional().describe('Words to find in subject, sender or body'),
  from: z.string().min(1).optional().describe('Sender address or part of it'),
  subject: z.string().min(1).optional().describe('Words in the subject'),
  since: sinceString.optional(),
  before: sinceString.optional().describe('Only messages received before this date or date-time'),
  unread: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().optional().describe('next_cursor from a previous call'),
};

export const replyShape = {
  body_markdown: z
    .string()
    .describe('Reply text in Markdown; the original is not quoted automatically'),
  reply_all: z
    .boolean()
    .default(false)
    .describe('Also reply to everyone in To and Cc of the original'),
  attachments: z.array(attachmentInput).default([]),
};
export const replySchema = z.object(replyShape);

export const forwardShape = {
  to: z.array(email).min(1),
  cc: z.array(email).default([]),
  bcc: z.array(email).default([]),
  body_markdown: z.string().optional().describe('Your note above the forwarded message'),
  include_attachments: z.boolean().default(true),
};
export const forwardSchema = z.object(forwardShape);

export const rsvpShape = {
  response: z.enum(['accept', 'decline', 'tentative']),
  comment: z.string().optional().describe('Optional message to the organizer'),
};
export const rsvpSchema = z.object(rsvpShape);
