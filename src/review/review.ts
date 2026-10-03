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
}

export interface OutgoingEvent {
  /** Everyone who receives something: attendees, plus removed attendees getting a cancellation. */
  recipients: string[];
  start: Date;
  /** Fields shown to the model: title, when, where, attendees, description, ... */
  fields: Record<string, unknown>;
}

const MAX_FIELD_CHARS = 20_000;
const cap = (text: string, max = MAX_FIELD_CHARS) =>
  text.length > max ? `${text.slice(0, max)}\n[… truncated]` : text;

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

/** Operator-defined rule sets, optionally per recipient, checked by the LLM. */
async function runPolicies(
  ctx: MailboxContext,
  content: unknown,
  recipients: string[],
  warnings: string[],
): Promise<void> {
  const { policies, llm } = ctx.config.review;
  if (!policies || !llm) return;
  const applicable = policies.rules.filter((r) => policyApplies(recipients, r.recipients));
  if (applicable.length === 0) return;

  let violations: { rule: number; reason: string }[];
  try {
    violations = await policyReview(
      llm,
      applicable.map((r) => r.rule),
      content,
      ctx.fetch,
    );
  } catch (err) {
    const message = `Policy check unavailable: ${(err as Error).message}`;
    if (policies.on_error === 'block') {
      reject(ctx, 'policy', [{ rule: 'policy_unavailable', message }], recipients);
    }
    ctx.log.warn(
      { mailbox: ctx.config.name, err: (err as Error).message },
      'policy check unavailable',
    );
    warnings.push(`review: policy check unavailable (${(err as Error).message}), sent without it`);
    return;
  }

  const blocking: Finding[] = [];
  for (const v of violations) {
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
    if (
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
  // Everything written by the agent or by other people goes into the nonce-marked JSON data.
  const { own, forwarded } = splitForward(m.body_markdown);
  const data = {
    kind: 'email',
    from: ctx.config.address,
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    subject: m.subject,
    attachments: m.attachments.map((a) => ({ filename: a.filename, bytes: a.size })),
    message: cap(own.trim()),
    ...(forwarded ? { forwarded_original: cap(forwarded) } : {}),
    ...(m.replyTo
      ? {
          in_reply_to: {
            from: m.replyTo.from,
            subject: m.replyTo.subject,
            text: cap(m.replyTo.body_markdown, 4000),
          },
        }
      : {}),
  };
  await runPolicies(ctx, data, recipients, warnings);
  await runLlm(ctx, data, recipients, warnings);
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
  const data = { kind: 'calendar invitation', organizer: ctx.config.address, ...e.fields };
  await runPolicies(ctx, data, e.recipients, warnings);
  await runLlm(ctx, data, e.recipients, warnings);
  return warnings;
}

export { FORWARD_SEPARATOR } from './rules.js';
export { fingerprint };
