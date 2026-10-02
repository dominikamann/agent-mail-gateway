import { createHash, timingSafeEqual } from 'node:crypto';
import type { MailboxContext } from './context.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

export class Gateway {
  private readonly keyed: { digest: Buffer; ctx: MailboxContext }[];

  constructor(readonly contexts: MailboxContext[]) {
    this.keyed = contexts.map((ctx) => ({ digest: digest(ctx.config.api_key), ctx }));
  }

  byKey(key: string): MailboxContext | null {
    const candidate = digest(key);
    let found: MailboxContext | null = null;
    for (const entry of this.keyed) {
      if (timingSafeEqual(entry.digest, candidate)) found = entry.ctx;
    }
    return found;
  }
}
