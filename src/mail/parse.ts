import { type AddressObject, type EmailAddress, simpleParser } from 'mailparser';
import { htmlToMarkdown } from '../convert/html-to-md.js';

export interface ParsedAttachment {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
}

export interface ParsedHeaders {
  from: string | null;
  fromName: string | null;
  authResults: string[];
}

export interface ParsedMessage extends ParsedHeaders {
  to: string[];
  cc: string[];
  subject: string;
  date: string | null;
  messageId: string | null;
  references: string[];
  bodyMarkdown: string;
  preview: string;
  attachments: ParsedAttachment[];
}

type Parsed = Awaited<ReturnType<typeof simpleParser>>;

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

function headersOf(parsed: Parsed): ParsedHeaders {
  const fromHeaders = parsed.headerLines.filter((l) => l.key === 'from').length;
  const senders = flatten(parsed.from);
  // Exactly one From header with exactly one address; anything else is ambiguous and could be
  // used to show a different sender than the one authenticated by SPF/DKIM/DMARC.
  const sender = fromHeaders === 1 && senders.length === 1 ? senders[0] : undefined;
  const authResults = parsed.headerLines
    .filter((l) => l.key === 'authentication-results')
    .map((l) =>
      l.line
        .replace(/^[^:]*:\s*/, '')
        .replace(/\r?\n[ \t]+/g, ' ')
        .trim(),
    );
  return {
    from: sender?.address?.toLowerCase() || null,
    fromName: sender?.name || null,
    authResults,
  };
}

/** Parses only the header block, so policy can be decided without touching the body. */
export async function parseHeaders(raw: Buffer): Promise<ParsedHeaders> {
  let end = raw.indexOf('\r\n\r\n');
  if (end < 0) end = raw.indexOf('\n\n');
  const head = end < 0 ? raw : Buffer.concat([raw.subarray(0, end), Buffer.from('\r\n\r\n')]);
  return headersOf(await simpleParser(head, { skipHtmlToText: true, skipTextToHtml: true }));
}

export async function parseMessage(raw: Buffer): Promise<ParsedMessage> {
  const parsed = await simpleParser(raw, {
    skipImageLinks: true,
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipTextLinks: true,
  });
  const text = (parsed.text ?? '').trim();
  const bodyMarkdown = parsed.html ? htmlToMarkdown(parsed.html, text) : text;
  const references = parsed.references
    ? Array.isArray(parsed.references)
      ? parsed.references
      : [parsed.references]
    : [];

  return {
    ...headersOf(parsed),
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
  };
}
