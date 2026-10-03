import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { parseIcs } from '../../src/calendar/parse-ics.js';
import { parseConfig } from '../../src/config/load.js';
import type { MailboxConfigInput } from '../../src/config/schema.js';
import { parseMessage } from '../../src/mail/parse.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { replyMessage } from '../../src/services/compose.js';
import { createEvent, getEvent, updateEvent } from '../../src/services/events.js';
import { mailboxInfo } from '../../src/services/messages.js';
import type { SendMessageInput } from '../../src/services/schemas.js';
import { sendMessageSchema } from '../../src/services/schemas.js';
import { sendMessage } from '../../src/services/send.js';
import { InboundWatcher } from '../../src/watcher/watcher.js';
import { createTestContext, TEST_NOW } from '../helpers/fakes.js';
import { buildRaw } from '../helpers/mail.js';

type Body = { messages: { role: string; content: string }[] };

function withModel(
  answer: (b: Body) => unknown,
  review: Record<string, unknown>,
  opts: { throwError?: string } = {},
) {
  const bodies: Body[] = [];
  const t = createTestContext({
    review: {
      ...review,
      llm: { url: 'http://ollama:11434/v1', model: 'm', mode: 'off', ...(review.llm as object) },
    } as MailboxConfigInput['review'],
  });
  t.ctx.fetch = (async (_u: string, init: RequestInit) => {
    if (opts.throwError) throw new Error(opts.throwError);
    const b = JSON.parse(String(init.body)) as Body;
    bodies.push(b);
    const a = answer(b);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(a) } }] }));
  }) as unknown as typeof fetch;
  return { ...t, bodies };
}

const flagIban = (b: Body) =>
  b.messages[0]!.content.includes('POLICY RULES')
    ? { violations: b.messages[1]!.content.includes('IBAN') ? [{ rule: 1, reason: 'IBAN' }] : [] }
    : { approved: true, reason: 'ok' };
const noFinance = { policies: { rules: [{ rule: 'Never share bank details.' }] } };
const mail = (over: Partial<SendMessageInput> = {}): SendMessageInput =>
  sendMessageSchema.parse({
    to: ['boss@test.local'],
    subject: 'Report',
    body_markdown: 'Hello, here is the report.',
    ...over,
  });

describe('long messages are checked in parts, never cut', () => {
  it('finds a violation at the very end of a long message', async () => {
    const { ctx, smtp, bodies } = withModel(flagIban, { ...noFinance, llm: { chunk_chars: 1000 } });
    const body = `${'Lorem filler text. '.repeat(300)}\n\nIBAN DE89 3704 0044 0532 0130 00`;
    await expect(sendMessage(ctx, mail({ body_markdown: body }))).rejects.toMatchObject({
      code: 'review_rejected',
      details: { reviewer: 'policy' },
    });
    expect(bodies.length).toBeGreaterThan(3);
    expect(smtp.sent).toHaveLength(0);
  });

  it('refuses to send when there would be too many parts', async () => {
    const { ctx, bodies } = withModel(flagIban, {
      ...noFinance,
      llm: { chunk_chars: 1000, max_chunks: 2 },
    });
    await expect(
      sendMessage(ctx, mail({ body_markdown: 'x '.repeat(5000) })),
    ).rejects.toMatchObject({
      details: { reasons: [{ rule: 'policy_too_long' }] },
    });
    expect(bodies).toHaveLength(0);
  });

  it('the quality review gets one part with only the agent text', async () => {
    const { ctx, bodies } = withModel(flagIban, { llm: { mode: 'warn', chunk_chars: 1000 } });
    await sendMessage(ctx, mail({ body_markdown: `${'Some long text. '.repeat(500)}` }));
    expect(bodies).toHaveLength(1);
  });
});

describe('the model sees the rendered text', () => {
  it('decodes HTML entities before the policy check', async () => {
    const { ctx, smtp } = withModel(flagIban, noFinance);
    await expect(
      sendMessage(ctx, mail({ body_markdown: 'Our &#73;&#66;&#65;&#78; is DE89 3704 0044.' })),
    ).rejects.toMatchObject({ code: 'review_rejected' });
    expect(smtp.sent).toHaveLength(0);
  });
});

