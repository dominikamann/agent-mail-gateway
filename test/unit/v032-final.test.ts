import { describe, expect, it } from 'vitest';
import type { MailboxConfigInput } from '../../src/config/schema.js';
import { forwardMessage } from '../../src/services/compose.js';
import type { SendMessageInput } from '../../src/services/schemas.js';
import { sendMessageSchema } from '../../src/services/schemas.js';
import { sendMessage } from '../../src/services/send.js';
import { createTestContext } from '../helpers/fakes.js';
import { buildRaw } from '../helpers/mail.js';

type Body = { messages: { role: string; content: string }[] };

function guarded(
  rules: { rule: string; recipients?: string[] }[],
  extra: Record<string, unknown> = {},
) {
  const bodies: Body[] = [];
  const t = createTestContext({
    review: {
      llm: { url: 'http://ollama:11434/v1', model: 'm', mode: 'off' },
      policies: { rules, binary_attachments: 'block', ...extra },
    } as MailboxConfigInput['review'],
  });
  t.ctx.fetch = (async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body)) as Body;
    bodies.push(b);
    const hit = /IBAN/.test(b.messages[1]!.content);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ violations: hit ? [{ rule: 1, reason: 'IBAN' }] : [] }),
            },
          },
        ],
      }),
    );
  }) as unknown as typeof fetch;
  return { ...t, bodies };
}
const mail = (over: Partial<SendMessageInput> = {}) =>
  sendMessageSchema.parse({
    to: ['boss@test.local'],
    subject: 'Report',
    body_markdown: 'Hello, here is the report.',
    ...over,
  });
const BIN = Buffer.from([0, 255, 1, 254, 2, 253, 0, 0, 7]).toString('base64');

describe('binary_attachments: block', () => {
  it('only blocks when a policy applies to the recipients', async () => {
    const { ctx, smtp } = guarded([{ rule: 'No bank details.', recipients: ['*@partner.local'] }]);
    await sendMessage(
      ctx,
      mail({ attachments: [{ filename: 'x.bin', content_base64: BIN }] } as never),
    );
    expect(smtp.sent).toHaveLength(1);
    await expect(
      sendMessage(
        ctx,
        mail({
          to: ['x@partner.local'],
          attachments: [{ filename: 'x.bin', content_base64: BIN }],
        } as never),
      ),
    ).rejects.toMatchObject({ details: { reasons: [{ rule: 'policy_binary_attachment' }] } });
  });

  it('does not block files forwarded from a received message', async () => {
    const { ctx, imap, smtp } = guarded([{ rule: 'No bank details.' }]);
    const uid = imap.add(
      await buildRaw({
        from: 'boss@test.local',
        text: 'see',
        attachments: [
          {
            filename: 'logo.png',
            content: Buffer.from([137, 80, 78, 71, 0, 0, 1, 2]),
            contentType: 'image/png',
          },
        ],
      }),
    );
    await forwardMessage(ctx, `1-${uid}`, {
      to: ['boss@test.local'],
      cc: [],
      bcc: [],
      body_markdown: 'Please have a look at this.',
      include_attachments: true,
    });
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]!.raw.toString()).toContain('logo.png');
  });
});

describe('files from received mail', () => {
  it('are still policy-checked when they are text', async () => {
    const { ctx, imap, smtp } = guarded([{ rule: 'No bank details.' }]);
    const uid = imap.add(
      await buildRaw({
        from: 'boss@test.local',
        text: 'see',
        attachments: [
          { filename: 'accounts.csv', content: 'IBAN DE89 3704', contentType: 'text/csv' },
        ],
      }),
    );
    await expect(
      forwardMessage(ctx, `1-${uid}`, {
        to: ['boss@test.local'],
        cc: [],
        bcc: [],
        body_markdown: 'Please have a look at this.',
        include_attachments: true,
      }),
    ).rejects.toMatchObject({ code: 'review_rejected' });
    expect(smtp.sent).toHaveLength(0);
  });
});

describe('text attachments in legacy encodings', () => {
  it('reads Windows-1252 text so policies check it', async () => {
    const { ctx, smtp } = guarded([{ rule: 'No bank details.' }], { binary_attachments: 'allow' });
    const csv = Buffer.from('Name;IBAN\nM\xfcller;DE89 3704 0044\n', 'latin1').toString('base64');
    await expect(
      sendMessage(
        ctx,
        mail({ attachments: [{ filename: 'list.csv', content_base64: csv }] } as never),
      ),
    ).rejects.toMatchObject({ code: 'review_rejected' });
    expect(smtp.sent).toHaveLength(0);
  });
});

describe('MCP unexpected errors', () => {
  it('are logged for the operator', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { createMcpServer } = await import('../../src/mcp/server.js');
    const { ctx, imap } = createTestContext();
    const logged: unknown[] = [];
    ctx.log = { ...ctx.log, error: (o: unknown) => logged.push(o) } as typeof ctx.log;
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(ctx).connect(b);
    const c = new Client({ name: 't', version: '1' });
    await c.connect(a);
    imap.search = async () => {
      throw new Error('boom at 10.0.0.5');
    };
    await c.callTool({ name: 'list_messages', arguments: {} });
    expect(JSON.stringify(logged)).toContain('boom at 10.0.0.5');
  });
});
