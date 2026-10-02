import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { MailboxConfig } from '../config/schema.js';

export interface OutgoingMail {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  attachments: { filename: string; contentType: string; content: Buffer }[];
  icalEvent?: { method: 'REQUEST' | 'CANCEL'; content: string };
}

export function composeMail(mail: OutgoingMail): Promise<{ raw: Buffer; messageId: string }> {
  const domain = mail.from.split('@').pop();
  const messageId = `<${randomUUID()}@${domain}>`;
  const composer = new MailComposer({
    from: mail.from,
    to: mail.to,
    cc: mail.cc,
    bcc: mail.bcc,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    inReplyTo: mail.inReplyTo,
    references: mail.references,
    messageId,
    attachments: mail.attachments,
    icalEvent: mail.icalEvent,
  });
  return new Promise((resolve, reject) => {
    composer.compile().build((err, raw) => (err ? reject(err) : resolve({ raw, messageId })));
  });
}

export interface SmtpSender {
  send(envelope: { from: string; to: string[] }, raw: Buffer): Promise<void>;
  close(): void;
}

export function createSmtpSender(cfg: MailboxConfig): SmtpSender {
  const transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.security === 'tls',
    requireTLS: cfg.smtp.security === 'starttls',
    ignoreTLS: cfg.smtp.security === 'none',
    auth: { user: cfg.username, pass: cfg.password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
  return {
    async send(envelope, raw) {
      await transport.sendMail({ envelope, raw });
    },
    close() {
      transport.close();
    },
  };
}
