import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.js';
import { createTestContext } from '../helpers/fakes.js';

// Guards the qualities MCP directories (e.g. Glama's TDQS) score tool definitions on:
// purpose, when to use which tool, behaviour/side effects, parameter docs, annotations, titles.
async function tools() {
  const { ctx } = createTestContext();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(ctx).connect(b);
  const c = new Client({ name: 't', version: '1' });
  await c.connect(a);
  return (await c.listTools()).tools;
}

const READ_ONLY = [
  'get_mailbox_info',
  'list_messages',
  'get_attachment',
  'get_event',
  'list_events',
];
const DESTRUCTIVE = ['delete_message', 'cancel_event'];
const OUTWARD = [
  'send_message',
  'reply_message',
  'forward_message',
  'respond_to_invitation',
  'create_event',
  'update_event',
  'cancel_event',
];

describe('MCP tool definitions', () => {
  it('has a focused set of 15 tools without overlaps', async () => {
    const names = (await tools()).map((t) => t.name).sort();
    expect(names).toHaveLength(15);
    expect(names).not.toContain('search_messages');
  });

  it('every tool has a meaningful title and complete annotations', async () => {
    for (const t of await tools()) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.title!.length, t.name).toBeGreaterThan(t.name.length);
      const a = t.annotations ?? {};
      for (const hint of [
        'readOnlyHint',
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
      ] as const) {
        expect(typeof a[hint], `${t.name}.${hint}`).toBe('boolean');
      }
      expect(a.readOnlyHint, t.name).toBe(READ_ONLY.includes(t.name));
      expect(a.destructiveHint, t.name).toBe(DESTRUCTIVE.includes(t.name));
      expect(a.openWorldHint, t.name).toBe(OUTWARD.includes(t.name));
    }
  });

  it('every description is substantial and points to a sibling tool', async () => {
    const all = await tools();
    const names = all.map((t) => t.name);
    for (const t of all) {
      const d = t.description ?? '';
      expect(d.length, t.name).toBeGreaterThan(120);
      expect(d.length, t.name).toBeLessThan(700);
      expect(
        names.some((n) => n !== t.name && d.includes(n)),
        `${t.name} should say when to use it vs a sibling`,
      ).toBe(true);
      expect(d, `${t.name} should say what it returns`).toMatch(/[Rr]eturns/);
    }
  });

  it('every parameter is described', async () => {
    for (const t of await tools()) {
      const props =
        (t.inputSchema as { properties?: Record<string, { description?: string }> }).properties ??
        {};
      for (const [name, schema] of Object.entries(props)) {
        expect(schema.description, `${t.name}.${name}`).toBeTruthy();
      }
    }
  });
});
