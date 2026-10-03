import type { MailboxConfig } from '../config/schema.js';
import type { Logger } from '../mail/imap.js';
import type { Store, WebhookJob } from '../store/store.js';
import { VERSION } from '../version.js';
import { signPayload } from './sign.js';

export const RETRY_DELAYS_MS = [10_000, 60_000, 300_000, 900_000, 1_800_000];

export class WebhookDispatcher {
  private timer: NodeJS.Timeout | null = null;
  /** Deliveries in progress, one per mailbox. */
  private readonly busy = new Map<string, Promise<void>>();
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

  /** Stops the timer and resolves once deliveries in progress have been recorded. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all(this.busy.values());
  }

  /**
   * Starts delivering due webhooks for every mailbox that is not already busy, and resolves when
   * those deliveries are done. Never rejects. Mailboxes run independently and each in order, so a
   * slow or failing endpoint only delays its own mailbox.
   */
  runOnce(): Promise<void> {
    let due: Map<string, WebhookJob[]>;
    try {
      due = new Map();
      for (const job of this.deps.store.dueWebhooks(this.now(), [...this.busy.keys()])) {
        due.set(job.mailbox, [...(due.get(job.mailbox) ?? []), job]);
      }
    } catch (err) {
      this.deps.log.error({ err: (err as Error).message }, 'webhook dispatch failed');
      return Promise.resolve();
    }
    const started: Promise<void>[] = [];
    for (const [mailbox, jobs] of due) {
      const run = this.deliverAll(jobs).finally(() => this.busy.delete(mailbox));
      this.busy.set(mailbox, run);
      started.push(run);
    }
    return Promise.all(started).then(() => undefined);
  }

  /** Delivers one mailbox's jobs in order; after a failure the rest wait for their retry. */
  private async deliverAll(jobs: WebhookJob[]): Promise<void> {
    try {
      for (const job of jobs) {
        if (this.stopping || !(await this.deliver(job))) break;
      }
    } catch (err) {
      this.deps.log.error(
        { mailbox: jobs[0]?.mailbox, err: (err as Error).message },
        'webhook dispatch failed',
      );
    }
  }

  /** Returns true if the webhook was delivered. */
  private async deliver(job: WebhookJob): Promise<boolean> {
    const { store, log } = this.deps;
    const hook = this.deps.mailboxes.get(job.mailbox)?.webhook;
    if (!hook) {
      store.markWebhookFailed(job.id, job.attempts);
      return true;
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
        // Never re-send the signed payload to wherever a redirect points.
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      ok = res.ok;
      reason = `HTTP ${res.status}`;
    } catch (err) {
      reason = (err as Error).message;
    }

    if (ok) {
      store.markWebhookDelivered(job.id);
      return true;
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
    return false;
  }
}
