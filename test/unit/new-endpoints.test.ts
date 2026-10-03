import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildIcs } from '../../src/calendar/ics.js';
import { buildApp } from '../../src/http/app.js';
import { Gateway } from '../../src/services/gateway.js';
import { createTestContext } from '../helpers/fakes.js';
import { buildRaw } from '../helpers/mail.js';

const KEY = 'k'.repeat(32);
const auth = { authorization: `Bearer ${KEY}` };
let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

const invitation = () =>
  buildRaw({
    from: 'x@partner.local',
    subject: 'Invitation: Planning',
    text: 'See invite',
    attachments: [
      {
        filename: 'invite.ics',
        contentType: 'text/calendar; method=REQUEST',
        content: buildIcs({
          uid: 'm1@partner.local',
          sequence: 0,
          method: 'REQUEST',
          organizer: 'x@partner.local',
          attendees: ['agent@test.local'],
          title: 'Planning',
          start: new Date('2026-10-10T12:00:00Z'),
          end: new Date('2026-10-10T13:00:00Z'),
          location: null,
          description: null,
        }),
      },
    ],
  });

describe('REST: new endpoints', () => {
  it('search, reply, forward, rsvp, get event', async () => {
    const t = createTestContext();
    const q = t.imap.add(
      await buildRaw({ from: 'boss@test.local', subject: 'Question', text: 'What about pizza?' }),
    );
    const inv = t.imap.add(await invitation());
    app = await buildApp(new Gateway([t.ctx]));

    const search = await app.inject({
      url: '/v1/messages?text=pizza&from=boss@test.local',
      headers: auth,
    });
    expect(search.json().messages.map((m: { id: string }) => m.id)).toEqual([`1-${q}`]);

    const reply = await app.inject({
      method: 'POST',
      url: `/v1/messages/1-${q}/reply`,
      headers: auth,
      payload: { body_markdown: 'Pizza sounds great.' },
    });
    expect(reply.statusCode).toBe(200);
    const fwd = await app.inject({
      method: 'POST',
      url: `/v1/messages/1-${q}/forward`,
      headers: auth,
      payload: { to: ['x@partner.local'], body_markdown: 'See below, please.' },
    });
    expect(fwd.statusCode).toBe(200);
    const rsvp = await app.inject({
      method: 'POST',
      url: `/v1/messages/1-${inv}/rsvp`,
      headers: auth,
      payload: { response: 'tentative' },
    });
    expect(rsvp.statusCode).toBe(200);
    expect(t.smtp.sent.map((s) => s.envelope.to)).toEqual([
      ['boss@test.local'],
      ['x@partner.local'],
      ['x@partner.local'],
    ]);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: auth,
      payload: {
        title: 'T',
        start: '2026-10-10T12:00:00Z',
        end: '2026-10-10T13:00:00Z',
        attendees: ['boss@test.local'],
      },
    });
    const one = await app.inject({ url: `/v1/events/${created.json().id}`, headers: auth });
    expect(one.json()).toMatchObject({ title: 'T', responses: {} });
    expect((await app.inject({ url: '/v1/events/nope', headers: auth })).statusCode).toBe(404);
  });
});

describe('MCP: new tools', () => {
  it('exposes and runs them', async () => {
    const t = createTestContext();
    const q = t.imap.add(
      await buildRaw({ from: 'boss@test.local', subject: 'Question', text: 'What about pizza?' }),
    );
    const inv = t.imap.add(await invitation());
    app = await buildApp(new Gateway([t.ctx]));
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const client = new Client({ name: 't', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
        requestInit: { headers: auth },
      }),
    );
    const names = (await client.listTools()).tools.map((x) => x.name);
    for (const n of [
      'search_messages',
      'reply_message',
      'forward_message',
      'respond_to_invitation',
      'get_event',
    ]) {
      expect(names).toContain(n);
    }
    const text = (r: unknown) =>
      JSON.parse((r as { content: { text: string }[] }).content[0]!.text);
    expect(
      text(await client.callTool({ name: 'search_messages', arguments: { text: 'pizza' } }))
        .messages,
    ).toHaveLength(1);
    const noCriteria = await client.callTool({ name: 'search_messages', arguments: {} });
    expect(noCriteria.isError).toBe(true);
    expect(
      text(await client.callTool({ name: 'read_message', arguments: { id: `1-${inv}` } }))
        .invitation.title,
    ).toBe('Planning');
    await client.callTool({
      name: 'reply_message',
      arguments: { id: `1-${q}`, body_markdown: 'Pizza sounds great.' },
    });
    await client.callTool({
      name: 'respond_to_invitation',
      arguments: { id: `1-${inv}`, response: 'accept' },
    });
    expect(t.smtp.sent).toHaveLength(2);
    await client.close();
  });
});
