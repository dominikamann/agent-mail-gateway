import { describe, expect, it } from 'vitest';
import { createEvent, getEvent, updateEvent } from '../../src/services/events.js';
import { eventPatchSchema, sendMessageSchema } from '../../src/services/schemas.js';
import { sendMessage } from '../../src/services/send.js';
import { Store } from '../../src/store/store.js';
import { WebhookDispatcher } from '../../src/webhook/dispatcher.js';
import { testMailboxConfig } from '../helpers/config.js';
import { createTestContext } from '../helpers/fakes.js';
import { silentLogger } from '../helpers/wait.js';

const mail = () =>
  sendMessageSchema.parse({
    to: ['boss@test.local'],
    subject: 'Report',
    body_markdown: 'Hello, here is the report.',
  });

describe('duplicate check', () => {
  it('catches the same message sent twice at the same time', async () => {
    const { ctx, smtp } = createTestContext();
    const results = await Promise.allSettled([sendMessage(ctx, mail()), sendMessage(ctx, mail())]);
    expect(smtp.sent).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { details: { reasons: [{ rule: 'duplicate' }] } },
    });
  });

  it('allows the message again when the first send failed', async () => {
    const { ctx, smtp } = createTestContext();
    const send = smtp.send.bind(smtp);
    smtp.send = async () => {
      throw new Error('550 rejected');
    };
    await expect(sendMessage(ctx, mail())).rejects.toBeTruthy();
    smtp.send = send;
    await sendMessage(ctx, mail());
    expect(smtp.sent).toHaveLength(1);
  });
});

describe('events', () => {
  const create = (ctx: Parameters<typeof createEvent>[0]) =>
    createEvent(ctx, {
      title: 'T',
      start: '2026-10-10T12:00:00Z',
      end: '2026-10-10T13:00:00Z',
      location: 'Room 1',
      description_markdown: 'Agenda',
      attendees: ['boss@test.local'],
    });

  it('parallel updates get distinct versions', async () => {
    const { ctx, smtp } = createTestContext();
    const ev = await create(ctx);
    await Promise.all([
      updateEvent(ctx, ev.id, { title: 'A' }),
      updateEvent(ctx, ev.id, { location: 'Room 2' }),
    ]);
    const seqs = smtp.sent.slice(1).map((s) => /SEQUENCE:(\d+)/.exec(s.raw.toString())?.[1]);
    expect(seqs).toEqual(['1', '2']);
    const final = getEvent(ctx, ev.id);
    expect(final).toMatchObject({ sequence: 2, title: 'A', location: 'Room 2' });
  });

  it('fields can be cleared with null', async () => {
    const { ctx } = createTestContext();
    const ev = await create(ctx);
    const patch = eventPatchSchema.parse({ location: null, description_markdown: null });
    const updated = await updateEvent(ctx, ev.id, patch);
    expect(updated).toMatchObject({ location: null, description_markdown: null });
  });
});

