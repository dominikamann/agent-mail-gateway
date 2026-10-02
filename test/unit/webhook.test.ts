import { describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { RETRY_DELAYS_MS, WebhookDispatcher } from '../../src/webhook/dispatcher.js';
import { signPayload, verifySignature } from '../../src/webhook/sign.js';
import { testMailboxConfig } from '../helpers/config.js';
import { silentLogger } from '../helpers/wait.js';

const secret = 's'.repeat(16);

describe('signing', () => {
  it('signs and verifies', () => {
    const sig = signPayload(secret, 1700000000, '{"a":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifySignature(secret, 1700000000, '{"a":1}', sig)).toBe(true);
    expect(verifySignature(secret, 1700000001, '{"a":1}', sig)).toBe(false);
    expect(verifySignature(secret, 1700000000, '{"a":1}', 'sha256=00')).toBe(false);
  });
});

function setup(status: number) {
  const store = new Store(':memory:');
  const cfg = testMailboxConfig({ webhook: { url: 'https://hooks.test/mail', secret } });
  const calls: { url: string; init: RequestInit }[] = [];
  let now = 1_000_000;
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  const d = new WebhookDispatcher({
    store,
    mailboxes: new Map([[cfg.name, cfg]]),
    log: silentLogger,
    fetchFn,
    now: () => now,
  });
  store.enqueueWebhook('agent', '1-1', '{"event":"message.received"}', now);
  return {
    store,
    d,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

describe('WebhookDispatcher', () => {
  it('delivers a signed request once', async () => {
    const { store, d, calls, now } = setup(200);
    await d.runOnce();
    await d.runOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://hooks.test/mail');
    const headers = calls[0]!.init.headers as Record<string, string>;
    const ts = Number(headers['x-gateway-timestamp']);
    expect(ts).toBe(Math.floor(now() / 1000));
    expect(
      verifySignature(secret, ts, String(calls[0]!.init.body), headers['x-gateway-signature']!),
    ).toBe(true);
    expect(store.webhookStatus('agent', '1-1')).toEqual({ status: 'delivered', attempts: 1 });
  });

  it('retries with backoff and gives up after 5 retries', async () => {
    const { store, d, calls, advance } = setup(500);
    await d.runOnce();
    for (const delay of RETRY_DELAYS_MS) {
      await d.runOnce();
      advance(delay);
      await d.runOnce();
    }
    expect(calls).toHaveLength(1 + RETRY_DELAYS_MS.length);
    expect(store.webhookStatus('agent', '1-1')).toEqual({ status: 'failed', attempts: 6 });
  });
});
