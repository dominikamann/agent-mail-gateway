import { describe, expect, it } from 'vitest';
import { toUtc } from '../../src/calendar/time.js';
import { htmlToMarkdown } from '../../src/convert/html-to-md.js';
import { parseHeaders } from '../../src/mail/parse.js';
import { decideInbound } from '../../src/policy/inbound.js';
import { evaluateSenderAuth } from '../../src/policy/sender-auth.js';
import { createEvent, updateEvent } from '../../src/services/events.js';
import { getMessage, listMessages } from '../../src/services/messages.js';
import { sendMessage } from '../../src/services/send.js';
import { Store } from '../../src/store/store.js';
import { InboundWatcher } from '../../src/watcher/watcher.js';
import { WebhookDispatcher } from '../../src/webhook/dispatcher.js';
import { testMailboxConfig } from '../helpers/config.js';
import { createTestContext } from '../helpers/fakes.js';
import { buildRaw } from '../helpers/mail.js';
import { silentLogger } from '../helpers/wait.js';

const hugeHeader = (from: string) =>
  Buffer.from(
    `From: ${from}\r\nSubject: pad\r\n${'X-Pad: '.concat('a'.repeat(80), '\r\n').repeat(13_000)}\r\nbody\r\n`,
  );

describe('C1: oversized headers never break listing and are filtered', () => {
  it('parseHeaders returns null instead of throwing', async () => {
    expect(await parseHeaders(hugeHeader('spam@evil.example'))).toBeNull();
  });

  it('decideInbound treats unparsable headers as not allowed', () => {
    expect(
      decideInbound({ allow_receive_from: ['*@evil.example'], require_sender_auth: false }, null),
    ).toEqual({
      allowed: false,
      reason: 'unparsable',
    });
  });

  it('watcher trashes and audits it; list skips it', async () => {
    const { ctx, imap, store } = createTestContext();
    const w = new InboundWatcher(ctx);
    await w.processNew();
    imap.add(await buildRaw({ from: 'boss@test.local', subject: 'old' }));
    imap.add(hugeHeader('spam@evil.example'));
    imap.add(await buildRaw({ from: 'boss@test.local', subject: 'new' }));
    expect((await listMessages(ctx, { limit: 20 })).messages.map((m) => m.subject)).toEqual([
      'new',
      'old',
    ]);
    await w.processNew();
    expect(imap.trash).toHaveLength(1);
    expect(store.listAudit('agent')).toMatchObject([
      { action: 'filtered_delete', detail: 'unparsable' },
    ]);
  });
});

