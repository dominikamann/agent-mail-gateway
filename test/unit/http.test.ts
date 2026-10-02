import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { MailboxConfigInput } from '../../src/config/schema.js';
import { buildApp } from '../../src/http/app.js';
import { Gateway } from '../../src/services/gateway.js';
import { createTestContext } from '../helpers/fakes.js';
import { buildRaw } from '../helpers/mail.js';

const KEY = 'k'.repeat(32);
const auth = { authorization: `Bearer ${KEY}` };
let app: FastifyInstance;

async function setup(overrides: Partial<MailboxConfigInput> = {}) {
  const t = createTestContext(overrides);
  const other = createTestContext({
    name: 'other',
    address: 'other@test.local',
    api_key: 'o'.repeat(32),
  });
  app = await buildApp(new Gateway([t.ctx, other.ctx]));
  return { ...t, other };
}

afterEach(async () => {
  await app?.close();
});

describe('auth and health', () => {
  it('requires a valid bearer key', async () => {
    await setup();
    expect((await app.inject({ url: '/v1/mailbox' })).statusCode).toBe(401);
    const bad = await app.inject({ url: '/v1/mailbox', headers: { authorization: 'Bearer nope' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({
      error: 'unauthorized',
      message: 'Missing or invalid API key',
      details: {},
    });
    const ok = await app.inject({ url: '/v1/mailbox', headers: auth });
    expect(ok.json()).toMatchObject({ address: 'agent@test.local' });
  });

  it('serves health and docs without auth', async () => {
    const { imap } = await setup();
    imap.connection = 'reconnecting';
    const res = await app.inject({ url: '/health' });
    expect(res.json()).toEqual({
      status: 'degraded',
      mailboxes: [
        { name: 'agent', state: 'reconnecting' },
        { name: 'other', state: 'connected' },
      ],
    });
    expect((await app.inject({ url: '/docs/json' })).json().paths).toHaveProperty('/v1/messages');
  });
});

describe('messages routes', () => {
  it('lists, reads, downloads attachments, marks', async () => {
    const { imap } = await setup();
    const uid = imap.add(
      await buildRaw({
        from: 'boss@test.local',
        subject: 'S',
        html: '<p>B</p>',
        attachments: [{ filename: 'r.pdf', content: 'PDF', contentType: 'application/pdf' }],
      }),
    );
    imap.add(await buildRaw({ from: 'stranger@evil.local' }));
    const list = await app.inject({ url: '/v1/messages?unread=true&limit=5', headers: auth });
    expect(list.json().messages.map((m: { id: string }) => m.id)).toEqual([`1-${uid}`]);
    const msg = await app.inject({ url: `/v1/messages/1-${uid}?mark_read=false`, headers: auth });
    expect(msg.json()).toMatchObject({ body_markdown: 'B', unread: true });
    const att = await app.inject({ url: `/v1/messages/1-${uid}/attachments/0`, headers: auth });
    expect(att.headers['content-type']).toBe('application/pdf');
    expect(att.headers['content-disposition']).toContain("filename*=UTF-8''r.pdf");
    expect(att.body).toBe('PDF');
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/messages/1-${uid}`,
      headers: auth,
      payload: { unread: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(imap.messages[0]?.seen).toBe(true);
  });

  it("cannot read another mailbox's messages with its own key", async () => {
    const { other } = await setup();
    const uid = other.imap.add(await buildRaw({ from: 'boss@test.local', to: 'other@test.local' }));
    const res = await app.inject({ url: `/v1/messages/1-${uid}`, headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it('sends and maps policy errors', async () => {
    const { smtp } = await setup();
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: auth,
      payload: { to: ['boss@test.local'], subject: 'Hi', body_markdown: 'x' },
    });
    expect(ok.statusCode).toBe(200);
    expect(smtp.sent).toHaveLength(1);
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: auth,
      payload: { to: ['x@evil.local'], subject: 'Hi', body_markdown: 'x' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      error: 'recipient_not_allowed',
      details: { addresses: ['x@evil.local'] },
    });
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: auth,
      payload: { to: 'nope' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe('validation_error');
  });

  it('returns 413 for oversized bodies and 429 with Retry-After', async () => {
    await setup({ max_attachment_mb: 0.01, max_sends_per_hour: 1 });
    const huge = Buffer.alloc(3 * 1024 * 1024).toString('base64');
    const big = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: auth,
      payload: {
        to: ['boss@test.local'],
        subject: 'x',
        body_markdown: 'x',
        attachments: [{ filename: 'f', content_base64: huge }],
      },
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toBe('attachment_too_large');
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: auth,
        payload: { to: ['boss@test.local'], subject: 'x', body_markdown: 'x' },
      });
    expect((await send()).statusCode).toBe(200);
    const limited = await send();
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('returns 503 when the mailbox is down and 403 for disabled delete', async () => {
    const { imap } = await setup();
    const del = await app.inject({ method: 'DELETE', url: '/v1/messages/1-1', headers: auth });
    expect(del.json().error).toBe('delete_not_allowed');
    imap.connection = 'error';
    const res = await app.inject({ url: '/v1/messages', headers: auth });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('mailbox_unavailable');
  });
});

describe('events routes', () => {
  it('creates, updates, lists and cancels', async () => {
    await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: auth,
      payload: {
        title: 'T',
        start: '2026-10-05T14:00:00Z',
        end: '2026-10-05T15:00:00Z',
        attendees: ['boss@test.local'],
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const updated = await app.inject({
      method: 'PATCH',
      url: `/v1/events/${id}`,
      headers: auth,
      payload: { title: 'T2' },
    });
    expect(updated.json()).toMatchObject({ title: 'T2', sequence: 1 });
    expect((await app.inject({ url: '/v1/events', headers: auth })).json().events).toHaveLength(1);
    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/v1/events/${id}`,
      headers: auth,
    });
    expect(cancelled.json().status).toBe('cancelled');
  });
});
