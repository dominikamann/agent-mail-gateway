import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { Gateway } from '../../src/services/gateway.js';
import { createStdioServer } from '../../src/stdio.js';
import { createTestContext } from '../helpers/fakes.js';
import { buildRaw } from '../helpers/mail.js';

const TOOLS = [
  'cancel_event',
  'create_event',
  'delete_message',
  'get_attachment',
  'get_mailbox_info',
  'list_events',
  'list_messages',
  'mark_message',
  'read_message',
  'send_message',
  'update_event',
];

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function connect(env: Record<string, string | undefined>) {
  const server = await createStdioServer(env);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  cleanups.push(
    () => client.close(),
    () => server.close(),
  );
  return client;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

describe('stdio entry point', () => {
  it('preview mode lists all tools and explains how to connect', async () => {
    const client = await connect({});
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(TOOLS);
    const res = await client.callTool({ name: 'list_messages', arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/AGENT_MAIL_URL.*AGENT_MAIL_API_KEY/);
  });

  it('bridge mode forwards to a gateway with the agent key', async () => {
    const t = createTestContext();
    t.imap.add(await buildRaw({ from: 'boss@test.local', subject: 'Hello' }));
    const app: FastifyInstance = await buildApp(new Gateway([t.ctx]));
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => app.close());

    const client = await connect({ AGENT_MAIL_URL: base, AGENT_MAIL_API_KEY: 'k'.repeat(32) });
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(TOOLS);
    const res = await client.callTool({ name: 'list_messages', arguments: {} });
    expect(JSON.parse(text(res)).messages[0].subject).toBe('Hello');
  });

  it('bridge mode with a wrong key fails instead of serving data', async () => {
    const t = createTestContext();
    const app: FastifyInstance = await buildApp(new Gateway([t.ctx]));
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => app.close());
    const client = await connect({
      AGENT_MAIL_URL: `${base}/mcp`,
      AGENT_MAIL_API_KEY: 'x'.repeat(32),
    });
    await expect(client.listTools()).rejects.toThrow();
  });

  it('requires a key when a URL is set', async () => {
    await expect(createStdioServer({ AGENT_MAIL_URL: 'http://localhost:8080' })).rejects.toThrow(
      /AGENT_MAIL_API_KEY/,
    );
  });
});
