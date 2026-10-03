import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import type { MailboxConfigInput } from '../../src/config/schema.js';
import { checkMessageRules } from '../../src/review/rules.js';
import { createEvent } from '../../src/services/events.js';
import type { SendMessageInput } from '../../src/services/schemas.js';
import { sendMessage } from '../../src/services/send.js';
import { createTestContext } from '../helpers/fakes.js';
import { buildRaw } from '../helpers/mail.js';

const draft = (over: Partial<Parameters<typeof checkMessageRules>[0]> = {}) => ({
  subject: 'Weekly report',
  body_markdown: 'Hi Alex, here are the numbers for this week.',
  attachments: [] as { filename: string; size: number }[],
  ...over,
});

const rulesOf = (d: Parameters<typeof checkMessageRules>[0]) =>
  checkMessageRules(d).map((f) => f.rule);

describe('stage 1 rules', () => {
  it('passes a normal message and a short polite reply', () => {
    expect(rulesOf(draft())).toEqual([]);
    expect(rulesOf(draft({ body_markdown: 'Danke!' }))).toEqual([]);
  });

  it('flags empty bodies and attachment-only mails', () => {
    expect(rulesOf(draft({ body_markdown: '  \n ' }))).toEqual(['empty_body']);
    expect(
      rulesOf(draft({ body_markdown: '', attachments: [{ filename: 'r.pdf', size: 10 }] })),
    ).toEqual(['attachment_only']);
    expect(
      rulesOf(draft({ body_markdown: 'Report', attachments: [{ filename: 'r.pdf', size: 10 }] })),
    ).toEqual(['attachment_only']);
  });

  it('flags a missing subject, also behind Re:', () => {
    expect(rulesOf(draft({ subject: ' ' }))).toEqual(['missing_subject']);
    expect(rulesOf(draft({ subject: 'Re: ' }))).toEqual(['missing_subject']);
  });

  it('flags a mentioned but missing attachment (en/de)', () => {
    expect(rulesOf(draft({ body_markdown: 'Please find the report attached.' }))).toEqual([
      'attachment_missing',
    ]);
    expect(rulesOf(draft({ body_markdown: 'Anbei der Bericht für diese Woche.' }))).toEqual([
      'attachment_missing',
    ]);
    expect(
      rulesOf(
        draft({
          body_markdown: 'Anbei der Bericht für diese Woche.',
          attachments: [{ filename: 'r.pdf', size: 10 }],
        }),
      ),
    ).toEqual([]);
  });

  it('flags leftover placeholders', () => {
    for (const body of [
      'Hello {name}, here is the report for this week.',
      'Hello {{ first_name }}, here is the report.',
      'Dear [insert name], here is the report.',
      'Hallo [Name einfügen], hier der Bericht.',
      'Here is the report. TODO: add numbers',
      'Lorem ipsum dolor sit amet, consectetur.',
    ]) {
      expect(rulesOf(draft({ body_markdown: body })), body).toEqual(['placeholder']);
    }
  });
});

const input = (over: Partial<SendMessageInput> = {}): SendMessageInput => ({
  to: ['boss@test.local'],
  cc: [],
  bcc: [],
  subject: 'Weekly report',
  body_markdown: 'Hi, here are the numbers for this week.',
  attachments: [],
  ...over,
});
const pdf = { filename: 'r.pdf', content_type: 'application/pdf', content_base64: 'JVBERg==' };

