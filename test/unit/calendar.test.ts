import { describe, expect, it } from 'vitest';
import { buildIcs } from '../../src/calendar/ics.js';
import { formatInZone, toUtc } from '../../src/calendar/time.js';

const unfold = (s: string) => s.replace(/\r?\n[ \t]/g, '');

describe('toUtc', () => {
  it('keeps explicit offsets', () => {
    expect(toUtc('2026-10-05T14:00:00+02:00', 'UTC').toISOString()).toBe(
      '2026-10-05T12:00:00.000Z',
    );
    expect(toUtc('2026-10-05T14:00:00Z', 'Europe/Berlin').toISOString()).toBe(
      '2026-10-05T14:00:00.000Z',
    );
  });

  it('interprets local times in the given zone, including DST', () => {
    expect(toUtc('2026-10-05T14:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-10-05T12:00:00.000Z',
    );
    expect(toUtc('2026-12-05T14:00:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-12-05T13:00:00.000Z',
    );
  });

  it('rejects garbage', () => {
    expect(() => toUtc('tomorrow', 'UTC')).toThrow(/date-time/);
  });

  it('formats in a zone', () => {
    expect(formatInZone(new Date('2026-10-05T12:00:00Z'), 'Europe/Berlin')).toContain('14:00');
  });
});

describe('buildIcs', () => {
  const base = {
    uid: 'abc@example.com',
    sequence: 0,
    method: 'REQUEST' as const,
    organizer: 'agent@example.com',
    attendees: ['boss@test.local'],
    title: 'Planning',
    start: new Date('2026-10-05T12:00:00Z'),
    end: new Date('2026-10-05T13:00:00Z'),
    location: 'Office',
    description: 'Agenda',
  };

  it('builds a REQUEST with uid, sequence, organizer and attendee', () => {
    const ics = unfold(buildIcs(base));
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('UID:abc@example.com');
    expect(ics).toContain('SEQUENCE:0');
    expect(ics).toMatch(/ORGANIZER[^\n]*mailto:agent@example.com/i);
    expect(ics).toMatch(/ATTENDEE[^\n]*mailto:boss@test.local/i);
    expect(ics).toContain('SUMMARY:Planning');
    expect(ics).toContain('DTSTART:20261005T120000Z');
  });

  it('builds a CANCEL with status cancelled', () => {
    const ics = unfold(buildIcs({ ...base, method: 'CANCEL', sequence: 2 }));
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).toContain('SEQUENCE:2');
  });
});
