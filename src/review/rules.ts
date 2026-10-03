import { createHash } from 'node:crypto';

export interface Finding {
  rule: string;
  message: string;
}

export interface MessageDraft {
  subject: string;
  body_markdown: string;
  /** `text`: content of a text attachment written by the agent (checked by policies). */
  attachments: { filename: string; size: number; text?: string; binary?: boolean }[];
}

const ATTACHMENT_MENTION =
  /\b(?:attached|find attached|see (?:the )?attachment|in the attachment|enclosed)\b|\banbei\b|\bim anhang\b|\bsiehe anhang\b|\bangeh(?:ä|ae)ngt\b|\bbeigef(?:ü|ue)gt\b|\bin der anlage\b/i;

const PLACEHOLDERS = [
  /\{\{?\s*[A-Za-z_][\w.]*\s*\}?\}/,
  /\[(?:insert|add|enter|your|placeholder|name|hier|bitte)\b[^\]\n]{0,40}\](?!\()/i,
  /\[[^\]\n]{0,40}\beinf(?:ü|ue)gen\](?!\()/i,
  /\b(?:TODO|FIXME|XXX):/,
  /\blorem ipsum\b/i,
];

function words(markdown: string): number {
  return markdown
    .replace(/[#>*_`~[\]()!|-]/g, ' ')
    .split(/\s+/)
    .filter((w) => /\p{L}|\p{N}/u.test(w)).length;
}

/** Separates the agent's own text from a forwarded original (see forward_message). */
export const FORWARD_SEPARATOR = '---------- Forwarded message ----------';

export function splitForward(body: string): { own: string; forwarded: string | null } {
  const cut = body.indexOf(FORWARD_SEPARATOR);
  return cut >= 0
    ? { own: body.slice(0, cut), forwarded: body.slice(cut) }
    : { own: body, forwarded: null };
}

/** The part written by the agent: without a forwarded original and without quoted lines. */
function ownText(body: string): string {
  return splitForward(body)
    .own.split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n');
}

/** Deterministic checks for obviously broken outgoing mail. Pure; no I/O. */
export function checkMessageRules(d: MessageDraft): Finding[] {
  const findings: Finding[] = [];
  const body = d.body_markdown.trim();
  const own = ownText(body);
  const hasAttachments = d.attachments.length > 0;

  if (hasAttachments && words(body) < 3) {
    findings.push({
      rule: 'attachment_only',
      message:
        'The message is only an attachment. Add a few sentences saying what it is and why you send it.',
    });
  } else if (body.length === 0) {
    findings.push({ rule: 'empty_body', message: 'The message body is empty.' });
  }
  if (d.subject.replace(/^\s*(?:(?:re|aw|fw|fwd|wg)\s*:\s*)*/i, '').trim().length === 0) {
    findings.push({ rule: 'missing_subject', message: 'The subject is empty.' });
  }
  if (!hasAttachments && ATTACHMENT_MENTION.test(own)) {
    findings.push({
      rule: 'attachment_missing',
      message: 'The text mentions an attachment, but nothing is attached.',
    });
  }
  const placeholder = PLACEHOLDERS.map((re) => re.exec(own)?.[0]).find(Boolean);
  if (placeholder) {
    findings.push({
      rule: 'placeholder',
      message: `The text still contains a placeholder: "${placeholder}".`,
    });
  }
  return findings;
}

/** Identifies "the same message to the same people" for duplicate detection. */
export function fingerprint(recipients: string[], d: MessageDraft): string {
  const hash = createHash('sha256');
  hash.update([...new Set(recipients.map((r) => r.toLowerCase()))].sort().join(','));
  hash.update('\0');
  hash.update(d.subject.trim().toLowerCase());
  hash.update('\0');
  hash.update(d.body_markdown.trim());
  hash.update('\0');
  hash.update(d.attachments.map((a) => `${a.filename}:${a.size}`).join(','));
  return hash.digest('hex');
}
