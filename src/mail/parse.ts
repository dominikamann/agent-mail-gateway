import { type AddressObject, type EmailAddress, simpleParser } from 'mailparser';
import { htmlToMarkdown } from '../convert/html-to-md.js';

export interface ParsedAttachment {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
}

export interface ParsedMessage {
  from: string | null;
  fromName: string | null;
  to: string[];
  cc: string[];
  subject: string;
  date: string | null;
  messageId: string | null;
  references: string[];
  bodyMarkdown: string;
  preview: string;
  attachments: ParsedAttachment[];
  authResults: string[];
}

function flatten(field: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!field) return [];
  const list = Array.isArray(field) ? field : [field];
  return list.flatMap((a) => a.value).flatMap((v) => (v.group ? v.group : [v]));
}

function addresses(field: AddressObject | AddressObject[] | undefined): string[] {
  return flatten(field)
    .map((v) => v.address?.toLowerCase())
    .filter((a): a is string => Boolean(a));
}

export async function parseMessage(raw: Buffer): Promise<ParsedMessage> {
  const parsed = await simpleParser(raw, { skipImageLinks: true });
  const sender = flatten(parsed.from)[0];
  const bodyMarkdown = parsed.html ? htmlToMarkdown(parsed.html) : (parsed.text ?? '').trim();
  const references = parsed.references
    ? Array.isArray(parsed.references)
      ? parsed.references
      : [parsed.references]
    : [];
  const authResults = parsed.headerLines
    .filter((l) => l.key === 'authentication-results')
    .map((l) =>
      l.line
        .replace(/^[^:]*:\s*/, '')
        .replace(/\r?\n[ \t]+/g, ' ')
        .trim(),
    );

  return {
    from: sender?.address?.toLowerCase() ?? null,
    fromName: sender?.name || null,
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    subject: parsed.subject ?? '',
    date: parsed.date ? parsed.date.toISOString() : null,
    messageId: parsed.messageId ?? null,
    references,
    bodyMarkdown,
    preview: bodyMarkdown.replace(/\s+/g, ' ').trim().slice(0, 200),
    attachments: parsed.attachments.map((a, index) => ({
      index,
      filename: a.filename ?? `attachment-${index + 1}`,
      contentType: a.contentType,
      size: a.size,
      content: a.content,
    })),
    authResults,
  };
}
