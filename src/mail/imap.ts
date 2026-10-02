import { ImapFlow } from 'imapflow';
import type { MailboxConfig } from '../config/schema.js';
import { GatewayError } from '../errors.js';

export type ConnectionState = 'connected' | 'reconnecting' | 'error' | 'stopped';

export interface FetchedMessage {
  uid: number;
  raw: Buffer;
  seen: boolean;
}

export interface SearchQuery {
  unread?: boolean;
  since?: Date;
  uidAbove?: number;
}

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface ImapMailbox {
  start(): Promise<void>;
  stop(): Promise<void>;
  state(): ConnectionState;
  uidValidity(): Promise<string>;
  search(q: SearchQuery): Promise<number[]>;
  fetch(uids: number[]): Promise<FetchedMessage[]>;
  setSeen(uid: number, seen: boolean): Promise<void>;
  moveToTrash(uid: number): Promise<void>;
  appendToSent(raw: Buffer): Promise<void>;
  onNewMail(listener: () => void): void;
}

const MAX_BACKOFF_MS = 60_000;

export class ImapFlowMailbox implements ImapMailbox {
  private client: ImapFlow | null = null;
  private status: ConnectionState = 'stopped';
  private readonly listeners: (() => void)[] = [];
  private backoffMs = 1000;
  private timer: NodeJS.Timeout | null = null;
  private folders: { sent: string; trash: string | null } | null = null;

  constructor(
    private readonly cfg: MailboxConfig,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    this.status = 'reconnecting';
    await this.connect();
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
    if (this.timer) clearTimeout(this.timer);
    const c = this.client;
    this.client = null;
    if (c) await c.logout().catch(() => c.close());
  }

  state(): ConnectionState {
    return this.status;
  }

  onNewMail(listener: () => void): void {
    this.listeners.push(listener);
  }

  private async connect(): Promise<void> {
    const security = this.cfg.imap.security;
    const client = new ImapFlow({
      host: this.cfg.imap.host,
      port: this.cfg.imap.port,
      secure: security === 'tls',
      doSTARTTLS: security === 'starttls' ? true : security === 'none' ? false : undefined,
      auth: { user: this.cfg.username, pass: this.cfg.password },
      logger: false,
      connectionTimeout: 15_000,
    });
    client.on('exists', () => {
      for (const l of this.listeners) l();
    });
    client.on('error', (err: Error) => {
      this.log.warn({ mailbox: this.cfg.name, err: err.message }, 'imap error');
    });
    client.on('close', () => {
      if (this.client === client) this.scheduleReconnect('reconnecting');
    });
    try {
      await client.connect();
      await client.mailboxOpen('INBOX');
      if (this.status === 'stopped') {
        await client.logout().catch(() => client.close());
        return;
      }
      this.client = client;
      this.status = 'connected';
      this.backoffMs = 1000;
      this.log.info({ mailbox: this.cfg.name }, 'imap connected');
      for (const l of this.listeners) l();
    } catch (err) {
      this.log.error(
        { mailbox: this.cfg.name, err: (err as Error).message },
        'imap connect failed',
      );
      client.close();
      this.scheduleReconnect('error');
    }
  }

  private scheduleReconnect(state: ConnectionState): void {
    if (this.status === 'stopped') return;
    this.client = null;
    this.status = state;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), delay);
    this.timer.unref();
  }

  private require(): ImapFlow {
    if (!this.client || this.status !== 'connected') {
      throw new GatewayError('mailbox_unavailable', 'The mail server is currently not reachable', {
        state: this.status,
      });
    }
    return this.client;
  }

  private async withInbox<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const c = this.require();
    const lock = await c.getMailboxLock('INBOX');
    try {
      return await fn(c);
    } finally {
      lock.release();
    }
  }

  async uidValidity(): Promise<string> {
    return this.withInbox(async (c) => {
      if (!c.mailbox) throw new GatewayError('mailbox_unavailable', 'INBOX not selected');
      return String(c.mailbox.uidValidity);
    });
  }

  async search(q: SearchQuery): Promise<number[]> {
    return this.withInbox(async (c) => {
      const query: Record<string, unknown> = {};
      if (q.unread) query.seen = false;
      if (q.since) query.since = q.since;
      if (q.uidAbove !== undefined) query.uid = `${q.uidAbove + 1}:*`;
      if (Object.keys(query).length === 0) query.all = true;
      const result = await c.search(query, { uid: true });
      const uids = (result || []).filter((u) => q.uidAbove === undefined || u > q.uidAbove);
      return uids.sort((a, b) => a - b);
    });
  }

  async fetch(uids: number[]): Promise<FetchedMessage[]> {
    if (uids.length === 0) return [];
    return this.withInbox(async (c) => {
      const out: FetchedMessage[] = [];
      for await (const m of c.fetch(
        uids.join(','),
        { uid: true, flags: true, source: true },
        { uid: true },
      )) {
        if (m.source)
          out.push({ uid: m.uid, raw: m.source, seen: m.flags?.has('\\Seen') ?? false });
      }
      return out.sort((a, b) => a.uid - b.uid);
    });
  }

  async setSeen(uid: number, seen: boolean): Promise<void> {
    await this.withInbox(async (c) => {
      if (seen) await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      else await c.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
    });
  }

  private async resolveFolders(c: ImapFlow): Promise<{ sent: string; trash: string | null }> {
    if (this.folders) return this.folders;
    const list = await c.list();
    const bySpecial = (use: string) => list.find((f) => f.specialUse === use)?.path;
    const byName = (name: string | undefined) =>
      name ? list.find((f) => f.path.toLowerCase() === name.toLowerCase())?.path : undefined;

    let sent = byName(this.cfg.folders.sent) ?? bySpecial('\\Sent') ?? byName('Sent');
    if (!sent) {
      sent = this.cfg.folders.sent ?? 'Sent';
      await c.mailboxCreate(sent);
    }
    const trash = byName(this.cfg.folders.trash) ?? bySpecial('\\Trash') ?? byName('Trash') ?? null;
    this.folders = { sent, trash };
    return this.folders;
  }

  async moveToTrash(uid: number): Promise<void> {
    const c = this.require();
    const { trash } = await this.resolveFolders(c);
    await this.withInbox(async (inbox) => {
      if (trash) await inbox.messageMove(String(uid), trash, { uid: true });
      else await inbox.messageDelete(String(uid), { uid: true });
    });
  }

  async appendToSent(raw: Buffer): Promise<void> {
    const c = this.require();
    const { sent } = await this.resolveFolders(c);
    await c.append(sent, raw, ['\\Seen']);
  }
}
