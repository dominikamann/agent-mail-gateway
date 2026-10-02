import type { MailboxConfig } from '../config/schema.js';
import type { Logger } from '../mail/imap.js';
import type { Store, WebhookJob } from '../store/store.js';
import { VERSION } from '../version.js';
import { signPayload } from './sign.js';

export const RETRY_DELAYS_MS = [10_000, 60_000, 300_000, 900_000, 1_800_000];

export class WebhookDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
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
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const job of this.deps.store.dueWebhooks(this.now())) await this.deliver(job);
    } finally {
      this.busy = false;
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
    let ok = false;
    let reason = '';
    try {
      const res = await this.fetchFn(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': `agent-mail-gateway/${VERSION}`,
          'x-gateway-timestamp': String(timestamp),
          'x-gateway-signature': signPayload(hook.secret, timestamp, job.payload),
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
