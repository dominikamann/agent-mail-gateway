import MailComposer from 'nodemailer/lib/mail-composer/index.js';

export interface RawOptions {
  from: string;
  to?: string;
  subject?: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; content: string | Buffer; contentType?: string }[];
  messageId?: string;
  date?: Date;
}

export function buildRaw(opts: RawOptions): Promise<Buffer> {
  const composer = new MailComposer({
    from: opts.from,
    to: opts.to ?? 'agent@test.local',
    subject: opts.subject ?? 'Hello',
    html: opts.html,
    text: opts.text ?? (opts.html ? undefined : 'Hello agent'),
    headers: opts.headers,
    attachments: opts.attachments,
    messageId: opts.messageId,
    date: opts.date,
  });
  return new Promise((resolve, reject) => {
    composer.compile().build((err, message) => (err ? reject(err) : resolve(message)));
  });
}