describe('C2: conversion time is bounded', () => {
  it('unclosed tags without a text part', () => {
    const started = Date.now();
    htmlToMarkdown(`${'<a '.repeat(200_000)}x`);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('deep nesting', () => {
    const started = Date.now();
    htmlToMarkdown(`${'<div>'.repeat(40_000)}x${'</div>'.repeat(40_000)}`);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('normal html still converts', () => {
    expect(htmlToMarkdown('<p>Hello <b>you</b></p>')).toBe('Hello **you**');
  });
});

describe('I1: listing does not download bodies it does not need', () => {
  it('fetches full sources only for allowed messages', async () => {
    const { ctx, imap } = createTestContext();
    for (let i = 0; i < 5; i++) imap.add(await buildRaw({ from: 'stranger@evil.local' }));
    imap.add(await buildRaw({ from: 'boss@test.local', subject: 'ok', text: 'Body' }));
    const res = await listMessages(ctx, { limit: 20 });
    expect(res.messages.map((m) => m.preview)).toEqual(['Body']);
    expect(imap.fullFetches).toEqual([6]);
  });

  it('skips the preview for very large messages', async () => {
    const { ctx, imap } = createTestContext();
    imap.add(
      await buildRaw({
        from: 'boss@test.local',
        attachments: [{ filename: 'big.bin', content: Buffer.alloc(3 * 1024 * 1024) }],
      }),
    );
    const [msg] = (await listMessages(ctx, { limit: 20 })).messages;
    expect(msg).toMatchObject({ preview: '', has_attachments: true });
    expect(imap.fullFetches).toEqual([]);
  });

  it('watcher does not download bodies of blocked mail', async () => {
    const { ctx, imap } = createTestContext({
      webhook: { url: 'https://h.test/x', secret: 's'.repeat(16) },
    });
    const w = new InboundWatcher(ctx);
    await w.processNew();
    imap.add(await buildRaw({ from: 'stranger@evil.local' }));
    await w.processNew();
    expect(imap.fullFetches).toEqual([]);
  });
});

describe('I2: dmarc=none falls back to aligned DKIM/SPF', () => {
  it('passes with aligned dkim', () => {
    const h = 'mx; dmarc=none (p=none) header.from=small.org; dkim=pass header.d=small.org';
    expect(evaluateSenderAuth([h], 'a@small.org')).toBe('pass');
  });
  it('still fails without aligned dkim/spf', () => {
    expect(evaluateSenderAuth(['mx; dmarc=none header.from=small.org'], 'a@small.org')).toBe(
      'fail',
    );
  });
});

describe('I3: since uses the arrival time', () => {
  it('keeps a mail written before but delivered after `since`', async () => {
    const { ctx, imap } = createTestContext();
    imap.add(
      await buildRaw({
        from: 'boss@test.local',
        subject: 'late',
        date: new Date('2026-10-02T09:55:00Z'),
      }),
      false,
      new Date('2026-10-02T10:10:00Z'),
    );
    const res = await listMessages(ctx, { limit: 10, since: new Date('2026-10-02T10:00:00Z') });
    expect(res.messages.map((m) => m.subject)).toEqual(['late']);
  });
});

describe('M2: cursor never points at a hidden message', () => {
  it('uses the last returned id', async () => {
    const { ctx, imap } = createTestContext();
    imap.add(await buildRaw({ from: 'boss@test.local', subject: 'a' }));
    const blocked = imap.add(await buildRaw({ from: 'stranger@evil.local' }));
    imap.add(await buildRaw({ from: 'boss@test.local', subject: 'b' }));
    const page = await listMessages(ctx, { limit: 1 });
    expect(page.next_cursor).not.toBe(`1-${blocked}`);
    expect(page.next_cursor).toBe(page.messages[0]!.id);
  });
});

describe('M3: invalid dates are validation errors', () => {
  it('rejects out-of-range and non-existent dates', () => {
    for (const v of ['2026-13-45T25:61', '2026-02-30T10:00', '2026-02-30T10:00:00Z']) {
      expect(() => toUtc(v, 'UTC'), v).toThrow(
        expect.objectContaining({ code: 'validation_error' }),
      );
    }
  });
});

describe('M4: event updates reserve both sends', () => {
  it('a parallel send cannot take the cancellation slot', async () => {
    const { ctx, smtp } = createTestContext({ max_sends_per_hour: 3 });
    const ev = await createEvent(ctx, {
      title: 'T',
      start: '2026-10-05T14:00:00Z',
      end: '2026-10-05T15:00:00Z',
      attendees: ['boss@test.local', 'a@partner.local'],
    });
    const send = {
      to: ['boss@test.local'],
      cc: [],
      bcc: [],
      subject: 's',
      body_markdown: 'b',
      attachments: [],
    };
    const [updated, other] = await Promise.allSettled([
      updateEvent(ctx, ev.id, { attendees: ['boss@test.local'] }),
      sendMessage(ctx, send),
    ]);
    expect(updated.status).toBe('fulfilled');
    expect(
      (updated as PromiseFulfilledResult<{ warnings?: string[] }>).value.warnings,
    ).toBeUndefined();
    expect(other.status).toBe('rejected');
    expect(smtp.sent).toHaveLength(3);
  });
});

describe('M5: trusted authserv-id', () => {
  it('ignores Authentication-Results from other servers', () => {
    const forged = 'attacker.example; dmarc=pass header.from=test.local';
    expect(evaluateSenderAuth([forged], 'boss@test.local', 'mx.mine.example')).toBe('missing');
    expect(
      evaluateSenderAuth(
        [forged, 'mx.mine.example; dmarc=pass header.from=test.local'],
        'boss@test.local',
        'mx.mine.example',
      ),
    ).toBe('pass');
  });

  it('is configurable per mailbox', async () => {
    const { ctx, imap } = createTestContext({
      require_sender_auth: true,
      trusted_authserv_id: 'mx.mine.example',
    });
    imap.add(
      await buildRaw({
        from: 'boss@test.local',
        subject: 'forged',
        headers: {
          'Authentication-Results': 'attacker.example; dmarc=pass header.from=test.local',
        },
      }),
    );
    expect((await listMessages(ctx, { limit: 5 })).messages).toEqual([]);
  });
});

describe('M6: dispatcher stops between jobs', () => {
  it('does not start new deliveries after stop', async () => {
    const store = new Store(':memory:');
    const cfg = testMailboxConfig({ webhook: { url: 'https://h.test/x', secret: 's'.repeat(16) } });
    let calls = 0;
    let release: () => void = () => {};
    const fetchFn = (() => {
      calls++;
      return new Promise<Response>((r) => {
        release = () => r(new Response(null, { status: 200 }));
      });
    }) as unknown as typeof fetch;
    const d = new WebhookDispatcher({
      store,
      mailboxes: new Map([[cfg.name, cfg]]),
      log: silentLogger,
      fetchFn,
    });
    store.enqueueWebhook('agent', '1-1', '{}', 0);
    store.enqueueWebhook('agent', '1-2', '{}', 0);
    void d.runOnce();
    await new Promise((r) => setTimeout(r, 10));
    const stopped = d.stop();
    release();
    await stopped;
    expect(calls).toBe(1);
    expect(store.webhookStatus('agent', '1-2')?.status).toBe('pending');
  });
});

describe('read still works for messages over the preview limit', () => {
  it('reads a large allowed message in full', async () => {
    const { ctx, imap } = createTestContext();
    const uid = imap.add(
      await buildRaw({
        from: 'boss@test.local',
        text: 'Big one',
        attachments: [{ filename: 'big.bin', content: Buffer.alloc(3 * 1024 * 1024) }],
      }),
    );
    expect((await getMessage(ctx, `1-${uid}`, false)).body_markdown).toBe('Big one');
  });
});
