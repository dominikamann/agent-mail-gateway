import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.js';
import { startGateway } from '../../src/main.js';
import { verifySignature } from '../../src/webhook/sign.js';
import { buildRaw } from '../helpers/mail.js';
import { waitFor } from '../helpers/wait.js';
import { type GreenMail, startGreenMail } from './greenmail.js';

const KEY = 'e'.repeat(32);
const SECRET = 'w'.repeat(16);
let gm: GreenMail;
let hookServer: Server;
const hooks: { body: string; ts: number; sig: string }[] = [];
let gateway: Awaited<ReturnType<typeof startGateway>>;
let base: string;

beforeAll(async () => {
  gm = await startGreenMail();
  const admin = await gm.client('agent@test.local');
  await admin.mailboxCreate('Trash').catch(() => {});
  await admin.logout();

  hookServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      hooks.push({
        body,
        ts: Number(req.headers['x-gateway-timestamp']),
        sig: String(req.headers['x-gateway-signature']),
      });
      res.end('ok');
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => hookServer.once('listening', r));
  const hookPort = (hookServer.address() as AddressInfo).port;

  const mailbox = gm.mailboxConfig('agent@test.local', {
    api_key: KEY,
    poll_interval_seconds: 10,
    webhook: { url: `http://127.0.0.1:${hookPort}/hook`, secret: SECRET },
  });
  const config = configSchema.parse({
    server: { port: 0, log_level: 'warn', data_dir: mkdtempSync(join(tmpdir(), 'amg-')) },
    mailboxes: [mailbox],
  });
  gateway = await startGateway(config, { listen: true, port: 0 });
  const addr = gateway.app.server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  await waitFor(async () => (await (await fetch(`${base}/health`)).json()).status === 'ok');
  await waitFor(() =>
    fetch(`${base}/v1/messages`, { headers: { authorization: `Bearer ${KEY}` } }).then((r) => r.ok),
  );
  await new Promise((r) => setTimeout(r, 500));
});

afterAll(async () => {
  await gateway?.stop();
  hookServer?.close();
  await gm?.stop();
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

describe('end to end', () => {
  it('filters, notifies, reads, replies, and sends invites through a real mail server', async () => {
    await gm.deliver(
      'stranger@evil.local',
      'agent@test.local',
      await buildRaw({ from: 'stranger@evil.local', subject: 'Spam' }),
    );
    await gm.deliver(
      'boss@test.local',
      'agent@test.local',
      await buildRaw({
        from: 'boss@test.local',
        subject: 'Task',
        html: '<p>Please <b>report</b></p>',
        messageId: '<task@test.local>',
      }),
    );

    await waitFor(() => hooks.length > 0, 30_000);
    const hook = hooks[0]!;
    expect(verifySignature(SECRET, hook.ts, hook.body, hook.sig)).toBe(true);
    const { message } = JSON.parse(hook.body);
    expect(message.subject).toBe('Task');

    expect(await waitFor(() => gm.count('agent@test.local', 'Trash'))).toBe(1);

    const list = await (await api('/v1/messages')).json();
    expect(list.messages.map((m: { subject: string }) => m.subject)).toEqual(['Task']);
    const msg = await (await api(`/v1/messages/${message.id}`)).json();
    expect(msg.body_markdown).toBe('Please **report**');

    const reply = await api('/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        to: ['boss@test.local'],
        subject: 'Task',
        body_markdown: 'Done',
        reply_to_id: message.id,
      }),
    });
    expect(reply.status).toBe(200);

    const event = await api('/v1/events', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Review',
        start: new Date(Date.now() + 86_400_000).toISOString(),
        end: new Date(Date.now() + 90_000_000).toISOString(),
        attendees: ['boss@test.local'],
      }),
    });
    expect(event.status).toBe(201);

    const boss = await gm.client('boss@test.local');
    await boss.mailboxOpen('INBOX');
    const sources = await waitFor(async () => {
      const out: string[] = [];
      for await (const m of boss.fetch('1:*', { source: true })) out.push(m.source!.toString());
      return out.length >= 2 ? out : null;
    });
    await boss.logout();
    expect(sources.some((s) => s.includes('In-Reply-To: <task@test.local>'))).toBe(true);
    expect(sources.some((s) => /text\/calendar;[^\n]*method=REQUEST/i.test(s))).toBe(true);
    expect(await gm.count('agent@test.local', 'Sent')).toBe(2);

    const denied = await api('/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ to: ['stranger@evil.local'], subject: 'x', body_markdown: 'x' }),
    });
    expect(denied.status).toBe(403);
  });
});
