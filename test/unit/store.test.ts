import { beforeEach, describe, expect, it } from 'vitest';
import { type EventRecord, Store } from '../../src/store/store.js';

let store: Store;
beforeEach(() => {
  store = new Store(':memory:');
});

describe('Store', () => {
  it('persists watcher state', () => {
    expect(store.getWatcherState('ole')).toBeNull();
    store.setWatcherState('ole', '7', 42);
    store.setWatcherState('ole', '7', 43);
    expect(store.getWatcherState('ole')).toEqual({ uidValidity: '7', lastUid: 43 });
  });

  it('enqueues each webhook only once and schedules retries', () => {
    expect(store.enqueueWebhook('ole', '7-1', '{}', 1000)).toBe(true);
    expect(store.enqueueWebhook('ole', '7-1', '{}', 1000)).toBe(false);
    const [job] = store.dueWebhooks(1000);
    expect(job).toMatchObject({ mailbox: 'ole', messageId: '7-1', attempts: 0 });
    store.rescheduleWebhook(job!.id, 1, 5000);
    expect(store.dueWebhooks(4999)).toHaveLength(0);
    expect(store.dueWebhooks(5000)).toHaveLength(1);
    store.markWebhookDelivered(job!.id);
    expect(store.dueWebhooks(10_000)).toHaveLength(0);
    expect(store.webhookStatus('ole', '7-1')).toEqual({ status: 'delivered', attempts: 2 });
  });

  it('counts sends in a window', () => {
    store.recordSend('ole', 100);
    store.recordSend('ole', 200);
    store.recordSend('other', 150);
    expect(store.sendsSince('ole', 150)).toEqual([200]);
  });

  it('saves, updates and lists events per mailbox', () => {
    const rec: EventRecord = {
      id: 'e1',
      mailbox: 'ole',
      uid: 'e1@x',
      sequence: 0,
      status: 'active',
      title: 'T',
      start: '2026-10-05T12:00:00.000Z',
      end: '2026-10-05T13:00:00.000Z',
      timezone: 'UTC',
      location: null,
      description: null,
      attendees: ['a@b.de'],
      createdAt: 1,
      updatedAt: 1,
    };
    store.saveEvent(rec);
    store.saveEvent({ ...rec, sequence: 1, updatedAt: 2 });
    expect(store.getEvent('ole', 'e1')?.sequence).toBe(1);
    expect(store.getEvent('other', 'e1')).toBeNull();
    expect(store.listEvents('ole')).toHaveLength(1);
  });

  it('writes audit entries', () => {
    store.audit({ at: 1, mailbox: 'ole', action: 'send', counterparts: ['a@b.de'], result: 'ok' });
    expect(store.listAudit('ole')).toEqual([
      {
        at: 1,
        mailbox: 'ole',
        action: 'send',
        counterparts: ['a@b.de'],
        result: 'ok',
        detail: undefined,
      },
    ]);
  });
});
