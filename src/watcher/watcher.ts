import { encodeMessageId } from '../mail/ids.js';
import { parseHeaders, parseMessage } from '../mail/parse.js';
import { decideInbound } from '../policy/inbound.js';
import { type MailboxContext, recordAudit } from '../services/context.js';

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
      const fetched = await imap.fetch(fresh.slice(i, i + BATCH));
      for (const msg of fetched) {
        try {
          await this.handle(validity, msg.uid, msg.raw);
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

  private async handle(validity: string, uid: number, raw: Buffer): Promise<void> {
    const { config, imap, store } = this.ctx;
    const headers = await parseHeaders(raw);
    const decision = decideInbound(config, headers);
    const counterparts = headers.from ? [headers.from] : [];

    if (!decision.allowed) {
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

    if (config.webhook) {
      const parsed = await parseMessage(raw);
      const id = encodeMessageId(validity, uid);
      const payload = JSON.stringify({
        event: 'message.received',
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
}
