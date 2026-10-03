import { DatabaseSync } from 'node:sqlite';

export interface WebhookJob {
  id: number;
  mailbox: string;
  messageId: string;
  payload: string;
  attempts: number;
}

export type AuditAction =
  | 'send'
  | 'send_rejected'
  | 'event_create'
  | 'event_update'
  | 'event_cancel'
  | 'delete'
  | 'filtered_delete'
  | 'filtered_keep'
  | 'review_rejected';

export interface AuditEntry {
  at: number;
  mailbox: string;
  action: AuditAction;
  counterparts: string[];
  result: 'ok' | 'rejected' | 'error';
  detail?: string;
}

export interface EventRecord {
  id: string;
  mailbox: string;
  uid: string;
  sequence: number;
  status: 'active' | 'cancelled';
  title: string;
  start: string;
  end: string;
  timezone: string;
  location: string | null;
  description: string | null;
  attendees: string[];
  /** Answers from attendees, e.g. { "a@b.de": "accepted" }. */
  responses?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

type Row = Record<string, unknown>;

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS watcher_state (
        mailbox TEXT PRIMARY KEY, uid_validity TEXT NOT NULL, last_uid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, mailbox TEXT NOT NULL, message_id TEXT NOT NULL,
        payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        UNIQUE (mailbox, message_id));
      CREATE TABLE IF NOT EXISTS sends (mailbox TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sends_mailbox_at ON sends (mailbox, at);
      CREATE TABLE IF NOT EXISTS fingerprints (mailbox TEXT NOT NULL, hash TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS fingerprints_lookup ON fingerprints (mailbox, hash, at);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, mailbox TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, mailbox TEXT NOT NULL,
        action TEXT NOT NULL, counterparts TEXT NOT NULL, result TEXT NOT NULL, detail TEXT);
    `);
  }

  getWatcherState(mailbox: string): { uidValidity: string; lastUid: number } | null {
    const row = this.db
      .prepare('SELECT uid_validity, last_uid FROM watcher_state WHERE mailbox = ?')
      .get(mailbox) as Row | undefined;
    return row ? { uidValidity: String(row.uid_validity), lastUid: Number(row.last_uid) } : null;
  }

  setWatcherState(mailbox: string, uidValidity: string, lastUid: number): void {
    this.db
      .prepare(
        `INSERT INTO watcher_state (mailbox, uid_validity, last_uid) VALUES (?, ?, ?)
         ON CONFLICT (mailbox) DO UPDATE SET uid_validity = excluded.uid_validity, last_uid = excluded.last_uid`,
      )
      .run(mailbox, uidValidity, lastUid);
  }

  enqueueWebhook(mailbox: string, messageId: string, payload: string, now: number): boolean {
    const res = this.db
      .prepare(
        'INSERT OR IGNORE INTO webhooks (mailbox, message_id, payload, next_attempt_at) VALUES (?, ?, ?, ?)',
      )
      .run(mailbox, messageId, payload, now);
    return Number(res.changes) > 0;
  }

  dueWebhooks(now: number, limit = 20): WebhookJob[] {
    const rows = this.db
      .prepare(
        `SELECT id, mailbox, message_id, payload, attempts FROM webhooks
         WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?`,
      )
      .all(now, limit) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      mailbox: String(r.mailbox),
      messageId: String(r.message_id),
      payload: String(r.payload),
      attempts: Number(r.attempts),
    }));
  }

  markWebhookDelivered(id: number): void {
    this.db
      .prepare(`UPDATE webhooks SET status = 'delivered', attempts = attempts + 1 WHERE id = ?`)
      .run(id);
  }

  rescheduleWebhook(id: number, attempts: number, nextAttemptAt: number): void {
    this.db
      .prepare('UPDATE webhooks SET attempts = ?, next_attempt_at = ? WHERE id = ?')
      .run(attempts, nextAttemptAt, id);
  }

  markWebhookFailed(id: number, attempts: number): void {
    this.db
      .prepare(`UPDATE webhooks SET status = 'failed', attempts = ? WHERE id = ?`)
      .run(attempts, id);
  }

  webhookStatus(mailbox: string, messageId: string): { status: string; attempts: number } | null {
    const row = this.db
      .prepare('SELECT status, attempts FROM webhooks WHERE mailbox = ? AND message_id = ?')
      .get(mailbox, messageId) as Row | undefined;
    return row ? { status: String(row.status), attempts: Number(row.attempts) } : null;
  }

  recordSend(mailbox: string, at: number): number {
    const res = this.db.prepare('INSERT INTO sends (mailbox, at) VALUES (?, ?)').run(mailbox, at);
    return Number(res.lastInsertRowid);
  }

  deleteSend(id: number): void {
    this.db.prepare('DELETE FROM sends WHERE rowid = ?').run(id);
  }

  sendsSince(mailbox: string, since: number): number[] {
    const rows = this.db
      .prepare('SELECT at FROM sends WHERE mailbox = ? AND at >= ? ORDER BY at')
      .all(mailbox, since) as Row[];
    return rows.map((r) => Number(r.at));
  }

  recordFingerprint(mailbox: string, hash: string, at: number): void {
    this.db
      .prepare('INSERT INTO fingerprints (mailbox, hash, at) VALUES (?, ?, ?)')
      .run(mailbox, hash, at);
    this.db.prepare('DELETE FROM fingerprints WHERE at < ?').run(at - 7 * 24 * 3_600_000);
  }

  hasFingerprintSince(mailbox: string, hash: string, since: number): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM fingerprints WHERE mailbox = ? AND hash = ? AND at >= ? LIMIT 1')
        .get(mailbox, hash, since) !== undefined
    );
  }

  saveEvent(rec: EventRecord): void {
    this.db
      .prepare(
        `INSERT INTO events (id, mailbox, created_at, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
      )
      .run(rec.id, rec.mailbox, rec.createdAt, JSON.stringify(rec));
  }

  getEvent(mailbox: string, id: string): EventRecord | null {
    const row = this.db
      .prepare('SELECT data FROM events WHERE mailbox = ? AND id = ?')
      .get(mailbox, id) as Row | undefined;
    return row ? (JSON.parse(String(row.data)) as EventRecord) : null;
  }

  listEvents(mailbox: string): EventRecord[] {
    const rows = this.db
      .prepare('SELECT data FROM events WHERE mailbox = ? ORDER BY created_at DESC')
      .all(mailbox) as Row[];
    return rows.map((r) => JSON.parse(String(r.data)) as EventRecord);
  }

  audit(entry: AuditEntry): void {
    this.db
      .prepare(
        'INSERT INTO audit (at, mailbox, action, counterparts, result, detail) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        entry.at,
        entry.mailbox,
        entry.action,
        JSON.stringify(entry.counterparts),
        entry.result,
        entry.detail ?? null,
      );
  }

  listAudit(mailbox: string): AuditEntry[] {
    const rows = this.db
      .prepare(
        'SELECT at, mailbox, action, counterparts, result, detail FROM audit WHERE mailbox = ? ORDER BY id',
      )
      .all(mailbox) as Row[];
    return rows.map((r) => ({
      at: Number(r.at),
      mailbox: String(r.mailbox),
      action: r.action as AuditAction,
      counterparts: JSON.parse(String(r.counterparts)) as string[],
      result: r.result as AuditEntry['result'],
      detail: r.detail === null ? undefined : String(r.detail),
    }));
  }

  close(): void {
    this.db.close();
  }
}
