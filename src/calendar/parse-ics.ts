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
  /** True if a time zone could not be identified; times were then read as UTC. */
  timezoneUnknown: boolean;
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
  // Split parameters on ';' outside of quoted values (e.g. CN="Doe; John").
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of line.slice(0, colon)) {
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  const [name = '', ...rawParams] = parts;
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

/** Windows (Outlook/Exchange) time zone names → IANA, from the CLDR windowsZones mapping. */
const WINDOWS_ZONES: Record<string, string> = {
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'e. europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kiev',
  'gtb standard time': 'Europe/Bucharest',
  'russian standard time': 'Europe/Moscow',
  'turkey standard time': 'Europe/Istanbul',
  'israel standard time': 'Asia/Jerusalem',
  'egypt standard time': 'Africa/Cairo',
  'south africa standard time': 'Africa/Johannesburg',
  'w. central africa standard time': 'Africa/Lagos',
  'arab standard time': 'Asia/Riyadh',
  'arabian standard time': 'Asia/Dubai',
  'iran standard time': 'Asia/Tehran',
  'pakistan standard time': 'Asia/Karachi',
  'india standard time': 'Asia/Kolkata',
  'se asia standard time': 'Asia/Bangkok',
  'china standard time': 'Asia/Shanghai',
  'singapore standard time': 'Asia/Singapore',
  'taipei standard time': 'Asia/Taipei',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'aus eastern standard time': 'Australia/Sydney',
  'e. australia standard time': 'Australia/Brisbane',
  'cen. australia standard time': 'Australia/Adelaide',
  'w. australia standard time': 'Australia/Perth',
  'new zealand standard time': 'Pacific/Auckland',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix',
  'pacific standard time': 'America/Los_Angeles',
  'alaskan standard time': 'America/Anchorage',
  'hawaiian standard time': 'Pacific/Honolulu',
  'atlantic standard time': 'America/Halifax',
  'canada central standard time': 'America/Regina',
  'sa pacific standard time': 'America/Bogota',
  'e. south america standard time': 'America/Sao_Paulo',
  'argentina standard time': 'America/Buenos_Aires',
  utc: 'UTC',
  'coordinated universal time': 'UTC',
};

/** IANA zone for a TZID: IANA as is, Windows names mapped, "/vendor/…/Europe/Berlin" prefixes stripped. */
function resolveZone(tzid: string): string | null {
  const id = tzid.trim();
  if (isValidTimeZone(id)) return id;
  const windows = WINDOWS_ZONES[id.toLowerCase()];
  if (windows) return windows;
  const segments = id.split('/').filter(Boolean);
  for (let k = Math.min(3, segments.length); k >= 1; k--) {
    const candidate = segments.slice(-k).join('/');
    if (candidate.includes('/') && isValidTimeZone(candidate)) return candidate;
  }
  return null;
}

// One pass, so an escaped backslash followed by "n" stays a backslash and an "n".
const unescapeText = (v: string) =>
  v.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
const mailto = (v: string) =>
  v
    .replace(/^mailto:/i, '')
    .trim()
    .toLowerCase();

function parseDate(
  p: Prop,
  floatingZone: string,
): { value: string; allDay: boolean; zoneUnknown?: boolean } | null {
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
    // "Floating" time without a zone: read it in the mailbox time zone.
    if (!p.params.TZID) return { value: toUtc(local, floatingZone).toISOString(), allDay: false };
    const tz = resolveZone(p.params.TZID);
    return {
      value: toUtc(local, tz ?? 'UTC').toISOString(),
      allDay: false,
      zoneUnknown: tz === null,
    };
  } catch {
    return null;
  }
}

/** ISO 8601 duration (P1DT2H30M, PT45M, P1W) in milliseconds, or null. */
function durationMs(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim(),
  );
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  const ms =
    ((Number(w ?? 0) * 7 + Number(d ?? 0)) * 86_400 +
      Number(h ?? 0) * 3600 +
      Number(mi ?? 0) * 60 +
      Number(s ?? 0)) *
    1000;
  return sign === '-' ? -ms : ms;
}

/**
 * Reads the first event of an iCalendar text. Returns null if there is none.
 * `floatingZone` is used for times that carry no time zone at all.
 */
export function parseIcs(text: string, floatingZone = 'UTC'): ParsedIcs | null {
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
  let method: string | null = null;
  let inEvent = false;
  let done = false;
  const ev: Partial<ParsedIcs> & { attendees: ParsedIcs['attendees']; duration?: number | null } = {
    attendees: [],
  };

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
          const d = parseDate(p, floatingZone);
          ev.start = d?.value ?? null;
          ev.allDay = d?.allDay ?? false;
          if (d?.zoneUnknown) ev.timezoneUnknown = true;
          break;
        }
        case 'DURATION': {
          ev.duration = durationMs(p.value);
          break;
        }
        case 'DTEND': {
          const d = parseDate(p, floatingZone);
          ev.end = d?.value ?? null;
          if (d?.zoneUnknown) ev.timezoneUnknown = true;
          break;
        }
      }
    }
  }
  if (!done || !ev.uid) return null;
  if (!ev.end && ev.start && ev.duration != null && !ev.allDay) {
    ev.end = new Date(new Date(ev.start).getTime() + ev.duration).toISOString();
  }
  return {
    method,
    uid: ev.uid,
    sequence: ev.sequence ?? 0,
    title: ev.title ?? '',
    start: ev.start ?? null,
    end: ev.end ?? null,
    allDay: ev.allDay ?? false,
    timezoneUnknown: ev.timezoneUnknown ?? false,
    location: ev.location ?? null,
    description: ev.description ?? null,
    organizer: ev.organizer ?? null,
    status: ev.status ?? null,
    attendees: ev.attendees,
  };
}
