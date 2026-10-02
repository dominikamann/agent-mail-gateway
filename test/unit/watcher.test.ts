import { describe, expect, it } from 'vitest';
import { InboundWatcher } from '../../src/watcher/watcher.js';
import { createTestContext } from '../helpers/fakes.js';
import { buildRaw } from '../helpers/mail.js';

const hook = { webhook: { url: 'https://hooks.test/mail', secret: 's'.repeat(16) } };

describe('InboundWatcher', () => {
  it('baselines on first run without actions or webhooks', async () => {
    const { ctx, imap, store } = createTestContext(hook);
    imap.add(await buildRaw({ from: 'stranger@evil.local' }));
    imap.add(await buildRaw({ from: 'boss@test.local' }));
    await new InboundWatcher(ctx).processNew();
    expect(imap.messages).toHaveLength(2);
    expect(store.dueWebhooks(Date.now())).toHaveLength(0);
    expect(store.getWatcherState('agent')).toEqual({ uidValidity: '1', lastUid: 2 });
  });

  it('deletes non-allowed mail, enqueues webhooks for allowed mail, exactly once', async () => {
    const { ctx, imap, store } = createTestContext(hook);
    const w = new InboundWatcher(ctx);
    await w.processNew();
    const blocked = imap.add(await buildRaw({ from: 'stranger@evil.local' }));
    const allowed = imap.add(
      await buildRaw({ from: 'boss@test.local', subject: 'Report', text: 'Body' }),
    );
    await Promise.all([w.processNew(), w.processNew()]);
    await w.processNew();

    expect(imap.messages.map((m) => m.uid)).toEqual([allowed]);
    expect(imap.trash).toHaveLength(1);
    const jobs = store.dueWebhooks(Date.now());
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0]!.payload)).toEqual({
      event: 'message.received',
      event_type: 'message.received',
      mailbox: 'agent',
      message: {
        id: `1-${allowed}`,
        from: 'boss@test.local',
        subject: 'Report',
        date: expect.any(String),
        preview: 'Body',
      },
    });
    expect(store.listAudit('agent')).toMatchObject([
      {
        action: 'filtered_delete',
        counterparts: ['stranger@evil.local'],
        detail: 'sender_not_allowed',
      },
    ]);
    expect(blocked).toBeLessThan(allowed);
  });

  it('keeps non-allowed mail when configured and never crashes on a missing From', async () => {
    const { ctx, imap, store } = createTestContext({ non_allowed_action: 'keep' });
    const w = new InboundWatcher(ctx);
    await w.processNew();
    imap.add(Buffer.from('Subject: no from\r\n\r\nbody\r\n'));
    await w.processNew();
    expect(imap.messages).toHaveLength(1);
    expect(store.listAudit('agent')).toMatchObject([{ action: 'filtered_keep', counterparts: [] }]);
  });

  it('rebaselines when UIDVALIDITY changes', async () => {
    const { ctx, imap, store } = createTestContext(hook);
    const w = new InboundWatcher(ctx);
    await w.processNew();
    imap.validity = '2';
    imap.add(await buildRaw({ from: 'boss@test.local' }));
    await w.processNew();
    expect(store.dueWebhooks(Date.now())).toHaveLength(0);
    expect(store.getWatcherState('agent')?.uidValidity).toBe('2');
  });

  it('skips silently while the mailbox is disconnected', async () => {
    const { ctx, imap } = createTestContext();
    imap.connection = 'reconnecting';
    await expect(new InboundWatcher(ctx).processNew()).resolves.toBeUndefined();
  });
});
