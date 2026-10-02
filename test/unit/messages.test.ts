import { describe, expect, it } from 'vitest';
import type { MailboxConfigInput } from '../../src/config/schema.js';
import {
  deleteMessage,
  getAttachment,
  getMessage,
  listMessages,
  mailboxInfo,
  markMessage,
} from '../../src/services/messages.js';
import { createTestContext } from '../helpers/fakes.js';
import { buildRaw } from '../helpers/mail.js';

async function seeded(overrides: Partial<MailboxConfigInput> = {}) {
  const t = createTestContext(overrides);
  const allowed = t.imap.add(
    await buildRaw({
      from: 'Boss <Boss@Test.local>',
      subject: 'Allowed',
      html: '<p>Hi <b>there</b></p>',
      attachments: [{ filename: 'a.txt', content: 'abc', contentType: 'text/plain' }],
    }),
  );
  const blocked = t.imap.add(await buildRaw({ from: 'stranger@evil.local', subject: 'Blocked' }));
  const partner = t.imap.add(await buildRaw({ from: 'x@partner.local', subject: 'Partner' }), true);
  return { ...t, allowed, blocked, partner };
}

describe('mailboxInfo', () => {
  it('exposes address, lists and limits but no secrets', () => {
    const { ctx } = createTestContext();
    const info = mailboxInfo(ctx);
    expect(info).toMatchObject({
      address: 'agent@test.local',
      allow_send_to: ['boss@test.local', '*@partner.local'],
    });
    expect(JSON.stringify(info)).not.toContain('secret');
    expect(JSON.stringify(info)).not.toContain('k'.repeat(32));
  });
});

describe('listMessages', () => {
  it('lists only allowed senders, newest first', async () => {
    const { ctx } = await seeded();
    const res = await listMessages(ctx, { limit: 20 });
    expect(res.messages.map((m) => m.subject)).toEqual(['Partner', 'Allowed']);
    expect(res.messages[1]).toMatchObject({
      from: 'boss@test.local',
      from_name: 'Boss',
      unread: true,
      has_attachments: true,
      preview: 'Hi **there**',
    });
    expect(res.next_cursor).toBeNull();
  });

  it('filters unread and paginates with a cursor', async () => {
    const { ctx } = await seeded();
    expect(
      (await listMessages(ctx, { limit: 20, unread: true })).messages.map((m) => m.subject),
    ).toEqual(['Allowed']);
    const page1 = await listMessages(ctx, { limit: 1 });
    expect(page1.messages.map((m) => m.subject)).toEqual(['Partner']);
    const page2 = await listMessages(ctx, { limit: 1, cursor: page1.next_cursor! });
    expect(page2.messages.map((m) => m.subject)).toEqual(['Allowed']);
    expect(page2.next_cursor).toBeNull();
  });

  it('hides mail whose sender fails authentication when required', async () => {
    const { ctx } = await seeded({ require_sender_auth: true });
    expect((await listMessages(ctx, { limit: 20 })).messages).toEqual([]);
  });
});

describe('getMessage', () => {
  it('returns markdown and marks read by default', async () => {
    const { ctx, imap, allowed } = await seeded();
    const msg = await getMessage(ctx, `1-${allowed}`, true);
    expect(msg.body_markdown).toBe('Hi **there**');
    expect(msg.attachments).toEqual([
      { index: 0, filename: 'a.txt', content_type: 'text/plain', size: 3 },
    ]);
    expect(msg.unread).toBe(false);
    expect(imap.messages.find((m) => m.uid === allowed)?.seen).toBe(true);
  });

  it('can leave the message unread', async () => {
    const { ctx, imap, allowed } = await seeded();
    await getMessage(ctx, `1-${allowed}`, false);
    expect(imap.messages.find((m) => m.uid === allowed)?.seen).toBe(false);
  });

  it('treats blocked, unknown, stale-validity and malformed ids as not found', async () => {
    const { ctx, blocked } = await seeded();
    for (const id of [`1-${blocked}`, '1-999', '2-1', 'abc']) {
      await expect(getMessage(ctx, id, true)).rejects.toMatchObject({ code: 'not_found' });
    }
  });
});

describe('attachments, flags, delete', () => {
  it('returns attachment bytes', async () => {
    const { ctx, allowed } = await seeded();
    const a = await getAttachment(ctx, `1-${allowed}`, 0);
    expect(a).toMatchObject({ filename: 'a.txt', contentType: 'text/plain' });
    expect(a.content.toString()).toBe('abc');
    await expect(getAttachment(ctx, `1-${allowed}`, 5)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('marks unread', async () => {
    const { ctx, imap, partner } = await seeded();
    await markMessage(ctx, `1-${partner}`, true);
    expect(imap.messages.find((m) => m.uid === partner)?.seen).toBe(false);
  });

  it('refuses delete unless allowed, then moves to trash and audits', async () => {
    const denied = await seeded();
    await expect(deleteMessage(denied.ctx, `1-${denied.allowed}`)).rejects.toMatchObject({
      code: 'delete_not_allowed',
    });

    const { ctx, imap, store, allowed, blocked } = await seeded({ allow_delete: true });
    await expect(deleteMessage(ctx, `1-${blocked}`)).rejects.toMatchObject({ code: 'not_found' });
    await deleteMessage(ctx, `1-${allowed}`);
    expect(imap.trash).toHaveLength(1);
    expect(store.listAudit('agent').map((a) => a.action)).toEqual(['delete']);
  });

  it('propagates mailbox_unavailable', async () => {
    const { ctx, imap } = await seeded();
    imap.connection = 'reconnecting';
    await expect(listMessages(ctx, { limit: 5 })).rejects.toMatchObject({
      code: 'mailbox_unavailable',
    });
  });
});
