import { GatewayError } from '../errors.js';
import { type MailboxContext, recordAudit } from '../services/context.js';
import { llmReview } from './llm.js';
import { checkMessageRules, type Finding, fingerprint, type MessageDraft } from './rules.js';

export interface OutgoingMessage extends MessageDraft {
  recipients: string[];
  /** Human-readable header lines for the LLM (to, cc, subject, ...). */
  headerLines: string[];
  replyTo?: { from: string | null; subject: string; body_markdown: string };
}

export interface OutgoingEvent {
  attendees: string[];
  start: Date;
  headerLines: string[];
  description: string;
}

function reject(
  ctx: MailboxContext,
  reviewer: 'rules' | 'llm',
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
  content: string,
  recipients: string[],
  warnings: string[],
): Promise<void> {
  const llm = ctx.config.review.llm;
  if (!llm) return;
  let verdict: { approved: boolean; reason: string };
  try {
    verdict = await llmReview(llm, content, ctx.fetch);
  } catch (err) {
    const message = `LLM review unavailable: ${(err as Error).message}`;
    if (llm.on_error === 'block')
      reject(ctx, 'llm', [{ rule: 'llm_unavailable', message }], recipients);
    ctx.log.warn(
      { mailbox: ctx.config.name, err: (err as Error).message },
      'llm review unavailable',
    );
    warnings.push(`review: llm unavailable (${(err as Error).message}), sent without LLM review`);
    return;
  }
  if (verdict.approved) return;
  const reason = verdict.reason || 'The reviewer rejected the message.';
  if (llm.mode === 'block') reject(ctx, 'llm', [{ rule: 'llm', message: reason }], recipients);
  warnings.push(`review: llm: ${reason}`);
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
  const { review } = ctx.config;
  if (review.rules !== 'off') {
    const findings = checkMessageRules(m);
    const window = review.duplicate_window_minutes * 60_000;
    if (
      window > 0 &&
      ctx.store.hasFingerprintSince(
        ctx.config.name,
        fingerprint(m.recipients, m),
        ctx.now() - window,
      )
    ) {
      findings.push({
        rule: 'duplicate',
        message: `The same message went to the same recipients in the last ${review.duplicate_window_minutes} minutes.`,
      });
    }
    applyRules(ctx, findings, m.recipients, warnings);
  }
  const lines = [
    'Kind: email',
    `From: ${ctx.config.address}`,
    ...m.headerLines,
    `Attachments: ${m.attachments.length ? m.attachments.map((a) => `${a.filename} (${a.size} bytes)`).join(', ') : 'none'}`,
    '--- MESSAGE START ---',
    m.body_markdown,
    '--- MESSAGE END ---',
  ];
  if (m.replyTo) {
    lines.push(
      `In reply to a message from ${m.replyTo.from ?? 'unknown'} with subject "${m.replyTo.subject}":`,
      '--- ORIGINAL START ---',
      m.replyTo.body_markdown.slice(0, 4000),
      '--- ORIGINAL END ---',
    );
  }
  await runLlm(ctx, lines.join('\n'), m.recipients, warnings);
  return warnings;
}

/** Review for calendar invitations: rules (start in the past) and the optional LLM. */
export async function reviewEvent(ctx: MailboxContext, e: OutgoingEvent): Promise<string[]> {
  const warnings: string[] = [];
  if (ctx.config.review.rules !== 'off' && e.start.getTime() < ctx.now() - 60_000) {
    applyRules(
      ctx,
      [{ rule: 'event_in_past', message: 'The event starts in the past.' }],
      e.attendees,
      warnings,
    );
  }
  const content = [
    'Kind: calendar invitation',
    `Organizer: ${ctx.config.address}`,
    ...e.headerLines,
    '--- DESCRIPTION START ---',
    e.description,
    '--- DESCRIPTION END ---',
  ].join('\n');
  await runLlm(ctx, content, e.attendees, warnings);
  return warnings;
}

export { fingerprint };
