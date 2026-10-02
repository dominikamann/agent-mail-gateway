import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.js';
import { buildApp } from '../../src/http/app.js';
import { startGateway } from '../../src/main.js';
import { Gateway } from '../../src/services/gateway.js';
import { listMessages } from '../../src/services/messages.js';
import { Store } from '../../src/store/store.js';
import { InboundWatcher } from '../../src/watcher/watcher.js';
import { WebhookDispatcher } from '../../src/webhook/dispatcher.js';
import { testMailboxConfig } from '../helpers/config.js';
import { createTestContext } from '../helpers/fakes.js';
import { buildRaw } from '../helpers/mail.js';
import { silentLogger } from '../helpers/wait.js';

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('M1: HTTP is up even when the IMAP server stalls', () => {
  it('starts listening without waiting for IMAP', async () => {
    const stalled: Server = createServer(() => {}).listen(0, '127.0.0.1');
    await new Promise((r) => stalled.once('listening', r));
    cleanups.push(() => stalled.close());
    const port = (stalled.address() as { port: number }).port;
    const config = configSchema.parse({
      server: { port: 0, log_level: 'fatal', data_dir: mkdtempSync(join(tmpdir(), 'amg-')) },
      mailboxes: [
        testMailboxConfig({
          imap: { host: '127.0.0.1', port, security: 'none' },
          smtp: { host: '127.0.0.1', port, security: 'none' },
        }),
      ],
    });
    const started = Date.now();
    const gw = await startGateway(config, { listen: true, port: 0 });
    cleanups.push(() => gw.stop());
    expect(Date.now() - started).toBeLessThan(3000);
    const res = await gw.app.inject({ url: '/health' });
    expect(res.json().status).toBe('degraded');
  });
});

describe('M2: dispatcher shutdown', () => {
  it('stop waits for an in-flight delivery', async () => {
    const store = new Store(':memory:');
    const cfg = testMailboxConfig({ webhook: { url: 'https://h.test/x', secret: 's'.repeat(16) } });
    let release: () => void = () => {};
    const fetchFn = (() =>
      new Promise<Response>((resolve) => {
        release = () => resolve(new Response(null, { status: 200 }));
      })) as unknown as typeof fetch;
    const d = new WebhookDispatcher({
      store,
      mailboxes: new Map([[cfg.name, cfg]]),
      log: silentLogger,
      fetchFn,
    });
    store.enqueueWebhook('agent', '1-1', '{}', 0);
    void d.runOnce();
    await new Promise((r) => setTimeout(r, 10));
    const stopped = d.stop();
    release();
    await stopped;
    expect(store.webhookStatus('agent', '1-1')?.status).toBe('delivered');
  });

  it('runOnce never rejects', async () => {
    const store = new Store(':memory:');
    const d = new WebhookDispatcher({ store, mailboxes: new Map(), log: silentLogger });
    store.close();
    await expect(d.runOnce()).resolves.toBeUndefined();
  });
});

describe('M3: attachment download headers', () => {
  it('sends nosniff and a sandbox CSP', async () => {
    const t = createTestContext();
    const uid = t.imap.add(
      await buildRaw({
        from: 'boss@test.local',
        attachments: [
          { filename: 'x.html', content: '<script>1</script>', contentType: 'text/html' },
        ],
      }),
    );
    const app = await buildApp(new Gateway([t.ctx]));
    cleanups.push(() => app.close());
    const res = await app.inject({
      url: `/v1/messages/1-${uid}/attachments/0`,
      headers: { authorization: `Bearer ${'k'.repeat(32)}` },
    });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
  });
});

describe('M5: watcher stop', () => {
  it('ignores new-mail events after stop', async () => {
    const { ctx, imap, store } = createTestContext({
      webhook: { url: 'https://h.test/x', secret: 's'.repeat(16) },
    });
    const w = new InboundWatcher(ctx);
    w.start();
    await w.processNew();
    w.stop();
    imap.add(await buildRaw({ from: 'boss@test.local' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(store.dueWebhooks(Date.now())).toHaveLength(0);
  });
});

describe('M6: since filter', () => {
  it('filters by exact time, not only by day', async () => {
    const { ctx, imap } = createTestContext();
    imap.add(
      await buildRaw({
        from: 'boss@test.local',
        subject: 'early',
        date: new Date('2026-10-02T06:00:00Z'),
      }),
      false,
      new Date('2026-10-02T06:00:00Z'),
    );
    imap.add(
      await buildRaw({
        from: 'boss@test.local',
        subject: 'late',
        date: new Date('2026-10-02T18:00:00Z'),
      }),
      false,
      new Date('2026-10-02T18:00:00Z'),
    );
    const res = await listMessages(ctx, { limit: 10, since: new Date('2026-10-02T12:00:00Z') });
    expect(res.messages.map((m) => m.subject)).toEqual(['late']);
  });

  it('MCP list_messages accepts a plain date', async () => {
    const t = createTestContext();
    const app = await buildApp(new Gateway([t.ctx]));
    cleanups.push(() => app.close());
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const client = new Client({ name: 't', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${'k'.repeat(32)}` } },
      }),
    );
    cleanups.push(() => client.close());
    const res = await client.callTool({
      name: 'list_messages',
      arguments: { since: '2026-10-01' },
    });
    expect(res.isError).toBeFalsy();
  });
});
