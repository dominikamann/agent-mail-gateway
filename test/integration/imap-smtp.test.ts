import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImapFlowMailbox } from '../../src/mail/imap.js';
import { composeMail, createSmtpSender } from '../../src/mail/smtp.js';
import { buildRaw } from '../helpers/mail.js';
import { silentLogger, waitFor } from '../helpers/wait.js';
import { type GreenMail, startGreenMail } from './greenmail.js';

let gm: GreenMail;
let mailbox: ImapFlowMailbox;

beforeAll(async () => {
  gm = await startGreenMail();
  const admin = await gm.client('agent@test.local');
  await admin.mailboxCreate('Trash').catch(() => {});
  await admin.logout();
  mailbox = new ImapFlowMailbox(gm.mailboxConfig('agent@test.local'), silentLogger);
  await mailbox.start();
});

afterAll(async () => {
  await mailbox?.stop();
  await gm?.stop();
});

describe('ImapFlowMailbox against GreenMail', () => {
  it('connects and reports uid validity', async () => {
    expect(mailbox.state()).toBe('connected');
    expect(await mailbox.uidValidity()).toMatch(/^\d+$/);
  });

  it('notifies on new mail, searches, fetches without marking seen, flags, trashes', async () => {
    let notified = 0;
    mailbox.onNewMail(() => notified++);
    await gm.deliver(
      'boss@test.local',
      'agent@test.local',
      await buildRaw({ from: 'boss@test.local', subject: 'One' }),
    );
    const uids = await waitFor(async () => {
      const u = await mailbox.search({ unread: true });
      return u.length > 0 ? u : null;
    });
    const [msg] = await mailbox.fetch(uids);
    expect(msg?.raw.toString()).toContain('Subject: One');
    expect(msg?.seen).toBe(false);
    expect(await mailbox.search({ unread: true })).toEqual(uids);

    await mailbox.setSeen(uids[0]!, true);
    expect(await mailbox.search({ unread: true })).toEqual([]);
    expect(await mailbox.search({ uidAbove: uids[0]! })).toEqual([]);

    await mailbox.moveToTrash(uids[0]!);
    expect(await mailbox.search({})).toEqual([]);
    expect(await gm.count('agent@test.local', 'Trash')).toBe(1);
    await waitFor(() => notified > 0, 20_000);
  });

  it('sends via smtp and appends a copy to Sent (creating the folder)', async () => {
    const sender = createSmtpSender(gm.mailboxConfig('agent@test.local'));
    const { raw } = await composeMail({
      from: 'agent@test.local',
      to: ['boss@test.local'],
      cc: [],
      bcc: [],
      subject: 'Out',
      html: '<p>x</p>',
      text: 'x',
      attachments: [],
    });
    await sender.send({ from: 'agent@test.local', to: ['boss@test.local'] }, raw);
    sender.close();
    await mailbox.appendToSent(raw);

    expect(await waitFor(() => gm.count('boss@test.local', 'INBOX'))).toBe(1);
    expect(await gm.count('agent@test.local', 'Sent')).toBe(1);
  });

  it('does not throw on start when the server is unreachable', async () => {
    const broken = new ImapFlowMailbox(
      gm.mailboxConfig('agent@test.local', {
        imap: { host: '127.0.0.1', port: 1, security: 'none' },
      }),
      silentLogger,
    );
    await broken.start();
    expect(broken.state()).toBe('error');
    await expect(broken.uidValidity()).rejects.toMatchObject({ code: 'mailbox_unavailable' });
    await broken.stop();
  });
});
