import { isValidTimeZone } from '../config/schema.js';
import { toUtc } from './time.js';

export interface ParsedIcs {
  method: string | null;
  uid: string;
  sequence: number;
  title: string;
  /** ISO date-time in UTC, or YYYY-MM-DD for all-day events. */
  start: string | null;
  end: string | null;
  allDay: boolean;
  location: string | null;
  description: string | null;
  organizer: string | null;
  status: string | null;
  attendees: { email: string; status: string | null }[];
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): Prop | null {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (line[i] === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [name = '', ...rawParams] = line.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

const unescapeText = (v: string) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const mailto = (v: string) =>
  v
    .replace(/^mailto:/i, '')
    .trim()
    .toLowerCase();

function parseDate(p: Prop): { value: string; allDay: boolean } | null {
  const v = p.value.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m || p.params.VALUE === 'DATE') {
    m ??= /^(\d{4})(\d{2})(\d{2})/.exec(v);
    return m ? { value: `${m[1]}-${m[2]}-${m[3]}`, allDay: true } : null;
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  try {
    if (m[7]) return { value: new Date(`${local}Z`).toISOString(), allDay: false };
    const tz = p.params.TZID && isValidTimeZone(p.params.TZID) ? p.params.TZID : 'UTC';
    return { value: toUtc(local, tz).toISOString(), allDay: false };
  } catch {
    return null;
  }
}

/** Reads the first event of an iCalendar text. Returns null if there is none. */
export function parseIcs(text: string): ParsedIcs | null {
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
  let method: string | null = null;
  let inEvent = false;
  let done = false;
  const ev: Partial<ParsedIcs> & { attendees: ParsedIcs['attendees'] } = { attendees: [] };

  for (const line of lines) {
    const p = parseLine(line.trim());
    if (!p) continue;
    if (p.name === 'METHOD' && !inEvent) method = p.value.trim().toUpperCase();
    else if (p.name === 'BEGIN' && p.value.trim().toUpperCase() === 'VEVENT' && !done)
      inEvent = true;
    else if (p.name === 'END' && p.value.trim().toUpperCase() === 'VEVENT' && inEvent) {
      inEvent = false;
      done = true;
    } else if (inEvent) {
      switch (p.name) {
        case 'UID':
          ev.uid = p.value.trim();
          break;
        case 'SEQUENCE':
          ev.sequence = Number.parseInt(p.value, 10) || 0;
          break;
        case 'SUMMARY':
          ev.title = unescapeText(p.value);
          break;
        case 'LOCATION':
          ev.location = unescapeText(p.value);
          break;
        case 'DESCRIPTION':
          ev.description = unescapeText(p.value);
          break;
        case 'STATUS':
          ev.status = p.value.trim().toLowerCase();
          break;
        case 'ORGANIZER':
          ev.organizer = mailto(p.value);
          break;
        case 'ATTENDEE':
          ev.attendees.push({
            email: mailto(p.value),
            status: p.params.PARTSTAT ? p.params.PARTSTAT.toLowerCase() : null,
          });
          break;
        case 'DTSTART': {
          const d = parseDate(p);
          ev.start = d?.value ?? null;
          ev.allDay = d?.allDay ?? false;
          break;
        }
        case 'DTEND': {
          ev.end = parseDate(p)?.value ?? null;
          break;
        }
      }
    }
  }
  if (!done || !ev.uid) return null;
  return {
    method,
    uid: ev.uid,
    sequence: ev.sequence ?? 0,
    title: ev.title ?? '',
    start: ev.start ?? null,
    end: ev.end ?? null,
    allDay: ev.allDay ?? false,
    location: ev.location ?? null,
    description: ev.description ?? null,
    organizer: ev.organizer ?? null,
    status: ev.status ?? null,
    attendees: ev.attendees,
  };
}
