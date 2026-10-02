import { describe, expect, it } from 'vitest';
import { cancelEvent, createEvent, listEvents, updateEvent } from '../../src/services/events.js';
import { createTestContext } from '../helpers/fakes.js';

const unfold = (s: string) => s.replace(/\r?\n[ \t]/g, '');
const ics = (raw: Buffer) => unfold(raw.toString());

const base = {
  title: 'Planning',
  start: '2026-10-05T14:00',
  end: '2026-10-05T15:00',
  attendees: ['boss@test.local'],
  location: 'Office',
};

describe('events', () => {
  it('creates an invite in the mailbox time zone and stores it', async () => {
    const { ctx, smtp } = createTestContext({ timezone: 'Europe/Berlin' });
    const ev = await createEvent(ctx, base);
    expect(ev).toMatchObject({
      title: 'Planning',
      start: '2026-10-05T12:00:00.000Z',
      sequence: 0,
      status: 'active',
      timezone: 'Europe/Berlin',
    });
    const raw = smtp.sent[0]!.raw;
    expect(raw.toString()).toContain('Invitation: Planning');
    expect(ics(raw)).toContain(`UID:${ev.id}@test.local`);
    expect(ics(raw)).toMatch(/METHOD:REQUEST/);
    expect(listEvents(ctx)).toHaveLength(1);
  });

  it('rejects disallowed attendees and end before start without sending', async () => {
    const { ctx, smtp } = createTestContext();
    await expect(createEvent(ctx, { ...base, attendees: ['x@evil.local'] })).rejects.toMatchObject({
      code: 'recipient_not_allowed',
    });
    await expect(createEvent(ctx, { ...base, end: '2026-10-05T13:00' })).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(smtp.sent).toHaveLength(0);
    expect(listEvents(ctx)).toHaveLength(0);
  });

  it('updates with a higher sequence and cancels removed attendees', async () => {
    const { ctx, smtp } = createTestContext();
    const ev = await createEvent(ctx, {
      ...base,
      attendees: ['boss@test.local', 'a@partner.local'],
    });
    const updated = await updateEvent(ctx, ev.id, {
      start: '2026-10-05T16:00',
      end: '2026-10-05T17:00',
      attendees: ['boss@test.local'],
    });
    expect(updated.sequence).toBe(1);
    const [, request, cancel] = smtp.sent;
    expect(request!.envelope.to).toEqual(['boss@test.local']);
    expect(ics(request!.raw)).toContain('SEQUENCE:1');
    expect(ics(request!.raw)).toContain('DTSTART:20261005T160000Z');
    expect(cancel!.envelope.to).toEqual(['a@partner.local']);
    expect(ics(cancel!.raw)).toContain('METHOD:CANCEL');
  });

  it('cancels for all attendees and refuses further changes', async () => {
    const { ctx, smtp } = createTestContext();
    const ev = await createEvent(ctx, base);
    const cancelled = await cancelEvent(ctx, ev.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', sequence: 1 });
    expect(ics(smtp.sent[1]!.raw)).toContain('STATUS:CANCELLED');
    await expect(updateEvent(ctx, ev.id, { title: 'x' })).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(cancelEvent(ctx, 'nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('does not see events of other mailboxes', async () => {
    const a = createTestContext();
    const ev = await createEvent(a.ctx, base);
    const b = createTestContext({
      name: 'other',
      address: 'other@test.local',
      api_key: 'o'.repeat(32),
    });
    await expect(
      updateEvent({ ...b.ctx, store: a.store }, ev.id, { title: 'x' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
