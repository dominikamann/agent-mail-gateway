import { encodeMessageId } from '../mail/ids.js';
import type { MessageMeta } from '../mail/imap.js';
import { type ParsedMessage, parseHeaders } from '../mail/parse.js';
import { decideInbound } from '../policy/inbound.js';
import { evaluateSenderAuth } from '../policy/sender-auth.js';
import { type MailboxContext, recordAudit } from '../services/context.js';
import { recordResponse } from '../services/events.js';
import { parseForSummary } from '../services/messages.js';

const BATCH = 20;

export class InboundWatcher {
  private running: Promise<void> | null = null;
  private rerun = false;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly ctx: MailboxContext) {}

  start(): void {
    this.unsubscribe = this.ctx.imap.onNewMail(() => void this.processNew());
    this.timer = setInterval(
      () => void this.processNew(),
      this.ctx.config.poll_interval_seconds * 1000,
    );
    this.timer.unref();
    void this.processNew();
  }

  /** Stops reacting to new mail and resolves once a run in progress has finished. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.running;
  }

  processNew(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.rerun = false;
          await this.runOnce();
        } while (this.rerun);
      } catch (err) {
        this.ctx.log.error(
          { mailbox: this.ctx.config.name, err: (err as Error).message },
          'watcher run failed',
        );
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async runOnce(): Promise<void> {
    const { imap, store, config } = this.ctx;
    if (imap.state() !== 'connected') return;
    const validity = await imap.uidValidity();
    const state = store.getWatcherState(config.name);

    if (!state || state.uidValidity !== validity) {
      const all = await imap.search({});
      const max = all[all.length - 1] ?? 0;
      store.setWatcherState(config.name, validity, max);
      this.ctx.log.info(
        { mailbox: config.name, uidValidity: validity, lastUid: max },
        'watcher baseline',
      );
      return;
    }

    const fresh = await imap.search({ uidAbove: state.lastUid });
    for (let i = 0; i < fresh.length; i += BATCH) {
      // Headers only: blocked mail is never downloaded.
      const metas = await imap.fetchMeta(fresh.slice(i, i + BATCH));
      for (const msg of metas) {
        try {
          await this.handle(validity, msg);
        } catch (err) {
          if (imap.state() !== 'connected') throw err;
          this.ctx.log.error(
            { mailbox: config.name, uid: msg.uid, err: (err as Error).message },
            'could not process message, skipping it',
          );
        }
        store.setWatcherState(config.name, validity, msg.uid);
      }
    }
  }

  private async handle(validity: string, meta: MessageMeta): Promise<void> {
    const { config, imap, store } = this.ctx;
    const uid = meta.uid;
    const headers = await parseHeaders(meta.header);
    const decision = decideInbound(config, headers);
    const counterparts = headers?.from ? [headers.from] : [];

    if (!decision.allowed) {
      // Answers to our own invitations from attendees who may not otherwise write to this
      // mailbox (not on allow_receive_from) are still recorded; the mail itself stays hidden.
      if (
        decision.reason === 'sender_not_allowed' &&
        meta.hasCalendar &&
        headers?.from &&
        this.isAttendee(headers.from) &&
        (!config.require_sender_auth ||
          evaluateSenderAuth(headers.authResults, headers.from, config.trusted_authserv_id) ===
            'pass')
      ) {
        this.recordReply(await parseForSummary(this.ctx, meta), headers.from);
      }
      if (decision.reason === 'sender_auth_missing') {
        this.ctx.log.warn(
          { mailbox: config.name },
          'mail filtered only because Authentication-Results is missing; set require_sender_auth: false if your server never adds it',
        );
      }
      if (config.non_allowed_action === 'delete') {
        await imap.moveToTrash(uid);
        recordAudit(this.ctx, 'filtered_delete', counterparts, 'ok', decision.reason);
      } else {
        recordAudit(this.ctx, 'filtered_keep', counterparts, 'ok', decision.reason);
      }
      return;
    }

    if (!config.webhook && !meta.hasCalendar) return;
    const parsed = await parseForSummary(this.ctx, meta);

    this.recordReply(parsed, headers?.from ?? null);

    if (config.webhook) {
      const id = encodeMessageId(validity, uid);
      const payload = JSON.stringify({
        event: 'message.received',
        event_type: 'message.received',
        mailbox: config.name,
        message: {
          id,
          from: parsed.from,
          subject: parsed.subject,
          date: parsed.date,
          preview: parsed.preview,
        },
      });
      store.enqueueWebhook(config.name, id, payload, this.ctx.now());
    }
  }

  private isAttendee(address: string): boolean {
    const a = address.toLowerCase();
    return this.ctx.store
      .listEvents(this.ctx.config.name)
      .some((e) => e.status === 'active' && e.attendees.includes(a));
  }

  /** An attendee answered one of our invitations: remember accepted/declined/tentative. */
  private recordReply(parsed: ParsedMessage, from: string | null): void {
    const inv = parsed.invitation;
    if (inv?.method !== 'REPLY') return;
    const answers = inv.attendees
      .filter((a) => a.status)
      .map((a) => ({ email: a.email, status: a.status! }));
    recordResponse(this.ctx, { uid: inv.uid, sequence: inv.sequence, from }, answers);
  }
}
