import { describe, expect, it } from 'vitest';
import { parseMessage } from '../../src/mail/parse.js';
import { composeMail } from '../../src/mail/smtp.js';

describe('composeMail', () => {
  it('builds a message with html, text, threading headers, attachments and no Bcc header', async () => {
    const { raw, messageId } = await composeMail({
      from: 'agent@example.com',
      to: ['boss@test.local'],
      cc: [],
      bcc: ['hidden@test.local'],
      subject: 'Re: Report',
      html: '<p>Hi</p>',
      text: 'Hi',
      inReplyTo: '<m1@example.net>',
      references: ['<m0@example.net>', '<m1@example.net>'],
      attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('abc') }],
    });
    const text = raw.toString();
    expect(messageId).toMatch(/^<.+@example\.com>$/);
    expect(text).toContain('In-Reply-To: <m1@example.net>');
    expect(text).not.toMatch(/^Bcc:/im);
    const parsed = await parseMessage(raw);
    expect(parsed.messageId).toBe(messageId);
    expect(parsed.attachments[0]?.filename).toBe('a.txt');
  });

  it('embeds a calendar part', async () => {
    const { raw } = await composeMail({
      from: 'agent@example.com',
      to: ['boss@test.local'],
      cc: [],
      bcc: [],
      subject: 'Invite',
      html: '<p>x</p>',
      text: 'x',
      attachments: [],
      icalEvent: {
        method: 'REQUEST',
        content: 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR',
      },
    });
    expect(raw.toString()).toMatch(/text\/calendar;[^\n]*method=REQUEST/i);
  });
});
