import type { MailboxConfigInput } from '../../src/config/schema.js';
import { GatewayError } from '../../src/errors.js';
import type {
  ConnectionState,
  FetchedMessage,
  ImapMailbox,
  MessageMeta,
  SearchQuery,
} from '../../src/mail/imap.js';
import { headerBlock } from '../../src/mail/parse.js';
import type { SmtpSender } from '../../src/mail/smtp.js';
import type { MailboxContext } from '../../src/services/context.js';
import { Store } from '../../src/store/store.js';
import { testMailboxConfig } from './config.js';
import { silentLogger } from './wait.js';

export const TEST_NOW = Date.parse('2026-10-01T00:00:00Z');

export class FakeImap implements ImapMailbox {
  validity = '1';
  connection: ConnectionState = 'connected';
  failAppend = false;
  messages: { uid: number; raw: Buffer; seen: boolean; internalDate?: Date }[] = [];
  /** UIDs whose full source was downloaded, in order. */
  fullFetches: number[] = [];
  trash: Buffer[] = [];
  sent: Buffer[] = [];
  private nextUid = 1;
  private readonly listeners: (() => void)[] = [];

  async start() {}
  async stop() {}
  state() {
    return this.connection;
  }
  onNewMail(listener: () => void) {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
  add(raw: Buffer, seen = false, internalDate = new Date()): number {
    const uid = this.nextUid++;
    this.messages.push({ uid, raw, seen, internalDate });
    for (const l of this.listeners) l();
    return uid;
  }
  private ensure() {
    if (this.connection !== 'connected') {
      throw new GatewayError('mailbox_unavailable', 'not connected');
    }
  }
  async uidValidity() {
    this.ensure();
    return this.validity;
  }
  async search(q: SearchQuery) {
    this.ensure();
    return this.messages
      .filter((m) => (!q.unread || !m.seen) && (q.uidAbove === undefined || m.uid > q.uidAbove))
      .filter((m) => {
        const text = m.raw.toString('utf8').toLowerCase();
        const header = (name: string) =>
          new RegExp(`^${name}:.*$`, 'im')
            .exec(headerBlock(m.raw).toString('utf8'))?.[0]
            .toLowerCase() ?? '';
        return (
          (!q.text || text.includes(q.text.toLowerCase())) &&
          (!q.from || header('from').includes(q.from.toLowerCase())) &&
          (!q.subject || header('subject').includes(q.subject.toLowerCase())) &&
          (!q.before || !m.internalDate || m.internalDate < q.before)
        );
      })
      .map((m) => m.uid);
  }
  async fetchMeta(uids: number[]): Promise<MessageMeta[]> {
    this.ensure();
    return this.messages
      .filter((m) => uids.includes(m.uid))
      .map((m) => ({
        uid: m.uid,
        header: headerBlock(m.raw),
        seen: m.seen,
        size: m.raw.length,
        internalDate: m.internalDate ?? null,
        hasAttachments: /content-disposition:\s*attachment/i.test(m.raw.toString('latin1')),
        hasCalendar: /content-type:\s*(text\/calendar|application\/ics)/i.test(
          m.raw.toString('latin1'),
        ),
      }));
  }
  async fetch(uids: number[]): Promise<FetchedMessage[]> {
    this.ensure();
    this.fullFetches.push(...uids);
    return this.messages
      .filter((m) => uids.includes(m.uid))
      .map((m) => ({ uid: m.uid, raw: m.raw, seen: m.seen }));
  }
  async setSeen(uid: number, seen: boolean) {
    this.ensure();
    const m = this.messages.find((x) => x.uid === uid);
    if (m) m.seen = seen;
  }
  async moveToTrash(uid: number) {
    this.ensure();
    const i = this.messages.findIndex((x) => x.uid === uid);
    if (i >= 0) this.trash.push(this.messages.splice(i, 1)[0]!.raw);
  }
  async appendToSent(raw: Buffer) {
    if (this.failAppend) throw new Error('append failed');
    this.sent.push(raw);
  }
}

export class FakeSmtp implements SmtpSender {
  sent: { envelope: { from: string; to: string[] }; raw: Buffer }[] = [];
  fail = false;
  async send(envelope: { from: string; to: string[] }, raw: Buffer) {
    if (this.fail) throw new Error('smtp down');
    this.sent.push({ envelope, raw });
  }
  close() {}
}

export function createTestContext(
  overrides: Partial<MailboxConfigInput> = {},
  opts: { now?: () => number } = {},
) {
  const imap = new FakeImap();
  const smtp = new FakeSmtp();
  const store = new Store(':memory:');
  const ctx: MailboxContext = {
    config: testMailboxConfig(overrides),
    imap,
    smtp,
    store,
    log: silentLogger,
    // Fixed clock: tests use fixed event dates in October 2026 and must not start failing once
    // those dates are in the past.
    now: opts.now ?? (() => TEST_NOW),
  };
  return { ctx, imap, smtp, store };
}