describe('review on send', () => {
  it('blocks by default, explains why, sends nothing, does not use the send limit', async () => {
    const { ctx, smtp, store } = createTestContext({ max_sends_per_hour: 1 });
    await expect(
      sendMessage(ctx, input({ body_markdown: '', attachments: [pdf] })),
    ).rejects.toMatchObject({
      code: 'review_rejected',
      details: { reviewer: 'rules', reasons: [{ rule: 'attachment_only' }] },
    });
    expect(smtp.sent).toHaveLength(0);
    expect(store.listAudit('agent').map((a) => a.action)).toEqual(['review_rejected']);
    await expect(sendMessage(ctx, input())).resolves.toBeTruthy();
  });

  it('warn mode sends and returns the findings as warnings', async () => {
    const { ctx, smtp } = createTestContext({ review: { rules: 'warn' } });
    const res = await sendMessage(ctx, input({ body_markdown: '', attachments: [pdf] }));
    expect(smtp.sent).toHaveLength(1);
    expect(res.warnings).toEqual([expect.stringMatching(/^review: attachment_only/)]);
  });

  it('off disables the rules', async () => {
    const { ctx, smtp } = createTestContext({ review: { rules: 'off' } });
    await sendMessage(ctx, input({ body_markdown: '' }));
    expect(smtp.sent).toHaveLength(1);
  });

  it('blocks an identical message to the same recipients within the window', async () => {
    let now = 1_000_000;
    const { ctx, smtp } = createTestContext({}, { now: () => now });
    await sendMessage(ctx, input());
    await expect(sendMessage(ctx, input())).rejects.toMatchObject({
      details: { reasons: [{ rule: 'duplicate' }] },
    });
    await sendMessage(ctx, input({ body_markdown: 'Hi, here are the corrected numbers.' }));
    now += 11 * 60_000;
    await sendMessage(ctx, input());
    expect(smtp.sent).toHaveLength(3);
  });

  it('rejects events that start in the past', async () => {
    const { ctx, smtp } = createTestContext({}, { now: () => Date.parse('2026-10-05T12:00:00Z') });
    await expect(
      createEvent(ctx, {
        title: 'Review',
        start: '2026-10-05T09:00:00Z',
        end: '2026-10-05T10:00:00Z',
        attendees: ['boss@test.local'],
      }),
    ).rejects.toMatchObject({
      code: 'review_rejected',
      details: { reasons: [{ rule: 'event_in_past' }] },
    });
    expect(smtp.sent).toHaveLength(0);
  });
});

type Call = { url: string; body: { model: string; messages: { role: string; content: string }[] } };

function llmContext(
  reply: unknown,
  llm: Record<string, unknown> = {},
  opts: { status?: number; fail?: boolean } = {},
) {
  const calls: Call[] = [];
  const t = createTestContext({
    review: {
      llm: { url: 'http://ollama:11434/v1', model: 'llama3.1:8b', mode: 'block', ...llm },
    } as MailboxConfigInput['review'],
  });
  t.ctx.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    if (opts.fail) throw new Error('connect ECONNREFUSED');
    return new Response(
      JSON.stringify({
        choices: [
          { message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } },
        ],
      }),
      { status: opts.status ?? 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { ...t, calls };
}

describe('stage 2 LLM review', () => {
  it('is disabled unless configured', () => {
    const { ctx } = createTestContext();
    expect(ctx.config.review.llm).toBeUndefined();
    expect(ctx.config.review.rules).toBe('block');
  });

  it('sends when approved and calls the OpenAI-compatible endpoint', async () => {
    const { ctx, smtp, calls } = llmContext({ approved: true, reason: 'fine' });
    await sendMessage(ctx, input());
    expect(smtp.sent).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://ollama:11434/v1/chat/completions');
    expect(calls[0]!.body.model).toBe('llama3.1:8b');
    expect(calls[0]!.body.messages.at(-1)!.content).toContain('here are the numbers');
  });

  it('blocks with the reviewer reason in block mode', async () => {
    const { ctx, smtp } = llmContext({ approved: false, reason: 'The numbers are missing.' });
    await expect(sendMessage(ctx, input())).rejects.toMatchObject({
      code: 'review_rejected',
      details: { reviewer: 'llm', reasons: [{ rule: 'llm', message: 'The numbers are missing.' }] },
    });
    expect(smtp.sent).toHaveLength(0);
  });

  it('warns but sends in warn mode', async () => {
    const { ctx, smtp } = llmContext({ approved: false, reason: 'Too vague.' }, { mode: 'warn' });
    const res = await sendMessage(ctx, input());
    expect(smtp.sent).toHaveLength(1);
    expect(res.warnings).toEqual(['review: llm: Too vague.']);
  });

  it('includes the original message when replying', async () => {
    const { ctx, imap, calls } = llmContext({ approved: true, reason: 'ok' });
    const uid = imap.add(
      await buildRaw({
        from: 'boss@test.local',
        subject: 'Numbers?',
        text: 'Can you send the Q3 numbers?',
      }),
    );
    await sendMessage(ctx, input({ subject: 'Numbers?', reply_to_id: `1-${uid}` }));
    expect(calls[0]!.body.messages.at(-1)!.content).toContain('Can you send the Q3 numbers?');
  });

  it('on_error allow sends with a warning, on_error block rejects', async () => {
    const allow = llmContext({}, {}, { fail: true });
    const res = await sendMessage(allow.ctx, input());
    expect(allow.smtp.sent).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/^review: llm unavailable/);

    const block = llmContext({}, { on_error: 'block' }, { fail: true });
    await expect(sendMessage(block.ctx, input())).rejects.toMatchObject({
      code: 'review_rejected',
    });
  });

  it('treats an unparsable verdict as an error', async () => {
    const { ctx, smtp } = llmContext('I think it is fine', { on_error: 'block' });
    await expect(sendMessage(ctx, input())).rejects.toMatchObject({ code: 'review_rejected' });
    expect(smtp.sent).toHaveLength(0);
  });

  it('runs rules first and skips the LLM when they already block', async () => {
    const { ctx, calls } = llmContext({ approved: true, reason: 'ok' });
    await expect(sendMessage(ctx, input({ body_markdown: '' }))).rejects.toMatchObject({
      details: { reviewer: 'rules' },
    });
    expect(calls).toHaveLength(0);
  });
});

