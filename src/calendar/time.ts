import { isValidTimeZone } from '../config/schema.js';
import { GatewayError } from '../errors.js';

const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

function offsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return wall - Math.floor(date.getTime() / 1000) * 1000;
}

export function toUtc(input: string, timeZone: string): Date {
  if (!isValidTimeZone(timeZone)) {
    throw new GatewayError('validation_error', `Unknown time zone: ${timeZone}`);
  }
  if (WITH_OFFSET.test(input)) return new Date(input);
  if (!LOCAL.test(input)) {
    throw new GatewayError('validation_error', `Not an ISO 8601 date-time: ${input}`);
  }
  const asUtc = new Date(`${input}Z`);
  const first = offsetMs(asUtc, timeZone);
  const guess = new Date(asUtc.getTime() - first);
  const second = offsetMs(guess, timeZone);
  return second === first ? guess : new Date(asUtc.getTime() - second);
}

export function formatInZone(date: Date, timeZone: string): string {
  const text = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone,
  }).format(date);
  return `${text} (${timeZone})`;
}
