import { describe, expect, it } from 'vitest';
import { parseMessage } from '../../src/mail/parse.js';
import type { SendMessageInput } from '../../src/services/schemas.js';
import { sendMessage } from '../../src/services/send.js';
import { createTestContext } from '../helpers/fakes.js';
import { buildRaw } from '../helpers/mail.js';

const input = (over: Partial<SendMessageInput> = {}): SendMessageInput => ({
  to: ['boss@test.local'],
  cc: [],
  bcc: [],
  subject: 'Hi',
  body_markdown: '**Hello**',
  attachments: [],
  ...over,
});

describe('sendMessage', () => {
  it('sends markdown as html + text, copies to Sent, records send and audit', async () => {
    const { ctx, smtp, imap, store } = createTestContext();
    const res = await sendMessage(ctx, input({ bcc: ['x@partner.local'] }));
    expect(res.message_id).toMatch(/@test\.local>$/);
    expect(res.warnings).toEqual([]);
    expect(smtp.sent[0]?.envelope).toEqual({
      from: 'agent@test.local',
      to: ['boss@test.local', 'x@partner.local'],
    });
    const raw = smtp.sent[0]!.raw.toString();
    expect(raw).toContain('<strong>Hello</strong>');
    expect(raw).toContain('**Hello**');
    expect(imap.sent).toHaveLength(1);
    expect(store.sendsSince('agent', 0)).toHaveLength(1);
    expect(store.listAudit('agent').map((a) => a.action)).toEqual(['send']);
  });

  it('rejects the whole message if any recipient is not allowed', async () => {
    const { ctx, smtp, store } = createTestContext();
    await expect(
      sendMessage(ctx, input({ cc: ['evil@evil.local', 'EVIL@evil.local'] })),
    ).rejects.toMatchObject({
      code: 'recipient_not_allowed',
      details: { addresses: ['evil@evil.local'] },
    });
    expect(smtp.sent).toHaveLength(0);
    expect(store.listAudit('agent')[0]).toMatchObject({
      action: 'send_rejected',
      result: 'rejected',
    });
  });

  it('decodes attachments and enforces the size limit', async () => {
    const { ctx, smtp } = createTestContext({ max_attachment_mb: 0.001, review: { rules: 'off' } });
    const small = Buffer.from('abc').toString('base64');
    await sendMessage(
      ctx,
      input({
        attachments: [{ filename: 'a.txt', content_type: 'text/plain', content_base64: small }],
      }),
    );
    expect((await parseMessage(smtp.sent[0]!.raw)).attachments[0]?.content.toString()).toBe('abc');
    const big = Buffer.alloc(2000).toString('base64');
    await expect(
      sendMessage(
        ctx,
        input({
          attachments: [
            { filename: 'b.bin', content_type: 'application/octet-stream', content_base64: big },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'attachment_too_large' });
  });

  it('threads replies to an allowed message', async () => {
    const { ctx, imap, smtp } = createTestContext();
    const uid = imap.add(
      await buildRaw({
        from: 'boss@test.local',
        subject: 'Report',
        messageId: '<orig@test.local>',
      }),
    );
    await sendMessage(ctx, input({ subject: 'Report', reply_to_id: `1-${uid}` }));
    const parsed = await parseMessage(smtp.sent[0]!.raw);
    expect(parsed.subject).toBe('Re: Report');
    expect(parsed.references).toContain('<orig@test.local>');
    expect(smtp.sent[0]!.raw.toString()).toContain('In-Reply-To: <orig@test.local>');
  });

  it('rate limits per hour (0 = unlimited)', async () => {
    let now = 1_000_000;
    const { ctx } = createTestContext(
      { max_sends_per_hour: 2, review: { rules: 'off' } },
      { now: () => now },
    );
    await sendMessage(ctx, input());
    now += 1000;
    await sendMessage(ctx, input());
    await expect(sendMessage(ctx, input())).rejects.toMatchObject({
      code: 'rate_limited',
      details: { retry_after_seconds: 3599 },
    });
    now += 3_600_000;
    await expect(sendMessage(ctx, input())).resolves.toBeTruthy();

    const unlimited = createTestContext({ max_sends_per_hour: 0, review: { rules: 'off' } }).ctx;
    for (let i = 0; i < 5; i++) await sendMessage(unlimited, input());
  });

  it('reports smtp failure as send_failed and does not copy to Sent', async () => {
    const { ctx, smtp, imap, store } = createTestContext();
    smtp.fail = true;
    await expect(sendMessage(ctx, input())).rejects.toMatchObject({ code: 'send_failed' });
    expect(imap.sent).toHaveLength(0);
    expect(store.listAudit('agent')[0]).toMatchObject({ action: 'send', result: 'error' });
  });

  it('warns but succeeds when the Sent copy fails', async () => {
    const { ctx, imap } = createTestContext();
    imap.failAppend = true;
    expect((await sendMessage(ctx, input())).warnings).toEqual(['copy_to_sent_failed']);
  });
});
