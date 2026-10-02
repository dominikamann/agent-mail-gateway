import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { InboundWatcher } from '../../src/watcher/watcher.js';
import { WebhookDispatcher } from '../../src/webhook/dispatcher.js';
import { testMailboxConfig } from '../helpers/config.js';
import { createTestContext } from '../helpers/fakes.js';
import { buildRaw } from '../helpers/mail.js';
import { silentLogger } from '../helpers/wait.js';

const secret = 's'.repeat(16);

describe('Hermes-compatible webhooks', () => {
  it('sends X-Webhook-Timestamp and X-Webhook-Signature-V2 (hex HMAC of "<ts>.<body>")', async () => {
    const store = new Store(':memory:');
    const cfg = testMailboxConfig({ webhook: { url: 'https://h.test/x', secret } });
    let headers: Record<string, string> = {};
    let body = '';
    const fetchFn = (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      body = String(init.body);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const d = new WebhookDispatcher({
      store,
      mailboxes: new Map([[cfg.name, cfg]]),
      log: silentLogger,
      fetchFn,
    });
    store.enqueueWebhook('agent', '1-1', '{"event":"message.received"}', 0);
    await d.runOnce();

    const ts = headers['x-webhook-timestamp']!;
    expect(ts).toMatch(/^\d+$/);
    const expected = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    expect(headers['x-webhook-signature-v2']).toBe(expected);
    expect(headers['x-gateway-signature']).toBe(`sha256=${expected}`);
    expect(headers['x-gateway-timestamp']).toBe(ts);
  });

  it('payload carries event_type for Hermes route filters', async () => {
    const { ctx, imap, store } = createTestContext({
      webhook: { url: 'https://h.test/x', secret },
    });
    const w = new InboundWatcher(ctx);
    await w.processNew();
    imap.add(await buildRaw({ from: 'boss@test.local', subject: 'Hi' }));
    await w.processNew();
    const payload = JSON.parse(store.dueWebhooks(Date.now())[0]!.payload);
    expect(payload).toMatchObject({ event: 'message.received', event_type: 'message.received' });
  });
});
