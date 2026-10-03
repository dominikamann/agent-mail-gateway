import { z } from 'zod';

/** Upper bound for text written by the agent (keeps rendering and review time bounded). */
const MAX_TEXT = 512_000;
const longText = () => z.string().max(MAX_TEXT, `at most ${MAX_TEXT} characters`);

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

export const attachmentInput = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe('File name; optional with from_message (the original name is used)'),
    content_type: z
      .string()
      .min(1)
      .optional()
      .describe('MIME type, e.g. text/csv or application/pdf'),
    content_text: z
      .string()
      .optional()
      .describe('File content as plain text (for txt, csv, md, json, ics, ...)'),
    content_base64: z.base64().optional().describe('File content as base64 (for binary files)'),
    from_message: z
      .object({
        id: z.string().describe('Message id the attachment belongs to'),
        index: z.number().int().min(0).describe('Attachment index from read_message.attachments'),
      })
      .optional()
      .describe('Attach a file from a received message without downloading it'),
  })
  .superRefine((a, issue) => {
    const sources = [a.content_text, a.content_base64, a.from_message].filter(
      (v) => v !== undefined,
    );
    if (sources.length !== 1) {
      issue.addIssue({
        code: 'custom',
        message: 'give exactly one of content_text, content_base64 or from_message',
      });
    }
    if (!a.from_message && !a.filename) {
      issue.addIssue({ code: 'custom', message: 'filename is required', path: ['filename'] });
    }
  });
export type AttachmentInput = z.output<typeof attachmentInput>;

export const sendMessageShape = {
  to: z.array(email).min(1).describe('Recipients; every address must be on allow_send_to'),
  cc: z.array(email).default([]).describe('Copy recipients; each must be on allow_send_to'),
  bcc: z.array(email).default([]).describe('Hidden recipients; each must be on allow_send_to'),
  subject: z.string().max(998).describe('Subject line'),
  body_markdown: longText().describe('Message body in Markdown'),
  attachments: z
    .array(attachmentInput)
    .max(20)
    .default([])
    .describe('Files to attach: text, base64 or a file from a received message'),
  reply_to_id: z
    .string()
    .optional()
    .describe(
      'Message id this answers (threading only; prefer reply_message, which fills in recipients)',
    ),
};
export const sendMessageSchema = z.object(sendMessageShape);
export type SendMessageInput = z.output<typeof sendMessageSchema>;

export const eventShape = {
  title: z.string().min(1).max(500).describe('Meeting title shown in calendars'),
  start: dateTimeString.describe(
    'Start, e.g. 2026-10-05T14:00 (mailbox time zone) or with offset/Z',
  ),
  end: dateTimeString.describe('End, same format as start; must be after start'),
  timezone: z
    .string()
    .optional()
    .describe('IANA zone for times without offset; defaults to the mailbox timezone'),
  location: z.string().max(500).optional().describe('Place or meeting link'),
  description_markdown: longText().optional().describe('Agenda or notes in Markdown'),
  attendees: z
    .array(email)
    .min(1)
    .describe('Email addresses to invite; each must be on allow_send_to'),
};
export const eventSchema = z.object(eventShape);
export const eventPatchSchema = eventSchema.partial().extend({
  location: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .describe('Place or meeting link; null removes it'),
  description_markdown: longText()
    .nullable()
    .optional()
    .describe('Agenda or notes in Markdown; null removes them'),
});
export type EventInput = z.output<typeof eventSchema>;
export type EventPatch = z.output<typeof eventPatchSchema>;

export const searchShape = {
  text: z.string().min(1).optional().describe('Words to find in subject, sender or body'),
  from: z.string().min(1).optional().describe('Sender address or part of it'),
  subject: z.string().min(1).optional().describe('Words in the subject'),
  since: sinceString.optional(),
  before: sinceString.optional().describe('Only messages received before this date or date-time'),
  unread: z.boolean().optional().describe('true: only unread messages'),
  limit: z.number().int().min(1).max(50).default(20).describe('Maximum number of messages (1-50)'),
  cursor: z.string().optional().describe('next_cursor from a previous call, to get older messages'),
};

export const replyShape = {
  body_markdown: longText().describe(
    'Reply text in Markdown; the original is not quoted automatically',
  ),
  reply_all: z
    .boolean()
    .default(false)
    .describe('Also reply to everyone in To and Cc of the original'),
  attachments: z
    .array(attachmentInput)
    .max(20)
    .default([])
    .describe('Files to attach: text, base64 or a file from a received message'),
};
export const replySchema = z.object(replyShape);

export const forwardShape = {
  to: z.array(email).min(1).describe('Recipients; each must be on allow_send_to'),
  cc: z.array(email).default([]).describe('Copy recipients; each must be on allow_send_to'),
  bcc: z.array(email).default([]).describe('Hidden recipients; each must be on allow_send_to'),
  body_markdown: longText().optional().describe('Your note above the forwarded message'),
  include_attachments: z.boolean().default(true).describe('Also forward the original attachments'),
};
export const forwardSchema = z.object(forwardShape);

export const rsvpShape = {
  response: z.enum(['accept', 'decline', 'tentative']).describe('Your answer to the invitation'),
  comment: z.string().max(20_000).optional().describe('Optional message to the organizer'),
};
export const rsvpSchema = z.object(rsvpShape);
