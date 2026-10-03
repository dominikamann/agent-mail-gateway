import { htmlToMarkdown } from '../convert/html-to-md.js';
import { markdownToHtml } from '../convert/md-to-html.js';
import { GatewayError } from '../errors.js';
import { isAllowed } from '../policy/address.js';
import { type MailboxContext, recordAudit } from '../services/context.js';
import { llmReview, policyReview } from './llm.js';
import {
  checkMessageRules,
  type Finding,
  fingerprint,
  type MessageDraft,
  splitForward,
} from './rules.js';

export interface OutgoingMessage extends MessageDraft {
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo?: { from: string | null; subject: string; body_markdown: string };
  /** The same message is being sent right now by another request. */
  duplicateInFlight?: boolean;
}

export interface OutgoingEvent {
  /** Everyone who receives something: attendees, plus removed attendees getting a cancellation. */
  recipients: string[];
  start: Date;
  /** Fields shown to the model: title, when, where, attendees, description, ... */
  fields: Record<string, unknown>;
}

/** What the recipient will actually see: Markdown rendered and read back (decodes entities etc.). */
function rendered(markdown: string): string {
  // No source fallback here: if conversion gives up, tags are stripped and entities decoded.
  return htmlToMarkdown(markdownToHtml(markdown));
}

/** Invisible format characters (zero-width etc.) that could split words for the model. */
const stripInvisible = (text: string) => text.replace(/\p{Cf}/gu, '');

/**
 * Everything a recipient can read: the raw source (sent as the plain-text part and in
 * invitations) and its rendered form (sent as HTML, entities decoded), plus text attachments.
 */
function sentText(
  markdown: string,
  attachments: { filename: string; text?: string }[] = [],
): string {
  const source = markdown.trim();
  const html = rendered(markdown).trim();
  const forms = html && html !== source ? `${source}\n\n${html}` : source;
  const files = attachments
    .filter((a) => a.text)
    .map((a) => `\n\n--- attachment ${a.filename} ---\n${a.text}`)
    .join('');
  return stripInvisible(forms + files);
}

