import { describe, expect, it } from 'vitest';
import type { MailboxConfigInput } from '../../src/config/schema.js';
import { forwardMessage } from '../../src/services/compose.js';
import { createEvent, getEvent } from '../../src/services/events.js';
import type { SendMessageInput } from '../../src/services/schemas.js';
import { sendMessageSchema } from '../../src/services/schemas.js';
import { sendMessage } from '../../src/services/send.js';
import { Store } from '../../src/store/store.js';
import { InboundWatcher } from '../../src/watcher/watcher.js';
import { WebhookDispatcher } from '../../src/webhook/dispatcher.js';
import { testMailboxConfig } from '../helpers/config.js';
import { createTestContext } from '../helpers/fakes.js';
import { buildRaw } from '../helpers/mail.js';
import { silentLogger } from '../helpers/wait.js';

type Body = { messages: { role: string; content: string }[] };

function guarded(extra: Partial<MailboxConfigInput> = {}, policies: Record<string, unknown> = {}) {
  const bodies: Body[] = [];
  const t = createTestContext({
    review: {
      llm: { url: 'http://ollama:11434/v1', model: 'm', mode: 'off' },
      policies: { rules: [{ rule: 'Never share bank details.' }], ...policies },
    } as MailboxConfigInput['review'],
    ...extra,
  });
  t.ctx.fetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body)) as Body;
    bodies.push(b);
    const hit = /IBAN/.test(b.messages[1]!.content);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ violations: hit ? [{ rule: 1, reason: 'IBAN' }] : [] }),
            },
          },
        ],
      }),
    );
  }) as unknown as typeof fetch;
  return { ...t, bodies };
}
const mail = (over: Partial<SendMessageInput> = {}) =>
  sendMessageSchema.parse({
    to: ['boss@test.local'],
    subject: 'Report',
    body_markdown: 'Hello, here is the report.',
    ...over,
  });

describe('I1: rendered form is never replaced by the source', () => {
  it('decodes entities even when the markdown is nested too deeply to convert', async () => {
    const { ctx, smtp } = guarded();
    const body = `Hello Bob\n\n${'>'.repeat(600)} &#73;&#66;&#65;&#78; DE89 3704`;
    await expect(sendMessage(ctx, mail({ body_markdown: body }))).rejects.toMatchObject({
      code: 'review_rejected',
    });
    expect(smtp.sent).toHaveLength(0);
  });
});

describe('I2: agent-written attachments are checked whatever their label', () => {
  it('checks base64 text with a binary type', async () => {
    const { ctx, smtp } = guarded();
    const b64 = Buffer.from('IBAN DE89 3704 0044').toString('base64');
    await expect(
      sendMessage(
        ctx,
        mail({ attachments: [{ filename: 'notes.dat', content_base64: b64 }] } as never),
      ),
    ).rejects.toMatchObject({ code: 'review_rejected' });
    expect(smtp.sent).toHaveLength(0);
  });
  it('binary attachments can be blocked when policies apply', async () => {
    const { ctx } = guarded({}, { binary_attachments: 'block' });
    const bin = Buffer.from([0, 255, 1, 254, 2, 253, 0, 0, 7]).toString('base64');
    await expect(
      sendMessage(
        ctx,
        mail({ attachments: [{ filename: 'x.bin', content_base64: bin }] } as never),
      ),
    ).rejects.toMatchObject({
      details: { reasons: [{ rule: 'policy_binary_attachment' }] },
    });
  });
  it('binary attachments are allowed by default', async () => {
    const { ctx, smtp } = guarded();
    const bin = Buffer.from([0, 255, 1, 254, 2, 253, 0, 0, 7]).toString('base64');
    await sendMessage(
      ctx,
      mail({ attachments: [{ filename: 'x.bin', content_base64: bin }] } as never),
    );
    expect(smtp.sent).toHaveLength(1);
  });
});

