import { ImapFlow } from 'imapflow';
import type { MailboxConfig } from '../config/schema.js';
import { GatewayError } from '../errors.js';

export type ConnectionState = 'connected' | 'reconnecting' | 'error' | 'stopped';

export interface FetchedMessage {
  uid: number;
  raw: Buffer;
  seen: boolean;
}

/** Everything needed to decide policy and build a summary, without downloading the body. */
export interface MessageMeta {
  uid: number;
  header: Buffer;
  seen: boolean;
  size: number;
  internalDate: Date | null;
  hasAttachments: boolean;
  /** Contains calendar data (an invitation or a reply to one). */
  hasCalendar: boolean;
}

export interface SearchQuery {
  unread?: boolean;
  since?: Date;
  before?: Date;
  /** Full-text search in headers and body. */
  text?: string;
  from?: string;
  subject?: string;
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
  /** Headers, flags, size, arrival time and attachment presence; no body. */
  fetchMeta(uids: number[]): Promise<MessageMeta[]>;
  fetch(uids: number[]): Promise<FetchedMessage[]>;
  setSeen(uid: number, seen: boolean): Promise<void>;
  moveToTrash(uid: number): Promise<void>;
  appendToSent(raw: Buffer): Promise<void>;
  /** Registers a listener for new mail; returns a function that removes it. */
  onNewMail(listener: () => void): () => void;
}

const MAX_BACKOFF_MS = 60_000;
/**
 * Waits after a rejected login. A wrong password never fixes itself, and fast retries make
 * servers (fail2ban) block the gateway's IP — taking every other mailbox on that server down too.
 */
export const AUTH_RETRY_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000];

export function isAuthFailure(err: unknown): boolean {
  const e = err as {
    authenticationFailed?: boolean;
    serverResponseCode?: string;
    responseText?: string;
    message?: string;
  };
  if (e?.authenticationFailed || e?.serverResponseCode === 'AUTHENTICATIONFAILED') return true;
  return /AUTHENTICATIONFAILED|authentication failed|invalid credentials|login failed/i.test(
    `${e?.responseText ?? ''} ${e?.message ?? ''}`,
  );
}

interface StructureNode {
  type?: string;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  childNodes?: StructureNode[];
}

class FolderMissingError extends Error {}