/** Splits text into overlapping parts so nothing is lost at a boundary. */
function chunks(text: string, size: number, overlapChars: number): string[] {
  if (text.length <= size) return [text];
  const overlap = Math.min(overlapChars, Math.floor(size / 2));
  const out: string[] = [];
  for (let start = 0; start < text.length; start += size - overlap) {
    out.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return out;
}

/** For the quality review only (not a security check): one part is enough. */
const shorten = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n[… shortened for this check]` : text;

/** Error text for the agent: no internal hosts, URLs or stack details (those go to the log). */
function describeError(err: unknown): string {
  const e = err as Error;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'model timed out';
  if (/^HTTP \d{3}$/.test(e?.message ?? '')) return `model answered ${e.message}`;
  if (/^the reviewer /.test(e?.message ?? '')) return e.message;
  return 'model unreachable';
}

/** `alex+news@x.de` → `alex@x.de`, so sub-addressing cannot dodge a recipient-scoped policy. */
function withoutTag(address: string): string {
  const [local = '', domain = ''] = address.toLowerCase().split('@');
  return `${local.split('+')[0]}@${domain}`;
}

function policyApplies(recipients: string[], patterns: string[] | undefined): boolean {
  if (!patterns) return true;
  const normalized = patterns.map((p) => (p.startsWith('*@') ? p : withoutTag(p)));
  return recipients.some((a) => isAllowed(withoutTag(a), normalized));
}

function reject(
  ctx: MailboxContext,
  reviewer: 'rules' | 'llm' | 'policy',
  reasons: Finding[],
  recipients: string[],
): never {
  recordAudit(ctx, 'review_rejected', recipients, 'rejected', reasons.map((r) => r.rule).join(','));
  throw new GatewayError(
    'review_rejected',
    `Not sent: ${reasons.map((r) => r.message).join(' ')} Fix it and send again.`,
    { reviewer, reasons },
  );
}

async function runLlm(
  ctx: MailboxContext,
  content: unknown,
  recipients: string[],
  warnings: string[],
): Promise<void> {
  const llm = ctx.config.review.llm;
  if (!llm || llm.mode === 'off') return;
  let verdict: { approved: boolean; reason: string };
  try {
    verdict = await llmReview(llm, content, ctx.fetch);
  } catch (err) {
    const message = `LLM review unavailable: ${describeError(err)}`;
    if (llm.on_error === 'block')
      reject(ctx, 'llm', [{ rule: 'llm_unavailable', message }], recipients);
    ctx.log.warn(
      { mailbox: ctx.config.name, err: (err as Error).message },
      'llm review unavailable',
    );
    warnings.push(`review: llm unavailable (${describeError(err)}), sent without LLM review`);
    return;
  }
  if (verdict.approved) return;
  const reason = verdict.reason || 'The reviewer rejected the message.';
  if (llm.mode === 'block') reject(ctx, 'llm', [{ rule: 'llm', message: reason }], recipients);
  warnings.push(`review: llm: ${reason}`);
}

/** Operator-defined rule sets, optionally per recipient, checked by the LLM. */
async function runPolicies(
  ctx: MailboxContext,
  fields: Record<string, unknown>,
  text: string,
  recipients: string[],
  warnings: string[],
): Promise<void> {
  const { policies, llm } = ctx.config.review;
  if (!policies || !llm) return;
  const applicable = policies.rules.filter((r) => policyApplies(recipients, r.recipients));
  if (applicable.length === 0) return;

  // Never cut: long content is checked in overlapping parts; a violation in any part counts.
  const parts = chunks(text, llm.chunk_chars, llm.chunk_overlap_chars);
  if (parts.length > llm.max_chunks) {
    reject(
      ctx,
      'policy',
      [
        {
          rule: 'policy_too_long',
          message: `The message is too long to check against the policies (${parts.length} parts, limit ${llm.max_chunks}). Send a shorter message.`,
        },
      ],
      recipients,
    );
  }

  let violations: { rule: number; reason: string }[];
  try {
    violations = [];
    for (const [i, part] of parts.entries()) {
      const data = { ...fields, part: `${i + 1} of ${parts.length}`, text: part };
      violations.push(
        ...(await policyReview(
          llm,
          applicable.map((r) => r.rule),
          data,
          ctx.fetch,
        )),
      );
    }
  } catch (err) {
    const message = `Policy check unavailable: ${describeError(err)}`;
    if (policies.on_error === 'block') {
      reject(ctx, 'policy', [{ rule: 'policy_unavailable', message }], recipients);
    }
    ctx.log.warn(
      { mailbox: ctx.config.name, err: (err as Error).message },
      'policy check unavailable',
    );
    warnings.push(`review: policy check unavailable (${describeError(err)}), sent without it`);
    return;
  }

  const blocking: Finding[] = [];
  const seen = new Set<number>();
  for (const v of violations) {
    if (seen.has(v.rule)) continue;
    seen.add(v.rule);
    const rule = applicable[v.rule - 1];
    if (!rule) continue;
    const message = `${rule.rule} — ${v.reason || 'The message violates this rule.'}`;
    if ((rule.mode ?? policies.mode) === 'block') blocking.push({ rule: 'policy', message });
    else warnings.push(`review: policy: ${message}`);
  }
  if (blocking.length > 0) reject(ctx, 'policy', blocking, recipients);
}

function applyRules(
  ctx: MailboxContext,
  findings: Finding[],
  recipients: string[],
  warnings: string[],
): void {
  if (findings.length === 0) return;
  if (ctx.config.review.rules === 'block') reject(ctx, 'rules', findings, recipients);
  warnings.push(...findings.map((f) => `review: ${f.rule}: ${f.message}`));
}

/**
 * Stage 1 (rules, on by default) and stage 2 (LLM, off unless configured) for an outgoing
 * message. Throws review_rejected when blocked; otherwise returns warnings to pass on.
 */
export async function reviewMessage(ctx: MailboxContext, m: OutgoingMessage): Promise<string[]> {
  const warnings: string[] = [];
  const recipients = [...m.to, ...m.cc, ...m.bcc];
  const { review } = ctx.config;
  if (review.rules !== 'off') {
    const findings = checkMessageRules(m);
    const window = review.duplicate_window_minutes * 60_000;
    if (window > 0 && m.duplicateInFlight) {
      findings.push({
        rule: 'duplicate',
        message: 'The same message to the same recipients is being sent right now.',
      });
    } else if (
      window > 0 &&
      ctx.store.hasFingerprintSince(ctx.config.name, fingerprint(recipients, m), ctx.now() - window)
    ) {
      findings.push({
        rule: 'duplicate',
        message: `The same message went to the same recipients in the last ${review.duplicate_window_minutes} minutes.`,
      });
    }
    applyRules(ctx, findings, recipients, warnings);
  }
  // Everything written by the agent or by other people goes into the nonce-marked JSON data,
  // as the recipient will see it (rendered), never cut for policies.
  const { own, forwarded } = splitForward(m.body_markdown);
  const header = {
    kind: 'email',
    from: ctx.config.address,
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    subject: stripInvisible(m.subject),
    attachments: m.attachments.map((a) => ({
      filename: stripInvisible(a.filename),
      bytes: a.size,
    })),
  };
  const { policies } = ctx.config.review;
  const binary = m.attachments.filter((a) => a.binary);
  if (
    policies?.binary_attachments === 'block' &&
    binary.length > 0 &&
    policies.rules.some((r) => policyApplies(recipients, r.recipients))
  ) {
    reject(
      ctx,
      'policy',
      [
        {
          rule: 'policy_binary_attachment',
          message: `Policies cannot read ${binary.map((a) => a.filename).join(', ')}; only text attachments are allowed for this mailbox.`,
        },
      ],
      recipients,
    );
  }
  await runPolicies(ctx, header, sentText(m.body_markdown, m.attachments), recipients, warnings);

  const size = ctx.config.review.llm?.chunk_chars ?? 6000;
  await runLlm(
    ctx,
    {
      ...header,
      message: shorten(rendered(own).trim(), size),
      ...(forwarded ? { has_forwarded_original: true } : {}),
      ...(m.replyTo
        ? {
            in_reply_to: {
              from: m.replyTo.from,
              subject: m.replyTo.subject,
              text: shorten(m.replyTo.body_markdown, Math.min(4000, size)),
            },
          }
        : {}),
    },
    recipients,
    warnings,
  );
  return warnings;
}

/** Review for calendar invitations: rules (start in the past) and the optional LLM. */
export async function reviewEvent(ctx: MailboxContext, e: OutgoingEvent): Promise<string[]> {
  const warnings: string[] = [];
  if (ctx.config.review.rules !== 'off' && e.start.getTime() < ctx.now() - 60_000) {
    applyRules(
      ctx,
      [{ rule: 'event_in_past', message: 'The event starts in the past.' }],
      e.recipients,
      warnings,
    );
  }
  const { description = '', ...rest } = e.fields as { description?: string } & Record<
    string,
    unknown
  >;
  const header = { kind: 'calendar invitation', organizer: ctx.config.address, ...rest };
  await runPolicies(ctx, header, sentText(String(description)), e.recipients, warnings);
  const size = ctx.config.review.llm?.chunk_chars ?? 6000;
  await runLlm(
    ctx,
    { ...header, description: shorten(rendered(String(description)), size) },
    e.recipients,
    warnings,
  );
  return warnings;
}

export { FORWARD_SEPARATOR } from './rules.js';
export { fingerprint };