describe('webhooks', () => {
  it('a slow endpoint does not hold up other mailboxes', async () => {
    const store = new Store(':memory:');
    const secret = 's'.repeat(16);
    const slow = testMailboxConfig({
      name: 'slow',
      webhook: { url: 'https://slow.test/h', secret },
    });
    const fast = testMailboxConfig({
      name: 'fast',
      address: 'fast@test.local',
      webhook: { url: 'https://fast.test/h', secret },
    });
    let release: () => void = () => {};
    const fetchFn = (async (url: string) => {
      if (url.startsWith('https://slow')) await new Promise<void>((r) => (release = r));
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const d = new WebhookDispatcher({
      store,
      mailboxes: new Map([
        ['slow', slow],
        ['fast', fast],
      ]),
      log: silentLogger,
      fetchFn,
      now: () => 1_000_000,
    });
    store.enqueueWebhook('slow', '1-1', '{}', 1_000_000);
    store.enqueueWebhook('fast', '1-2', '{}', 1_000_000);
    const run = d.runOnce();
    await new Promise((r) => setTimeout(r, 20));
    expect(store.dueWebhooks(1_000_000).map((j) => j.mailbox)).toEqual(['slow']);
    release();
    await run;
    expect(store.dueWebhooks(1_000_000)).toHaveLength(0);
  });

  function two(fetchFn: typeof fetch) {
    const store = new Store(':memory:');
    const secret = 's'.repeat(16);
    const a = testMailboxConfig({ name: 'a', webhook: { url: 'https://a.test/h', secret } });
    const b = testMailboxConfig({
      name: 'b',
      address: 'b@test.local',
      webhook: { url: 'https://b.test/h', secret },
    });
    const d = new WebhookDispatcher({
      store,
      mailboxes: new Map([
        ['a', a],
        ['b', b],
      ]),
      log: silentLogger,
      fetchFn,
      now: () => 1_000_000,
    });
    return { store, d };
  }

  it('a failing mailbox with a backlog does not hold up the others', async () => {
    const calls: string[] = [];
    const { store, d } = two((async (url: string) => {
      calls.push(url);
      return new Response(null, { status: url.startsWith('https://a') ? 500 : 200 });
    }) as unknown as typeof fetch);
    for (let i = 0; i < 40; i++) store.enqueueWebhook('a', `1-${i}`, '{}', 1_000_000);
    store.enqueueWebhook('b', '1-99', '{}', 1_000_000);
    await d.runOnce();
    expect(calls).toContain('https://b.test/h');
  });

  it('new mail for one mailbox is delivered while another is still busy', async () => {
    let release: () => void = () => {};
    const { store, d } = two((async (url: string) => {
      if (url.startsWith('https://a')) await new Promise<void>((r) => (release = r));
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch);
    store.enqueueWebhook('a', '1-1', '{}', 1_000_000);
    const first = d.runOnce();
    await new Promise((r) => setTimeout(r, 10));
    store.enqueueWebhook('b', '1-2', '{}', 1_000_000);
    await d.runOnce().catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(store.dueWebhooks(1_000_000).map((j) => j.mailbox)).toEqual(['a']);
    release();
    await first;
    await d.stop();
    expect(store.dueWebhooks(1_000_000)).toHaveLength(0);
  });
});

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
};

describe('review follow-ups', () => {
  it('a message being sent right now is named as such', async () => {
    const { ctx } = createTestContext();
    const results = await Promise.allSettled([sendMessage(ctx, mail()), sendMessage(ctx, mail())]);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.details.reasons[0].message).toMatch(/being sent right now/);
  });

  it('in warn mode a failed first send does not hide later duplicates', async () => {
    const { ctx, smtp } = createTestContext({ review: { rules: 'warn' } } as never);
    let fail: (() => void) | null = null;
    const send = smtp.send.bind(smtp);
    let n = 0;
    smtp.send = async (e, r) => {
      n++;
      if (n === 1) {
        await new Promise<void>((r) => (fail = r));
        throw new Error('550 rejected');
      }
      return send(e, r);
    };
    const first = sendMessage(ctx, mail()).catch(() => null);
    await until(() => fail !== null);
    let releaseSecond: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseSecond = r));
    smtp.send = async (e, r) => {
      secondWaiting = true;
      await gate;
      return send(e, r);
    };
    let secondWaiting = false;
    const second = sendMessage(ctx, mail());
    await until(() => secondWaiting);
    fail!();
    await first;
    const third = sendMessage(ctx, mail());
    releaseSecond();
    await second;
    expect((await third).warnings.join(' ')).toMatch(/duplicate/);
  });

  it('an answer that arrives during an update is kept', async () => {
    const { recordResponse } = await import('../../src/services/events.js');
    const { ctx, smtp } = createTestContext();
    const ev = await createEvent(ctx, {
      title: 'T',
      start: '2026-10-10T12:00:00Z',
      end: '2026-10-10T13:00:00Z',
      attendees: ['boss@test.local'],
    });
    const send = smtp.send.bind(smtp);
    let release: (() => void) | null = null;
    smtp.send = async (e, r) => {
      await new Promise<void>((ok) => (release = ok));
      return send(e, r);
    };
    const update = updateEvent(ctx, ev.id, { title: 'T2' });
    await until(() => release !== null);
    recordResponse(ctx, { uid: `${ev.id}@test.local`, sequence: 0, from: 'boss@test.local' }, [
      { email: 'boss@test.local', status: 'ACCEPTED' },
    ]);
    release!();
    await update;
    expect(getEvent(ctx, ev.id).responses).toEqual({ 'boss@test.local': 'accepted' });
  });
});
