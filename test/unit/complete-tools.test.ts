import { describe, expect, it } from 'vitest';
import { buildIcs } from '../../src/calendar/ics.js';
import { parseIcs } from '../../src/calendar/parse-ics.js';
import { parseMessage } from '../../src/mail/parse.js';
import { forwardMessage, replyMessage, respondToInvitation } from '../../src/services/compose.js';
import { createEvent, getEvent } from '../../src/services/events.js';
import { getMessage, listMessages } from '../../src/services/messages.js';
import { InboundWatcher } from '../../src/watcher/watcher.js';
import { createTestContext } from '../helpers/fakes.js';
import { buildRaw } from '../helpers/mail.js';

const unfold = (s: string) => s.replace(/\r?\n[ \t]/g, '');

async function invitationRaw(
  method: 'REQUEST' | 'REPLY',
  opts: { from?: string; uid?: string; partstat?: string; attendee?: string } = {},
) {
  let ics = buildIcs({
    uid: opts.uid ?? 'meeting-1@partner.local',
    sequence: 2,
    method: 'REQUEST',
    organizer: 'x@partner.local',
    attendees: [opts.attendee ?? 'agent@test.local'],
    title: 'Planning',
    start: new Date('2026-10-10T12:00:00Z'),
    end: new Date('2026-10-10T13:00:00Z'),
    location: 'Room 1',
    description: 'Agenda',
  });
  if (method === 'REPLY') {
    ics = ics
      .replace('METHOD:REQUEST', 'METHOD:REPLY')
      .replace(/PARTSTAT=NEEDS-ACTION/, `PARTSTAT=${opts.partstat ?? 'ACCEPTED'}`);
  }
  return buildRaw({
    from: opts.from ?? 'x@partner.local',
    subject: method === 'REQUEST' ? 'Invitation: Planning' : 'Accepted: Planning',
    text: 'See invitation',
    attachments: [
      { filename: 'invite.ics', content: ics, contentType: `text/calendar; method=${method}` },
    ],
  });
}

describe('search', () => {
  it('filters by text, sender, subject and date range', async () => {
    const { ctx, imap } = createTestContext();
    imap.add(
      await buildRaw({ from: 'boss@test.local', subject: 'Invoice 42', text: 'Please pay' }),
      false,
      new Date('2026-09-01T10:00:00Z'),
    );
    imap.add(
      await buildRaw({ from: 'x@partner.local', subject: 'Lunch', text: 'Pizza on Friday?' }),
      false,
      new Date('2026-09-20T10:00:00Z'),
    );
    imap.add(
      await buildRaw({ from: 'stranger@evil.local', subject: 'Pizza deal', text: 'Pizza!' }),
      false,
      new Date('2026-09-21T10:00:00Z'),
    );
    const subjects = async (q: Parameters<typeof listMessages>[1]) =>
      (await listMessages(ctx, q)).messages.map((m) => m.subject);
    expect(await subjects({ limit: 10, text: 'pizza' })).toEqual(['Lunch']);
    expect(await subjects({ limit: 10, from: 'boss@test.local' })).toEqual(['Invoice 42']);
    expect(await subjects({ limit: 10, subject: 'invoice' })).toEqual(['Invoice 42']);
    expect(await subjects({ limit: 10, before: new Date('2026-09-10T00:00:00Z') })).toEqual([
      'Invoice 42',
    ]);
  });
});

describe('reply and forward', () => {
  it('replies to the sender in the same thread', async () => {
    const { ctx, imap, smtp } = createTestContext();
    const uid = imap.add(
      await buildRaw({
        from: 'Boss <boss@test.local>',
        to: 'agent@test.local',
        subject: 'Numbers?',
        text: 'Send the Q3 numbers',
        messageId: '<q@test.local>',
      }),
    );
    await replyMessage(ctx, `1-${uid}`, {
      body_markdown: 'Here they are: 42.',
      reply_all: false,
      attachments: [],
    });
    const sent = await parseMessage(smtp.sent[0]!.raw);
    expect(smtp.sent[0]!.envelope.to).toEqual(['boss@test.local']);
    expect(sent.subject).toBe('Re: Numbers?');
    expect(sent.references).toContain('<q@test.local>');
  });

  it('honours Reply-To and reply_all without the own address', async () => {
    const { ctx, imap, smtp } = createTestContext();
    const raw = await buildRaw({
      from: 'boss@test.local',
      to: 'agent@test.local, a@partner.local',
      subject: 'Plan',
      text: 'Thoughts?',
      headers: { 'Reply-To': 'b@partner.local', Cc: 'c@partner.local' },
    });
    const uid = imap.add(raw);
    await replyMessage(ctx, `1-${uid}`, {
      body_markdown: 'Looks good to me.',
      reply_all: true,
      attachments: [],
    });
    expect(smtp.sent[0]!.envelope.to.sort()).toEqual([
      'a@partner.local',
      'b@partner.local',
      'c@partner.local',
    ]);
  });

  it('a reply still respects the allow list', async () => {
    const { ctx, imap, smtp } = createTestContext({
      allow_receive_from: ['*@evil.local'],
      allow_send_to: ['boss@test.local'],
    });
    const uid = imap.add(
      await buildRaw({ from: 'stranger@evil.local', subject: 'Hi', text: 'Hello' }),
    );
    await expect(
      replyMessage(ctx, `1-${uid}`, {
        body_markdown: 'Hello back to you.',
        reply_all: false,
        attachments: [],
      }),
    ).rejects.toMatchObject({ code: 'recipient_not_allowed' });
    expect(smtp.sent).toHaveLength(0);
  });

  it('forwards with a note, the original text and its attachments', async () => {
    const { ctx, imap, smtp } = createTestContext();
    const uid = imap.add(
      await buildRaw({
        from: 'x@partner.local',
        subject: 'Contract',
        text: 'Contract attached',
        attachments: [{ filename: 'c.pdf', content: 'PDF', contentType: 'application/pdf' }],
      }),
    );
    await forwardMessage(ctx, `1-${uid}`, {
      to: ['boss@test.local'],
      cc: [],
      bcc: [],
      body_markdown: 'FYI, please review the contract.',
      include_attachments: true,
    });
    const sent = await parseMessage(smtp.sent[0]!.raw);
    expect(sent.subject).toBe('Fwd: Contract');
    expect(sent.bodyMarkdown).toContain('FYI, please review the contract.');
    expect(sent.bodyMarkdown).toContain('Contract attached');
    expect(sent.bodyMarkdown).toContain('Forwarded message');
    expect(sent.bodyMarkdown).toContain('x@partner.local');
    expect(sent.attachments.map((a) => a.filename)).toEqual(['c.pdf']);
  });
});

