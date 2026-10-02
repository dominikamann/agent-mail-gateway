import type { MailboxConfigInput } from '../../src/config/schema.js';
import { GatewayError } from '../../src/errors.js';
import type {
  ConnectionState,
  FetchedMessage,
  ImapMailbox,
  SearchQuery,
} from '../../src/mail/imap.js';
import type { SmtpSender } from '../../src/mail/smtp.js';
import type { MailboxContext } from '../../src/services/context.js';
import { Store } from '../../src/store/store.js';
import { testMailboxConfig } from './config.js';
import { silentLogger } from './wait.js';

export class FakeImap implements ImapMailbox {
  validity = '1';
  connection: ConnectionState = 'connected';
  failAppend = false;
  messages: { uid: number; raw: Buffer; seen: boolean }[] = [];
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
  add(raw: Buffer, seen = false): number {
    const uid = this.nextUid++;
    this.messages.push({ uid, raw, seen });
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
      .map((m) => m.uid);
  }
  async fetch(uids: number[]): Promise<FetchedMessage[]> {
    this.ensure();
    return this.messages.filter((m) => uids.includes(m.uid)).map((m) => ({ ...m }));
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
    now: opts.now ?? (() => Date.now()),
  };
  return { ctx, imap, smtp, store };
}