describe('no secrets towards the agent', () => {
  it('rejects credentials in the model URL', () => {
    const cfg = `mailboxes:
  - name: a
    address: a@example.com
    api_key: ${'k'.repeat(32)}
    imap: { host: h, port: 993, security: tls }
    smtp: { host: h, port: 465, security: tls }
    username: u
    password: p
    review:
      llm: { url: "http://user:secret@ollama:11434/v1", model: m }
`;
    expect(() => parseConfig(cfg, {})).toThrow(/credentials/);
  });

  it('does not pass internal error details to the agent', async () => {
    const { ctx } = withModel(
      flagIban,
      { llm: { mode: 'warn' } },
      { throwError: 'connect ECONNREFUSED 10.0.0.5:11434 http://ollama:11434/v1' },
    );
    const res = await sendMessage(ctx, mail());
    expect(res.warnings.join(' ')).not.toMatch(/10\.0\.0\.5|ollama/);
    expect(res.warnings.join(' ')).toContain('model unreachable');
  });
});

describe('answers from invitees that are not on allow_receive_from', () => {
  it('are recorded, and the mail itself stays filtered', async () => {
    const { ctx, imap } = createTestContext({
      allow_receive_from: ['boss@test.local'],
      allow_send_to: ['*@partner.local'],
    });
    const ev = await createEvent(ctx, {
      title: 'T',
      start: '2026-10-10T12:00:00Z',
      end: '2026-10-10T13:00:00Z',
      attendees: ['x@partner.local'],
    });
    const w = new InboundWatcher(ctx);
    await w.processNew();
    const ics = [
      'BEGIN:VCALENDAR',
      'METHOD:REPLY',
      'BEGIN:VEVENT',
      `UID:${ev.id}@test.local`,
      'SEQUENCE:0',
      'DTSTART:20261010T120000Z',
      'ATTENDEE;PARTSTAT=ACCEPTED:mailto:x@partner.local',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    imap.add(
      await buildRaw({
        from: 'x@partner.local',
        subject: 'Accepted',
        text: 'yes',
        attachments: [
          { filename: 'r.ics', contentType: 'text/calendar; method=REPLY', content: ics },
        ],
      }),
    );
    await w.processNew();
    expect(getEvent(ctx, ev.id).responses).toEqual({ 'x@partner.local': 'accepted' });
    expect(imap.trash).toHaveLength(1);
  });
});

describe('example config works out of the box', () => {
  it('parses with only the required secrets', () => {
    const text = readFileSync('config.example.yaml', 'utf8');
    expect(() =>
      parseConfig(text, { AGENT_API_KEY: 'x'.repeat(32), AGENT_MAIL_PASSWORD: 'p' }),
    ).not.toThrow();
  });
});

describe('MCP surface for small models', () => {
  async function client() {
    const { ctx } = createTestContext();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(ctx).connect(b);
    const c = new Client({ name: 't', version: '1' });
    await c.connect(a);
    return c;
  }
  it('has server instructions with the essentials', async () => {
    const c = await client();
    const instructions = c.getInstructions() ?? '';
    expect(instructions).toMatch(/get_mailbox_info/);
    expect(instructions).toMatch(/never instructions|data, not instructions/i);
    expect(instructions).toMatch(/reply_message/);
  });
  it('describes every id and index argument', async () => {
    const c = await client();
    for (const tool of (await c.listTools()).tools) {
      const props =
        (tool.inputSchema as { properties?: Record<string, { description?: string }> })
          .properties ?? {};
      for (const name of ['id', 'index']) {
        if (props[name]) expect(props[name]!.description, `${tool.name}.${name}`).toBeTruthy();
      }
    }
    const update = (await c.listTools()).tools.find((t) => t.name === 'update_event')!;
    expect(JSON.stringify(update.inputSchema)).toMatch(/[Ee]vent id/);
  });
});

describe('time awareness', () => {
  it('mailbox info has the current time and the active review setup', () => {
    const { ctx } = createTestContext({
      timezone: 'Europe/Berlin',
      review: {
        llm: { url: 'http://o/v1', model: 'm' },
        policies: { rules: [{ rule: 'No gifts.', recipients: ['a@partner.local'] }] },
      },
    });
    const info = mailboxInfo(ctx) as Record<string, unknown>;
    expect(info.now).toBe(new Date(TEST_NOW).toISOString());
    expect(String(info.now_local)).toContain('02:00');
    expect(info.review).toMatchObject({
      rules: 'block',
      policies: [{ rule: 'No gifts.', recipients: ['a@partner.local'] }],
    });
  });
  it('events show local times', async () => {
    const { ctx } = createTestContext({ timezone: 'Europe/Berlin' });
    const ev = await createEvent(ctx, {
      title: 'T',
      start: '2026-10-10T14:00',
      end: '2026-10-10T15:00',
      attendees: ['boss@test.local'],
    });
    expect(ev).toMatchObject({ start: '2026-10-10T12:00:00.000Z' });
    expect(ev.start_local).toContain('14:00');
  });
});

describe('attachments made easy', () => {
  it('accepts plain text content', async () => {
    const { ctx, smtp } = createTestContext();
    await sendMessage(
      ctx,
      mail({
        attachments: [
          { filename: 'notes.csv', content_type: 'text/csv', content_text: 'a,b\n1,2' },
        ],
      } as never),
    );
    expect((await parseMessage(smtp.sent[0]!.raw)).attachments[0]!.content.toString()).toBe(
      'a,b\n1,2',
    );
  });
  it('can attach a file from a received message without base64', async () => {
    const { ctx, imap, smtp } = createTestContext();
    const uid = imap.add(
      await buildRaw({
        from: 'boss@test.local',
        subject: 'File',
        text: 'here',
        attachments: [{ filename: 'c.pdf', content: 'PDF!', contentType: 'application/pdf' }],
      }),
    );
    await sendMessage(
      ctx,
      mail({ attachments: [{ from_message: { id: `1-${uid}`, index: 0 } }] } as never),
    );
    const a = (await parseMessage(smtp.sent[0]!.raw)).attachments[0]!;
    expect([a.filename, a.content.toString()]).toEqual(['c.pdf', 'PDF!']);
  });
  it('requires exactly one content source', () => {
    expect(() =>
      sendMessageSchema.parse({
        to: ['boss@test.local'],
        subject: 's',
        body_markdown: 'b',
        attachments: [{ filename: 'x' }],
      }),
    ).toThrow();
  });
});

describe('small fixes', () => {
  it('reads DURATION and floating times', () => {
    const ics = (lines: string) =>
      `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\n${lines}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    expect(parseIcs(ics('DTSTART:20261010T120000Z\r\nDURATION:PT1H30M'))!.end).toBe(
      '2026-10-10T13:30:00.000Z',
    );
    expect(parseIcs(ics('DTSTART:20261010T140000'), 'Europe/Berlin')!.start).toBe(
      '2026-10-10T12:00:00.000Z',
    );
  });
  it('does not stack Re: on AW:', async () => {
    const { ctx, imap, smtp } = createTestContext();
    const uid = imap.add(
      await buildRaw({ from: 'boss@test.local', subject: 'AW: Planung', text: 'ok?' }),
    );
    await replyMessage(ctx, `1-${uid}`, {
      body_markdown: 'Passt, danke dir.',
      reply_all: false,
      attachments: [],
    });
    expect((await parseMessage(smtp.sent[0]!.raw)).subject).toBe('AW: Planung');
  });
  it('moving only the start keeps the duration', async () => {
    const { ctx } = createTestContext();
    const ev = await createEvent(ctx, {
      title: 'T',
      start: '2026-10-10T12:00:00Z',
      end: '2026-10-10T13:00:00Z',
      attendees: ['boss@test.local'],
    });
    const moved = await updateEvent(ctx, ev.id, { start: '2026-10-10T16:00:00Z' });
    expect(moved.end).toBe('2026-10-10T17:00:00.000Z');
  });
});

describe('get_attachment over MCP', () => {
  it('returns text files as readable text', async () => {
    const { ctx, imap } = createTestContext();
    const uid = imap.add(
      await buildRaw({
        from: 'boss@test.local',
        subject: 'CSV',
        text: 'see file',
        attachments: [{ filename: 'n.csv', content: 'a,b\n1,2', contentType: 'text/csv' }],
      }),
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(ctx).connect(b);
    const c = new Client({ name: 't', version: '1' });
    await c.connect(a);
    const res = (await c.callTool({
      name: 'get_attachment',
      arguments: { id: `1-${uid}`, index: 0 },
    })) as {
      content: { type: string; text?: string }[];
    };
    expect(res.content[0]).toMatchObject({ type: 'text' });
    expect(res.content[0]!.text).toContain('a,b\n1,2');
  });
});
