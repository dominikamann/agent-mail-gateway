import type { MailboxConfig } from '../config/schema.js';
import type { Logger } from '../mail/imap.js';
import type { Store, WebhookJob } from '../store/store.js';
import { VERSION } from '../version.js';
import { signPayload } from './sign.js';

export const RETRY_DELAYS_MS = [10_000, 60_000, 300_000, 900_000, 1_800_000];

export class WebhookDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private stopping = false;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly deps: {
      store: Store;
      mailboxes: Map<string, MailboxConfig>;
      log: Logger;
      fetchFn?: typeof fetch;
      now?: () => number;
    },
  ) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  start(intervalMs = 2000): void {
    this.stopping = false;
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref();
  }

  /** Stops the timer and resolves once a delivery in progress has been recorded. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inflight;
  }

  /** Delivers all due webhooks. Never rejects; concurrent calls share one run. */
  runOnce(): Promise<void> {
    if (this.inflight) return this.inflight;
    const run = this.dispatchDue().finally(() => {
      if (this.inflight === run) this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private async dispatchDue(): Promise<void> {
    try {
      for (const job of this.deps.store.dueWebhooks(this.now())) {
        if (this.stopping) break;
        await this.deliver(job);
      }
    } catch (err) {
      this.deps.log.error({ err: (err as Error).message }, 'webhook dispatch failed');
    }
  }

  private async deliver(job: WebhookJob): Promise<void> {
    const { store, log } = this.deps;
    const hook = this.deps.mailboxes.get(job.mailbox)?.webhook;
    if (!hook) {
      store.markWebhookFailed(job.id, job.attempts);
      return;
    }
    const timestamp = Math.floor(this.now() / 1000);
    const signature = signPayload(hook.secret, timestamp, job.payload);
    let ok = false;
    let reason = '';
    try {
      const res = await this.fetchFn(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': `agent-mail-gateway/${VERSION}`,
          'x-gateway-timestamp': String(timestamp),
          'x-gateway-signature': signature,
          // Same signature in the generic "V2" scheme understood by Hermes Agent webhooks.
          'x-webhook-timestamp': String(timestamp),
          'x-webhook-signature-v2': signature.slice('sha256='.length),
        },
        body: job.payload,
        signal: AbortSignal.timeout(10_000),
      });
      ok = res.ok;
      reason = `HTTP ${res.status}`;
    } catch (err) {
      reason = (err as Error).message;
    }

    if (ok) {
      store.markWebhookDelivered(job.id);
      return;
    }
    const attempts = job.attempts + 1;
    const delay = RETRY_DELAYS_MS[attempts - 1];
    if (delay === undefined) {
      store.markWebhookFailed(job.id, attempts);
      log.error(
        { mailbox: job.mailbox, messageId: job.messageId, reason },
        'webhook delivery failed permanently',
      );
    } else {
      store.rescheduleWebhook(job.id, attempts, this.now() + delay);
      log.warn(
        { mailbox: job.mailbox, messageId: job.messageId, reason, attempts },
        'webhook delivery failed, retrying',
      );
    }
  }
}
