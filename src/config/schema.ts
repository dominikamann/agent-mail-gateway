import { z } from 'zod';

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const addressPattern = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => /^[^\s@*]+@[^\s@*]+$/.test(v) || /^\*@[^\s@*]+$/.test(v), {
    message: 'must be an email address or *@domain',
  });

const endpoint = z
  .object({
    host: z.string().min(1),
    port: z.coerce.number().int().min(1).max(65535),
    security: z.enum(['tls', 'starttls', 'none']),
  })
  .strict();

export const mailboxSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9_-]+$/, 'use lowercase letters, digits, _ or -'),
    address: z.string().trim().toLowerCase().pipe(z.email()),
    api_key: z.string().min(32, 'api_key must be at least 32 characters'),
    imap: endpoint,
    smtp: endpoint,
    username: z.string().min(1),
    password: z.string().min(1),
    allow_receive_from: z.array(addressPattern).default([]),
    allow_send_to: z.array(addressPattern).default([]),
    non_allowed_action: z.enum(['delete', 'keep']).default('delete'),
    require_sender_auth: z.boolean().default(true),
    trusted_authserv_id: z.string().trim().toLowerCase().min(1).optional(),
    allow_delete: z.boolean().default(false),
    max_sends_per_hour: z.coerce.number().int().min(0).default(30),
    max_attachment_mb: z.coerce.number().positive().default(15),
    timezone: z.string().refine(isValidTimeZone, 'unknown time zone').default('UTC'),
    poll_interval_seconds: z.coerce.number().int().min(10).default(300),
    folders: z
      .object({ sent: z.string().min(1).optional(), trash: z.string().min(1).optional() })
      .strict()
      .prefault({}),
    review: z
      .object({
        rules: z.enum(['block', 'warn', 'off']).default('block'),
        duplicate_window_minutes: z.coerce.number().int().min(0).default(10),
        llm: z
          .object({
            url: z.url().refine((u) => !/^[a-z][a-z0-9+.-]*:\/\/[^/@]*@/i.test(u), {
              message: 'must not contain credentials (user:password@); use api_key instead',
            }),
            model: z.string().min(1),
            api_key: z.string().min(1).optional(),
            mode: z.enum(['block', 'warn', 'off']).default('warn'),
            on_error: z.enum(['allow', 'block']).default('allow'),
            timeout_seconds: z.coerce.number().int().min(1).max(300).default(30),
            /** Text per model request; longer content is checked in several parts. */
            chunk_chars: z.coerce.number().int().min(500).default(6000),
            /** Overlap between parts so nothing is lost at a boundary. */
            chunk_overlap_chars: z.coerce.number().int().min(0).default(200),
            /** More parts than this: policies are not checked and the message is not sent. */
            max_chunks: z.coerce.number().int().min(1).default(20),
            prompt: z.string().min(1).optional(),
            instructions: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
        policies: z
          .object({
            mode: z.enum(['block', 'warn']).default('block'),
            on_error: z.enum(['block', 'allow']).default('block'),
            rules: z
              .array(
                z
                  .object({
                    rule: z.string().trim().min(1),
                    recipients: z.array(addressPattern).min(1).optional(),
                    mode: z.enum(['block', 'warn']).optional(),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict()
          .optional(),
      })
      .strict()
      .refine((r) => !r.policies || r.llm, {
        message: 'review.policies needs review.llm (the model that checks the rules)',
        path: ['policies'],
      })
      .prefault({}),
    webhook: z
      .object({ url: z.url(), secret: z.string().min(16) })
      .strict()
      .optional(),
  })
  .strict();

export const configSchema = z
  .object({
    server: z
      .object({
        port: z.coerce.number().int().min(0).max(65535).default(8080),
        log_level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
        data_dir: z.string().min(1).default('/data'),
      })
      .strict()
      .prefault({}),
    mailboxes: z.array(mailboxSchema).min(1),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    for (const field of ['name', 'address', 'api_key'] as const) {
      const seen = new Set<string>();
      cfg.mailboxes.forEach((mb, i) => {
        if (seen.has(mb[field])) {
          ctx.addIssue({
            code: 'custom',
            path: ['mailboxes', i, field],
            message: `duplicate ${field}`,
          });
        }
        seen.add(mb[field]);
      });
    }
  });

export type Config = z.output<typeof configSchema>;
export type MailboxConfig = z.output<typeof mailboxSchema>;
export type MailboxConfigInput = z.input<typeof mailboxSchema>;