describe('review of forwards and quotes', () => {
  it('only checks the agent own text, not the forwarded original', async () => {
    const { ctx, imap, smtp } = createTestContext();
    const uid = imap.add(
      await buildRaw({
        from: 'x@partner.local',
        subject: 'Contract',
        text: 'Contract attached. TODO: sign',
        attachments: [{ filename: 'c.pdf', content: 'PDF', contentType: 'application/pdf' }],
      }),
    );
    await forwardMessage(ctx, `1-${uid}`, {
      to: ['boss@test.local'],
      cc: [],
      bcc: [],
      body_markdown: 'FYI, the text of the contract mail below.',
      include_attachments: false,
    });
    expect(smtp.sent).toHaveLength(1);
  });
});

describe('events', () => {
  it('get_event returns one event, and not_found for others', async () => {
    const { ctx } = createTestContext();
    const ev = await createEvent(ctx, {
      title: 'T',
      start: '2026-10-10T12:00:00Z',
      end: '2026-10-10T13:00:00Z',
      attendees: ['boss@test.local'],
    });
    expect(getEvent(ctx, ev.id)).toMatchObject({ id: ev.id, title: 'T', responses: {} });
    expect(() => getEvent(ctx, 'nope')).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('records attendee responses to own invitations', async () => {
    const { ctx, imap } = createTestContext();
    const ev = await createEvent(ctx, {
      title: 'T',
      start: '2026-10-10T12:00:00Z',
      end: '2026-10-10T13:00:00Z',
      attendees: ['x@partner.local'],
    });
    const w = new InboundWatcher(ctx);
    await w.processNew();
    imap.add(
      await invitationRaw('REPLY', {
        uid: `${ev.id}@test.local`,
        partstat: 'DECLINED',
        attendee: 'x@partner.local',
      }),
    );
    await w.processNew();
    expect(getEvent(ctx, ev.id).responses).toEqual({ 'x@partner.local': 'declined' });
  });
});

describe('received invitations', () => {
  it('parses iCalendar data', () => {
    const ics = buildIcs({
      uid: 'u@x',
      sequence: 3,
      method: 'REQUEST',
      organizer: 'o@x.de',
      attendees: ['me@x.de'],
      title: 'Sync; weekly',
      start: new Date('2026-10-10T12:00:00Z'),
      end: new Date('2026-10-10T13:00:00Z'),
      location: 'Room, 2',
      description: 'Line 1\nLine 2',
    });
    expect(parseIcs(ics)).toMatchObject({
      method: 'REQUEST',
      uid: 'u@x',
      sequence: 3,
      title: 'Sync; weekly',
      start: '2026-10-10T12:00:00.000Z',
      end: '2026-10-10T13:00:00.000Z',
      location: 'Room, 2',
      organizer: 'o@x.de',
      attendees: [{ email: 'me@x.de', status: 'needs-action' }],
    });
    expect(
      parseIcs(
        'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART;TZID=Europe/Berlin:20261010T140000\r\nDTEND;VALUE=DATE:20261011\r\nEND:VEVENT\r\nEND:VCALENDAR',
      ),
    ).toMatchObject({
      start: '2026-10-10T12:00:00.000Z',
      end: '2026-10-11',
    });
    expect(parseIcs('not a calendar')).toBeNull();
  });

  it('read_message shows the invitation; respond_to_invitation answers the organizer', async () => {
    const { ctx, imap, smtp } = createTestContext();
    const uid = imap.add(await invitationRaw('REQUEST'));
    const msg = await getMessage(ctx, `1-${uid}`, false);
    expect(msg.invitation).toMatchObject({
      method: 'REQUEST',
      title: 'Planning',
      organizer: 'x@partner.local',
      start: '2026-10-10T12:00:00.000Z',
    });

    await respondToInvitation(ctx, `1-${uid}`, 'accept', 'See you there.');
    expect(smtp.sent[0]!.envelope.to).toEqual(['x@partner.local']);
    const ics = unfold(smtp.sent[0]!.raw.toString());
    expect(ics).toMatch(/text\/calendar;[^\n]*method=REPLY/i);
    expect(ics).toContain('UID:meeting-1@partner.local');
    expect(ics).toMatch(/ATTENDEE[^\n]*PARTSTAT=ACCEPTED[^\n]*mailto:agent@test.local/i);
    expect((await parseMessage(smtp.sent[0]!.raw)).subject).toBe('Accepted: Planning');
  });

  it('respond_to_invitation fails for mails without an invitation', async () => {
    const { ctx, imap } = createTestContext();
    const uid = imap.add(await buildRaw({ from: 'boss@test.local', text: 'no invite here' }));
    await expect(respondToInvitation(ctx, `1-${uid}`, 'decline')).rejects.toMatchObject({
      code: 'validation_error',
    });
  });
});