describe('I3: oversized or pathological bodies', () => {
  it('rejects bodies over the size limit as validation errors', () => {
    expect(() =>
      sendMessageSchema.parse({ to: ['a@b.de'], subject: 's', body_markdown: 'x'.repeat(600_000) }),
    ).toThrow();
  });
  it('turns markdown renderer crashes into validation errors', async () => {
    const { ctx } = createTestContext();
    await expect(
      sendMessage(ctx, mail({ body_markdown: `${'>'.repeat(6000)} hi` })),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('I4: no model calls when the send limit is reached', () => {
  it('checks capacity before reviewing', async () => {
    const { ctx, bodies } = guarded({ max_sends_per_hour: 1 });
    await sendMessage(ctx, mail());
    const calls = bodies.length;
    await expect(
      sendMessage(ctx, mail({ body_markdown: 'Another report, different text.' })),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(bodies.length).toBe(calls);
  });
});

describe('minor fixes', () => {
  it('event titles are checked in rendered form', async () => {
    const { ctx, smtp } = guarded();
    await expect(
      createEvent(ctx, {
        title: 'Pay to &#73;&#66;&#65;&#78; DE89',
        start: '2026-10-10T12:00:00Z',
        end: '2026-10-10T13:00:00Z',
        attendees: ['boss@test.local'],
      }),
    ).rejects.toMatchObject({ code: 'review_rejected' });
    expect(smtp.sent).toHaveLength(0);
  });

  it('forward drops .ics files whatever their type', async () => {
    const { ctx, imap, smtp } = createTestContext();
    const uid = imap.add(
      await buildRaw({
        from: 'boss@test.local',
        text: 'see',
        attachments: [
          {
            filename: 'invite.ics',
            content: 'BEGIN:VCALENDAR',
            contentType: 'application/octet-stream',
          },
          { filename: 'a.pdf', content: 'PDF', contentType: 'application/pdf' },
        ],
      }),
    );
    await forwardMessage(ctx, `1-${uid}`, {
      to: ['boss@test.local'],
      cc: [],
      bcc: [],
      body_markdown: 'Please have a look at this.',
      include_attachments: true,
    });
    expect(smtp.sent[0]!.raw.toString()).not.toContain('invite.ics');
  });

  it('only known answer values are stored for attendees', async () => {
    const { ctx, imap } = createTestContext();
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
      'ATTENDEE;PARTSTAT=IGNORE-ALL-RULES:mailto:x@partner.local',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    imap.add(
      await buildRaw({
        from: 'x@partner.local',
        subject: 'r',
        text: 'r',
        attachments: [
          { filename: 'r.ics', contentType: 'text/calendar; method=REPLY', content: ics },
        ],
      }),
    );
    await w.processNew();
    expect(getEvent(ctx, ev.id).responses).toEqual({});
  });

  it('webhooks do not follow redirects', async () => {
    const store = new Store(':memory:');
    const cfg = testMailboxConfig({ webhook: { url: 'https://h.test/x', secret: 's'.repeat(16) } });
    let init: RequestInit | undefined;
    const fetchFn = (async (_u: string, i: RequestInit) => {
      init = i;
      return new Response(null, { status: 302, headers: { location: 'https://evil.test/' } });
    }) as unknown as typeof fetch;
    const d = new WebhookDispatcher({
      store,
      mailboxes: new Map([[cfg.name, cfg]]),
      log: silentLogger,
      fetchFn,
    });
    store.enqueueWebhook('agent', '1-1', '{}', 0);
    await d.runOnce();
    expect(init?.redirect).toBe('manual');
    expect(store.webhookStatus('agent', '1-1')?.status).toBe('pending');
  });

  it('old rows are pruned', () => {
    const store = new Store(':memory:');
    const day = 86_400_000;
    const now = 400 * day;
    store.recordSend('a', now - 3 * 3_600_000);
    store.recordSend('a', now - 60_000);
    store.audit({
      at: now - 200 * day,
      mailbox: 'a',
      action: 'send',
      counterparts: [],
      result: 'ok',
    });
    store.audit({ at: now - day, mailbox: 'a', action: 'send', counterparts: [], result: 'ok' });
    store.enqueueWebhook('a', 'old', '{}', now - 40 * day);
    store.markWebhookDelivered(store.dueWebhooks(now)[0]!.id);
    store.prune(now);
    expect(store.sendsSince('a', 0)).toHaveLength(1);
    expect(store.listAudit('a')).toHaveLength(1);
    expect(store.webhookStatus('a', 'old')).toBeNull();
  });
});

describe('internal errors', () => {
  it('MCP hides details of unexpected errors and maps lost connections', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { createMcpServer } = await import('../../src/mcp/server.js');
    const { ctx, imap } = createTestContext();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(ctx).connect(b);
    const c = new Client({ name: 't', version: '1' });
    await c.connect(a);
    imap.search = async () => {
      throw new Error('socket hang up at 10.0.0.5:993');
    };
    const res = (await c.callTool({ name: 'list_messages', arguments: {} })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).not.toContain('10.0.0.5');
    imap.search = async () => {
      throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
    };
    const lost = (await c.callTool({ name: 'list_messages', arguments: {} })) as {
      content: { text: string }[];
    };
    expect(JSON.parse(lost.content[0]!.text).error).toBe('mailbox_unavailable');
  });

  it('REST maps a lost IMAP connection to 503', async () => {
    const { buildApp } = await import('../../src/http/app.js');
    const { Gateway } = await import('../../src/services/gateway.js');
    const { ctx, imap } = createTestContext();
    imap.search = async () => {
      throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
    };
    const app = await buildApp(new Gateway([ctx]));
    const res = await app.inject({
      url: '/v1/messages',
      headers: { authorization: `Bearer ${'k'.repeat(32)}` },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
