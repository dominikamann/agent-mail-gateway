import { describe, expect, it } from 'vitest';
import { parseIcs } from '../../src/calendar/parse-ics.js';
import { parseConfig } from '../../src/config/load.js';
import type { MailboxConfigInput } from '../../src/config/schema.js';
import { createEvent } from '../../src/services/events.js';
import type { SendMessageInput } from '../../src/services/schemas.js';
import { sendMessageSchema } from '../../src/services/schemas.js';
import { sendMessage } from '../../src/services/send.js';
import { InboundWatcher } from '../../src/watcher/watcher.js';
import { createTestContext } from '../helpers/fakes.js';
import { buildRaw } from '../helpers/mail.js';

type Body = { messages: { role: string; content: string }[] };

function guarded(extra: Partial<MailboxConfigInput> = {}) {
  const bodies: Body[] = [];
  const t = createTestContext({
    review: {
      llm: { url: 'http://ollama:11434/v1', model: 'm', mode: 'off' },
      policies: { rules: [{ rule: 'Never share bank details.' }] },
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

describe('policies see everything that is sent', () => {
  for (const [name, body] of [
    ['html comment', 'Report ready. <!-- IBAN DE89 3704 0044 0532 0130 00 -->'],
    ['reference definition', 'Report ready.\n\n[x]: https://example.org/IBAN-DE89'],
    ['image alt text', 'Report ready. ![IBAN DE89 3704](https://example.org/x.png)'],
    ['zero-width characters', 'Report ready. I​B​A​N DE89 3704'],
  ] as const) {
    it(`catches content hidden in ${name}`, async () => {
      const { ctx, smtp } = guarded();
      await expect(sendMessage(ctx, mail({ body_markdown: body }))).rejects.toMatchObject({
        code: 'review_rejected',
      });
      expect(smtp.sent).toHaveLength(0);
    });
  }

  it('checks the raw invitation description', async () => {
    const { ctx, smtp } = guarded();
    await expect(
      createEvent(ctx, {
        title: 'T',
        start: '2026-10-10T12:00:00Z',
        end: '2026-10-10T13:00:00Z',
        attendees: ['boss@test.local'],
        description_markdown: 'Agenda <!-- IBAN DE89 -->',
      }),
    ).rejects.toMatchObject({ code: 'review_rejected' });
    expect(smtp.sent).toHaveLength(0);
  });

  it('checks text attachments written by the agent', async () => {
    const { ctx, smtp } = guarded();
    await expect(
      sendMessage(
        ctx,
        mail({ attachments: [{ filename: 'notes.txt', content_text: 'IBAN DE89 3704' }] } as never),
      ),
    ).rejects.toMatchObject({ code: 'review_rejected' });
    const b64 = Buffer.from('IBAN DE89').toString('base64');
    await expect(
      sendMessage(
        ctx,
        mail({
          attachments: [{ filename: 'n.csv', content_type: 'text/csv', content_base64: b64 }],
        } as never),
      ),
    ).rejects.toMatchObject({ code: 'review_rejected' });
    expect(smtp.sent).toHaveLength(0);
  });

  it('the policy prompt names the field that carries the content', async () => {
    const { ctx, bodies } = guarded();
    await sendMessage(ctx, mail());
    expect(bodies[0]!.messages[0]!.content).toMatch(/"text"/);
    expect(bodies[0]!.messages[0]!.content).not.toMatch(/forwarded_original/);
  });
});

describe('from_message attachments are bounded', () => {
  it('rejects more than 20 attachments', () => {
    const many = Array.from({ length: 21 }, () => ({ filename: 'a.txt', content_text: 'x' }));
    expect(() =>
      sendMessageSchema.parse({
        to: ['boss@test.local'],
        subject: 's',
        body_markdown: 'b',
        attachments: many,
      }),
    ).toThrow();
  });

  it('stops loading as soon as the size limit is exceeded and loads each message once', async () => {
    const { ctx, imap } = createTestContext({ max_attachment_mb: 0.001 });
    const uid = imap.add(
      await buildRaw({
        from: 'boss@test.local',
        text: 'big',
        attachments: [{ filename: 'b.bin', content: Buffer.alloc(800) }],
      }),
    );
    const ref = { from_message: { id: `1-${uid}`, index: 0 } };
    await expect(
      sendMessage(ctx, mail({ attachments: [ref, ref, ref, ref, ref] } as never)),
    ).rejects.toMatchObject({ code: 'attachment_too_large' });
    expect(imap.fullFetches.length).toBeLessThanOrEqual(1);
  });

  it('does not re-attach calendar files from received mail', async () => {
    const { ctx, imap } = createTestContext();
    const uid = imap.add(
      await buildRaw({
        from: 'boss@test.local',
        text: 'inv',
        attachments: [
          { filename: 'invite.ics', content: 'BEGIN:VCALENDAR', contentType: 'text/calendar' },
        ],
      }),
    );
    await expect(
      sendMessage(
        ctx,
        mail({ attachments: [{ from_message: { id: `1-${uid}`, index: 0 } }] } as never),
      ),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('small fixes', () => {
  const cfg = (url: string) => `mailboxes:
  - name: a
    address: a@example.com
    api_key: ${'k'.repeat(32)}
    imap: { host: h, port: 993, security: tls }
    smtp: { host: h, port: 465, security: tls }
    username: u
    password: p
    review:
      llm: { url: "${url}", model: m }
`;
  it('detects credentials in any URL form, allows @ in the query', () => {
    expect(() => parseConfig(cfg('http:u:p@host/v1'), {})).toThrow(/credentials/);
    expect(() => parseConfig(cfg('http://h:11434/v1?x=a@b'), {})).not.toThrow();
  });

  it('all-day DURATION and non-positive durations', () => {
    const ics = (l: string) =>
      `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\n${l}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    expect(parseIcs(ics('DTSTART;VALUE=DATE:20261010\r\nDURATION:P3D'))!.end).toBe('2026-10-13');
    expect(parseIcs(ics('DTSTART:20261010T120000Z\r\nDURATION:-PT1H'))!.end).toBeNull();
  });

  it('a failure while recording an invitee reply still filters the mail', async () => {
    const { ctx, imap } = createTestContext({ allow_receive_from: ['boss@test.local'] });
    await createEvent(ctx, {
      title: 'T',
      start: '2026-10-10T12:00:00Z',
      end: '2026-10-10T13:00:00Z',
      attendees: ['x@partner.local'],
    });
    const w = new InboundWatcher(ctx);
    await w.processNew();
    imap.add(
      Buffer.from(
        'From: x@partner.local\r\nContent-Type: text/calendar; method=REPLY\r\n\r\nBEGIN:VCALENDAR\r\nBROKEN',
      ),
    );
    ctx.store.listEvents = () => {
      throw new Error('boom');
    };
    await w.processNew();
    expect(imap.trash).toHaveLength(1);
  });
});
