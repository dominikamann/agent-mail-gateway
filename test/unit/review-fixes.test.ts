import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../../src/convert/html-to-md.js';
import { parseMessage } from '../../src/mail/parse.js';
import { decideInbound } from '../../src/policy/inbound.js';
import { evaluateSenderAuth } from '../../src/policy/sender-auth.js';
import { createEvent, updateEvent } from '../../src/services/events.js';
import { listMessages } from '../../src/services/messages.js';
import { sendMessage } from '../../src/services/send.js';
import { InboundWatcher } from '../../src/watcher/watcher.js';
import { createTestContext } from '../helpers/fakes.js';
import { buildRaw } from '../helpers/mail.js';

const deepHtml = `${'<div>'.repeat(6000)}x${'</div>'.repeat(6000)}`;

describe('C1: hostile html never breaks parsing, watcher or list', () => {
  it('parseMessage survives deeply nested html', async () => {
    const raw = await buildRaw({ from: 'boss@test.local', html: deepHtml, text: 'fallback text' });
    const p = await parseMessage(raw);
    expect(p.from).toBe('boss@test.local');
    expect(p.bodyMarkdown).toContain('fallback text');
  });

  it('watcher filters a hostile non-allowed mail and keeps processing later mail', async () => {
    const { ctx, imap, store } = createTestContext({
      webhook: { url: 'https://hooks.test/x', secret: 's'.repeat(16) },
    });
    const w = new InboundWatcher(ctx);
    await w.processNew();
    imap.add(await buildRaw({ from: 'stranger@evil.local', html: deepHtml }));
    const good = imap.add(await buildRaw({ from: 'boss@test.local', subject: 'ok' }));
    await w.processNew();
    expect(imap.trash).toHaveLength(1);
    expect(store.getWatcherState('agent')?.lastUid).toBe(good);
    expect(store.dueWebhooks(Date.now())).toHaveLength(1);
  });

  it('list skips past a hostile message', async () => {
    const { ctx, imap } = createTestContext();
    imap.add(await buildRaw({ from: 'boss@test.local', subject: 'old' }));
    imap.add(await buildRaw({ from: 'stranger@evil.local', html: deepHtml }));
    const res = await listMessages(ctx, { limit: 20 });
    expect(res.messages.map((m) => m.subject)).toEqual(['old']);
  });
});

describe('I1: pathological whitespace converts quickly', () => {
  it('handles 200k spaces in <pre> in under a second', () => {
    const started = Date.now();
    htmlToMarkdown(`<pre>${' '.repeat(200_000)}x</pre><p>${'a '.repeat(50_000)}\n</p>`);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('I2: sender spoofing via From/DMARC mismatch', () => {
  it('dmarc pass for a different header.from domain does not count', () => {
    expect(evaluateSenderAuth(['mx; dmarc=pass header.from=bad.com'], 'boss@test.local')).toBe(
      'fail',
    );
  });

  it('a message with two From headers is not allowed', async () => {
    const raw = Buffer.from(
      'From: evil@bad.com\r\nFrom: boss@test.local\r\nSubject: x\r\n\r\nbody\r\n',
    );
    const p = await parseMessage(raw);
    expect(
      decideInbound({ allow_receive_from: ['boss@test.local'], require_sender_auth: false }, p),
    ).toEqual({
      allowed: false,
      reason: 'sender_not_allowed',
    });
  });

  it('a From header with two addresses is not allowed', async () => {
    const raw = Buffer.from('From: boss@test.local, evil@bad.com\r\nSubject: x\r\n\r\nbody\r\n');
    expect((await parseMessage(raw)).from).toBeNull();
  });
});

describe('I3: rate limit holds under concurrency', () => {
  it('only lets max_sends_per_hour through when sends run in parallel', async () => {
    const { ctx, smtp } = createTestContext({ max_sends_per_hour: 3 });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        sendMessage(ctx, {
          to: ['boss@test.local'],
          cc: [],
          bcc: [],
          subject: 's',
          body_markdown: 'b',
          attachments: [],
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(smtp.sent).toHaveLength(3);
  });

  it('a failed smtp send does not consume the quota', async () => {
    const { ctx, smtp, store } = createTestContext({ max_sends_per_hour: 1 });
    smtp.fail = true;
    const input = {
      to: ['boss@test.local'],
      cc: [],
      bcc: [],
      subject: 's',
      body_markdown: 'b',
      attachments: [],
    };
    await expect(sendMessage(ctx, input)).rejects.toMatchObject({ code: 'send_failed' });
    expect(store.sendsSince('agent', 0)).toHaveLength(0);
    smtp.fail = false;
    await expect(sendMessage(ctx, input)).resolves.toBeTruthy();
  });
});

describe('I4: event updates stay consistent', () => {
  const base = {
    title: 'T',
    start: '2026-10-05T14:00:00Z',
    end: '2026-10-05T15:00:00Z',
    attendees: ['boss@test.local', 'a@partner.local'],
  };

  it('checks capacity for all sends before sending anything', async () => {
    const { ctx, smtp, store } = createTestContext({ max_sends_per_hour: 2 });
    const ev = await createEvent(ctx, base);
    await expect(updateEvent(ctx, ev.id, { attendees: ['boss@test.local'] })).rejects.toMatchObject(
      { code: 'rate_limited' },
    );
    expect(smtp.sent).toHaveLength(1);
    expect(store.getEvent('agent', ev.id)?.sequence).toBe(0);
  });

  it('skips cancellations to attendees no longer allowed, but saves the update', async () => {
    const { ctx, store } = createTestContext();
    const ev = await createEvent(ctx, base);
    ctx.config = { ...ctx.config, allow_send_to: ['boss@test.local'] };
    const updated = await updateEvent(ctx, ev.id, { attendees: ['boss@test.local'] });
    expect(updated.sequence).toBe(1);
    expect(updated.warnings).toEqual(['cancel_not_sent:a@partner.local']);
    expect(store.getEvent('agent', ev.id)?.sequence).toBe(1);
  });
});

describe('I5: large inbox baseline', () => {
  it('baselines an inbox with 200k messages', async () => {
    const { ctx, imap, store } = createTestContext();
    const raw = Buffer.from('From: a@b.c\r\n\r\nx');
    for (let uid = 1; uid <= 200_000; uid++) imap.messages.push({ uid, raw, seen: true });
    await new InboundWatcher(ctx).processNew();
    expect(store.getWatcherState('agent')?.lastUid).toBe(200_000);
  });
});