function isMissingFolder(err: unknown): boolean {
  if (err instanceof FolderMissingError) return true;
  const e = err as { serverResponseCode?: string; responseText?: string; message?: string };
  if (e.serverResponseCode === 'TRYCREATE' || e.serverResponseCode === 'NONEXISTENT') return true;
  return /\b(TRYCREATE|NONEXISTENT|no such mailbox|mailbox (does not|doesn't) exist)\b/i.test(
    `${e.responseText ?? ''} ${e.message ?? ''}`,
  );
}

function hasCalendar(node: StructureNode | undefined): boolean {
  if (!node) return false;
  const type = node.type?.toLowerCase() ?? '';
  if (type === 'text/calendar' || type === 'application/ics') return true;
  if (/\.ics$/i.test(node.dispositionParameters?.filename ?? '')) return true;
  return (node.childNodes ?? []).some(hasCalendar);
}

function hasAttachment(node: StructureNode | undefined): boolean {
  if (!node) return false;
  if (node.disposition?.toLowerCase() === 'attachment') return true;
  if (node.dispositionParameters?.filename && !node.type?.startsWith('text/')) return true;
  return (node.childNodes ?? []).some(hasAttachment);
}

export class ImapFlowMailbox implements ImapMailbox {
  private client: ImapFlow | null = null;
  private pending: ImapFlow | null = null;
  private status: ConnectionState = 'stopped';
  private readonly listeners: (() => void)[] = [];
  private backoffMs = 1000;
  private authFailures = 0;
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
    this.pending?.close();
    this.pending = null;
    const c = this.client;
    this.client = null;
    if (c) await c.logout().catch(() => c.close());
  }

  state(): ConnectionState {
    return this.status;
  }

  onNewMail(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
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
    this.pending = client;
    try {
      await client.connect();
      await client.mailboxOpen('INBOX');
      this.pending = null;
      if (this.status === 'stopped') {
        await client.logout().catch(() => client.close());
        return;
      }
      this.client = client;
      this.folders = null;
      this.status = 'connected';
      this.backoffMs = 1000;
      this.authFailures = 0;
      this.log.info({ mailbox: this.cfg.name }, 'imap connected');
      for (const l of this.listeners) l();
    } catch (err) {
      this.pending = null;
      client.close();
      if (this.status === 'stopped') return;
      if (isAuthFailure(err)) {
        const delay = AUTH_RETRY_MS[Math.min(this.authFailures, AUTH_RETRY_MS.length - 1)]!;
        this.authFailures++;
        this.log.error(
          { mailbox: this.cfg.name, retryInMinutes: delay / 60_000 },
          'imap login rejected: check username and password in the config; not retrying soon to avoid an IP ban',
        );
        this.scheduleReconnect('error', delay);
        return;
      }
      this.log.error(
        { mailbox: this.cfg.name, err: (err as Error).message },
        'imap connect failed',
      );
      this.scheduleReconnect('error');
    }
  }

  private scheduleReconnect(state: ConnectionState, fixedDelay?: number): void {
    if (this.status === 'stopped') return;
    this.client = null;
    this.status = state;
    const delay = fixedDelay ?? this.backoffMs;
    if (fixedDelay === undefined) this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
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
      // SINCE compares whole days in the server's time zone; ask for one day more and let the
      // caller filter exactly on the arrival time.
      if (q.since) query.since = new Date(q.since.getTime() - 86_400_000);
      // BEFORE is day-based too; ask for one day more and filter exactly on the arrival time.
      if (q.before) query.before = new Date(q.before.getTime() + 86_400_000);
      if (q.text) query.text = q.text;
      if (q.from) query.from = q.from;
      if (q.subject) query.subject = q.subject;
      if (q.uidAbove !== undefined) query.uid = `${q.uidAbove + 1}:*`;
      if (Object.keys(query).length === 0) query.all = true;
      const result = await c.search(query, { uid: true });
      const uids = (result || []).filter((u) => q.uidAbove === undefined || u > q.uidAbove);
      return uids.sort((a, b) => a - b);
    });
  }

  async fetchMeta(uids: number[]): Promise<MessageMeta[]> {
    if (uids.length === 0) return [];
    return this.withInbox(async (c) => {
      const out: MessageMeta[] = [];
      for await (const m of c.fetch(
        uids.join(','),
        {
          uid: true,
          flags: true,
          headers: true,
          size: true,
          internalDate: true,
          bodyStructure: true,
        },
        { uid: true },
      )) {
        out.push({
          uid: m.uid,
          header: m.headers ?? Buffer.alloc(0),
          seen: m.flags?.has('\\Seen') ?? false,
          size: m.size ?? 0,
          internalDate: m.internalDate ? new Date(m.internalDate) : null,
          hasAttachments: hasAttachment(m.bodyStructure),
          hasCalendar: hasCalendar(m.bodyStructure),
        });
      }
      return out.sort((a, b) => a.uid - b.uid);
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
      const name = this.cfg.folders.sent ?? 'Sent';
      sent = name;
      // A concurrent call may have created it already; only fail if it still does not exist.
      await c.mailboxCreate(name).catch(async (err: Error) => {
        const again = await c.list();
        if (!again.some((f) => f.path.toLowerCase() === name.toLowerCase())) throw err;
      });
    }
    const trash = byName(this.cfg.folders.trash) ?? bySpecial('\\Trash') ?? byName('Trash') ?? null;
    this.folders = { sent, trash };
    return this.folders;
  }

  /**
   * Runs `fn` with the resolved folders. Only if the folder no longer exists (renamed or deleted)
   * are folders re-detected and `fn` retried once; any other error is passed on, so a message is
   * never stored twice.
   */
  private async withFolders(
    fn: (folders: { sent: string; trash: string | null }) => Promise<unknown>,
  ): Promise<void> {
    try {
      await fn(await this.resolveFolders(this.require()));
    } catch (err) {
      if (!isMissingFolder(err)) throw err;
      this.folders = null;
      await fn(await this.resolveFolders(this.require()));
    }
  }

  async moveToTrash(uid: number): Promise<void> {
    await this.withFolders(({ trash }) =>
      this.withInbox(async (inbox) => {
        if (trash) {
          const moved = await inbox.messageMove(String(uid), trash, { uid: true });
          if (!moved) throw new FolderMissingError(`could not move message to ${trash}`);
        } else {
          await inbox.messageDelete(String(uid), { uid: true });
        }
      }),
    );
  }

  async appendToSent(raw: Buffer): Promise<void> {
    await this.withFolders(async ({ sent }) => {
      const res = await this.require().append(sent, raw, ['\\Seen']);
      if (!res) throw new FolderMissingError(`could not append to ${sent}`);
    });
  }
}
