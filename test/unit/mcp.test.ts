import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { Gateway } from '../../src/services/gateway.js';
import { createTestContext } from '../helpers/fakes.js';
import { buildRaw } from '../helpers/mail.js';

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

async function connect(key: string) {
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}

const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

describe('MCP', () => {
  it('lists tools and runs them against the key’s mailbox', async () => {
    const t = createTestContext();
    const uid = t.imap.add(await buildRaw({ from: 'boss@test.local', subject: 'S', text: 'Body' }));
    app = await buildApp(new Gateway([t.ctx]));
    const client = await connect('k'.repeat(32));

    const tools = (await client.listTools()).tools.map((x) => x.name).sort();
    expect(tools).toEqual([
      'cancel_event',
      'create_event',
      'delete_message',
      'forward_message',
      'get_attachment',
      'get_event',
      'get_mailbox_info',
      'list_events',
      'list_messages',
      'mark_message',
      'read_message',
      'reply_message',
      'respond_to_invitation',
      'search_messages',
      'send_message',
      'update_event',
    ]);

    const list = text(await client.callTool({ name: 'list_messages', arguments: {} }));
    expect(list.messages[0].id).toBe(`1-${uid}`);
    const msg = text(
      await client.callTool({ name: 'read_message', arguments: { id: `1-${uid}` } }),
    );
    expect(msg.body_markdown).toBe('Body');

    const sent = text(
      await client.callTool({
        name: 'send_message',
        arguments: { to: ['boss@test.local'], subject: 'Hi', body_markdown: 'x' },
      }),
    );
    expect(sent.message_id).toBeTruthy();
    expect(t.smtp.sent).toHaveLength(1);

    const denied = await client.callTool({
      name: 'send_message',
      arguments: { to: ['x@evil.local'], subject: 'Hi', body_markdown: 'x' },
    });
    expect(denied.isError).toBe(true);
    expect(text(denied).error).toBe('recipient_not_allowed');
    await client.close();
  });

  it('returns attachments as embedded resources', async () => {
    const t = createTestContext();
    const uid = t.imap.add(
      await buildRaw({
        from: 'boss@test.local',
        attachments: [{ filename: 'a.txt', content: 'abc', contentType: 'text/plain' }],
      }),
    );
    app = await buildApp(new Gateway([t.ctx]));
    const client = await connect('k'.repeat(32));
    const res = (await client.callTool({
      name: 'get_attachment',
      arguments: { id: `1-${uid}`, index: 0 },
    })) as { content: { type: string; resource: { blob: string; mimeType: string } }[] };
    expect(res.content[0]!.type).toBe('resource');
    expect(Buffer.from(res.content[0]!.resource.blob, 'base64').toString()).toBe('abc');
    await client.close();
  });

  it('rejects a wrong key', async () => {
    app = await buildApp(new Gateway([createTestContext().ctx]));
    await expect(connect('x'.repeat(32))).rejects.toThrow();
  });
});
