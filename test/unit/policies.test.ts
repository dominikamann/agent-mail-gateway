import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import type { MailboxConfigInput } from '../../src/config/schema.js';
import { createEvent } from '../../src/services/events.js';
import type { SendMessageInput } from '../../src/services/schemas.js';
import { sendMessage } from '../../src/services/send.js';
import { createTestContext } from '../helpers/fakes.js';

type Msg = { role: string; content: string };
type Call = { messages: Msg[] };

const RULES = [
  { rule: 'Never share financial information such as revenue, invoices or salaries.' },
  { rule: 'Never mention gifts or presents.', recipients: ['alex@partner.local'] },
  { rule: 'Never send calendar invitations.', recipients: ['boss@test.local'], mode: 'warn' },
];

/** Fake OpenAI-compatible endpoint: answers policy checks with `violations`, quality checks with approval. */
function policyContext(
  violations: { rule: number; reason: string }[],
  review: Record<string, unknown> = {},
  opts: { fail?: boolean } = {},
) {
  const calls: Call[] = [];
  const t = createTestContext({
    allow_send_to: ['boss@test.local', '*@partner.local'],
    review: {
      llm: { url: 'http://ollama:11434/v1', model: 'llama3.1:8b', mode: 'off' },
      policies: { rules: RULES },
      ...review,
    } as MailboxConfigInput['review'],
  });
  t.ctx.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Call;
    calls.push(body);
    if (opts.fail) throw new Error('connect ECONNREFUSED');
    const isPolicy = body.messages[0]!.content.includes('POLICY RULES');
    const content = JSON.stringify(isPolicy ? { violations } : { approved: true, reason: 'ok' });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { ...t, calls };
}

const mail = (over: Partial<SendMessageInput> = {}): SendMessageInput => ({
  to: ['alex@partner.local'],
  cc: [],
  bcc: [],
  subject: 'Weekend plans',
  body_markdown: 'Hi Alex, shall we meet on Saturday for lunch?',
  attachments: [],
  ...over,
});

const prompt = (c: Call) => c.messages.map((m) => m.content).join('\n');

describe('policies (LLM rule sets per mailbox)', () => {
  it('only sends the rules that apply to the recipients', async () => {
    const { ctx, calls } = policyContext([]);
    await sendMessage(ctx, mail());
    const p = prompt(calls[0]!);
    expect(p).toContain('1. Never share financial information');
    expect(p).toContain('2. Never mention gifts');
    expect(p).not.toContain('calendar invitations');
    expect(p).toContain('Hi Alex, shall we meet');
  });

  it('a recipient-scoped rule does not apply to other recipients', async () => {
    const { ctx, calls } = policyContext([]);
    await sendMessage(ctx, mail({ to: ['someone@partner.local'] }));
    expect(prompt(calls[0]!)).not.toContain('gifts');
  });

  it('blocks a violation of a block rule with the rule and reason', async () => {
    const { ctx, smtp, store } = policyContext([{ rule: 1, reason: 'Mentions the Q3 revenue.' }]);
    await expect(sendMessage(ctx, mail())).rejects.toMatchObject({
      code: 'review_rejected',
      details: {
        reviewer: 'policy',
        reasons: [
          {
            rule: 'policy',
            message: expect.stringContaining('Never share financial information'),
          },
        ],
      },
    });
    expect(smtp.sent).toHaveLength(0);
    expect(store.listAudit('agent').map((a) => a.action)).toEqual(['review_rejected']);
  });

  it('a warn rule sends and reports', async () => {
    const { ctx, smtp } = policyContext([{ rule: 2, reason: 'It is an invitation.' }]);
    const ev = await createEvent(ctx, {
      title: 'Lunch',
      start: '2026-10-10T12:00:00Z',
      end: '2026-10-10T13:00:00Z',
      attendees: ['boss@test.local'],
    });
    expect(smtp.sent).toHaveLength(1);
    expect(ev.warnings).toEqual([
      expect.stringMatching(
        /^review: policy: Never send calendar invitations\. — It is an invitation\./,
      ),
    ]);
  });

  it('fails closed by default when the model is unreachable', async () => {
    const { ctx, smtp } = policyContext([], {}, { fail: true });
    await expect(sendMessage(ctx, mail())).rejects.toMatchObject({
      code: 'review_rejected',
      details: { reviewer: 'policy', reasons: [{ rule: 'policy_unavailable' }] },
    });
    expect(smtp.sent).toHaveLength(0);
  });

  it('treats a violation of a rule that does not exist as a malformed answer (fail closed)', async () => {
    const { ctx, smtp } = policyContext([{ rule: 7, reason: 'made up' }]);
    await expect(sendMessage(ctx, mail())).rejects.toMatchObject({
      details: { reviewer: 'policy', reasons: [{ rule: 'policy_unavailable' }] },
    });
    expect(smtp.sent).toHaveLength(0);
  });

  it('skips the call when no rule applies', async () => {
    const { ctx, calls } = policyContext([], {
      policies: { rules: [{ rule: 'x', recipients: ['nobody@partner.local'] }] },
    });
    await sendMessage(ctx, mail());
    expect(calls).toHaveLength(0);
  });
});

describe('policies config', () => {
  const base = (review: string) => `mailboxes:
  - name: a
    address: a@example.com
    api_key: ${'k'.repeat(32)}
    imap: { host: h, port: 993, security: tls }
    smtp: { host: h, port: 465, security: tls }
    username: u
    password: p
    review:
${review}`;

  it('parses rules with defaults', () => {
    const cfg = parseConfig(
      base(`      llm: { url: "http://ollama:11434/v1", model: m, mode: "off" }
      policies:
        rules:
          - rule: No finance
          - rule: No gifts
            recipients: [Alex@Example.org]
            mode: warn
`),
      {},
    );
    expect(cfg.mailboxes[0]!.review.policies).toEqual({
      mode: 'block',
      on_error: 'block',
      binary_attachments: 'allow',
      rules: [
        { rule: 'No finance' },
        { rule: 'No gifts', recipients: ['alex@example.org'], mode: 'warn' },
      ],
    });
  });

  it('requires review.llm', () => {
    expect(() =>
      parseConfig(base(`      policies:\n        rules:\n          - rule: No finance\n`), {}),
    ).toThrow(/policies.*review\.llm/);
  });
});