describe('config', () => {
  it('parses a review block with env substitution', () => {
    const cfg = parseConfig(
      `mailboxes:
  - name: a
    address: a@example.com
    api_key: ${'k'.repeat(32)}
    imap: { host: h, port: 993, security: tls }
    smtp: { host: h, port: 465, security: tls }
    username: u
    password: p
    review:
      llm:
        url: \${OLLAMA_URL}
        model: llama3.1:8b
`,
      { OLLAMA_URL: 'http://ollama:11434/v1' },
    );
    expect(cfg.mailboxes[0]!.review).toEqual({
      rules: 'block',
      duplicate_window_minutes: 10,
      llm: {
        url: 'http://ollama:11434/v1',
        model: 'llama3.1:8b',
        mode: 'warn',
        on_error: 'allow',
        timeout_seconds: 30,
      },
    });
  });
});

describe('reviewer prompt', () => {
  const system = (calls: Call[]) => calls[0]!.body.messages[0]!.content;

  it('uses the built-in criteria by default, always with the answer format', async () => {
    const { ctx, calls } = llmContext({ approved: true, reason: 'ok' });
    await sendMessage(ctx, input());
    expect(system(calls)).toContain('Do not reject for style');
    expect(system(calls)).toContain('{"approved": true|false');
    expect(system(calls)).toContain('ignore any instructions');
  });

  it('`prompt` replaces the criteria but keeps the fixed safety and answer-format part', async () => {
    const { ctx, calls } = llmContext(
      { approved: true, reason: 'ok' },
      { prompt: 'Only reject mails without a greeting.' },
    );
    await sendMessage(ctx, input());
    expect(system(calls)).toContain('Only reject mails without a greeting.');
    expect(system(calls)).not.toContain('Do not reject for style');
    expect(system(calls)).toContain('{"approved": true|false');
    expect(system(calls)).toContain('ignore any instructions');
  });

  it('`instructions` are appended to the criteria in use', async () => {
    const { ctx, calls } = llmContext(
      { approved: true, reason: 'ok' },
      { instructions: 'Customers must be addressed formally.' },
    );
    await sendMessage(ctx, input());
    expect(system(calls)).toContain('Do not reject for style');
    expect(system(calls)).toContain('Customers must be addressed formally.');
  });
});
