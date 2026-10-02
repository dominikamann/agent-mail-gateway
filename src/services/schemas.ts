import { z } from 'zod';

export const dateTimeString = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/i,
    'ISO 8601 date-time, e.g. 2026-10-05T14:00 or 2026-10-05T14:00:00+02:00',
  );

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
