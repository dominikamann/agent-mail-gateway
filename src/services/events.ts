import { randomUUID } from 'node:crypto';
import { buildIcs } from '../calendar/ics.js';
import { formatInZone, toUtc } from '../calendar/time.js';
import { GatewayError } from '../errors.js';
import { isAllowed, normalizeAddress } from '../policy/address.js';
import { reviewEvent } from '../review/review.js';
import type { EventRecord } from '../store/store.js';
import type { MailboxContext } from './context.js';
import { assertRecipientsAllowed, deliver, releaseSends, reserveSends } from './deliver.js';
import type { EventInput, EventPatch } from './schemas.js';

export interface EventView {
  id: string;
  title: string;
  start: string;
  end: string;
  timezone: string;
  location: string | null;
  description_markdown: string | null;
  attendees: string[];
  status: 'active' | 'cancelled';
  sequence: number;
  warnings?: string[];
}

function view(r: EventRecord, warnings?: string[]): EventView {
  return {
    id: r.id,
    title: r.title,
    start: r.start,
    end: r.end,
    timezone: r.timezone,
    location: r.location,
    description_markdown: r.description,
    attendees: r.attendees,
    status: r.status,
    sequence: r.sequence,
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}

function times(start: string, end: string, tz: string): { start: string; end: string } {
  const s = toUtc(start, tz);
  const e = toUtc(end, tz);
  if (e.getTime() <= s.getTime()) {
    throw new GatewayError('validation_error', 'end must be after start');
  }
  return { start: s.toISOString(), end: e.toISOString() };
}

function body(r: EventRecord): string {
  const lines = [
    `**${r.title}**`,
    '',
    `**When:** ${formatInZone(new Date(r.start), r.timezone)} – ${formatInZone(new Date(r.end), r.timezone)}`,
  ];
  if (r.location) lines.push(`**Where:** ${r.location}`);
  if (r.description) lines.push('', r.description);
  return lines.join('\n');
}

async function send(
  ctx: MailboxContext,
  r: EventRecord,
  method: 'REQUEST' | 'CANCEL',
  recipients: string[],
  subjectPrefix: string,
  action: 'event_create' | 'event_update' | 'event_cancel',
  reserved?: number,
): Promise<string[]> {
  const content = buildIcs({
    uid: r.uid,
    sequence: r.sequence,
    method,
    organizer: ctx.config.address,
    attendees: recipients,
    title: r.title,
    start: new Date(r.start),
    end: new Date(r.end),
    location: r.location,
    description: r.description,
  });
  const { warnings } = await deliver(
    ctx,
    {
      to: recipients,
      cc: [],
      bcc: [],
      subject: `${subjectPrefix}: ${r.title}`,
      markdown: body(r),
      attachments: [],
      icalEvent: { method, content },
    },
    action,
    reserved,
  );
  return warnings;
}

/** Splits attendees into those we may still write to and warnings for the rest. */
function reachable(ctx: MailboxContext, attendees: string[]): { to: string[]; warnings: string[] } {
  const to = attendees.filter((a) => isAllowed(a, ctx.config.allow_send_to));
  const warnings = attendees.filter((a) => !to.includes(a)).map((a) => `cancel_not_sent:${a}`);
  return { to, warnings };
}

function reviewOf(ctx: MailboxContext, r: EventRecord): Promise<string[]> {
  return reviewEvent(ctx, {
    attendees: r.attendees,
    start: new Date(r.start),
    headerLines: [
      `Title: ${r.title}`,
      `When: ${formatInZone(new Date(r.start), r.timezone)} – ${formatInZone(new Date(r.end), r.timezone)}`,
      ...(r.location ? [`Where: ${r.location}`] : []),
      `Attendees: ${r.attendees.join(', ')}`,
    ],
    description: r.description ?? '',
  });
}

function load(ctx: MailboxContext, id: string): EventRecord {
  const r = ctx.store.getEvent(ctx.config.name, id);
  if (!r) throw new GatewayError('not_found', 'Event not found');
  if (r.status === 'cancelled') throw new GatewayError('validation_error', 'Event is cancelled');
  return r;
}

export async function createEvent(ctx: MailboxContext, input: EventInput): Promise<EventView> {
  const attendees = [...new Set(input.attendees.map(normalizeAddress))];
  assertRecipientsAllowed(ctx, attendees);
  const tz = input.timezone ?? ctx.config.timezone;
  const id = randomUUID();
  const now = ctx.now();
  const rec: EventRecord = {
    id,
    mailbox: ctx.config.name,
    uid: `${id}@${ctx.config.address.split('@')[1]}`,
    sequence: 0,
    status: 'active',
    title: input.title,
    ...times(input.start, input.end, tz),
    timezone: tz,
    location: input.location ?? null,
    description: input.description_markdown ?? null,
    attendees,
    createdAt: now,
    updatedAt: now,
  };
  const reviewWarnings = await reviewOf(ctx, rec);
  const warnings = [
    ...reviewWarnings,
    ...(await send(ctx, rec, 'REQUEST', attendees, 'Invitation', 'event_create')),
  ];
  ctx.store.saveEvent(rec);
  return view(rec, warnings);
}

export async function updateEvent(
  ctx: MailboxContext,
  id: string,
  patch: EventPatch,
): Promise<EventView> {
  const old = load(ctx, id);
  const tz = patch.timezone ?? old.timezone;
  const attendees = patch.attendees
    ? [...new Set(patch.attendees.map(normalizeAddress))]
    : old.attendees;
  assertRecipientsAllowed(ctx, attendees);
  const rec: EventRecord = {
    ...old,
    title: patch.title ?? old.title,
    ...times(patch.start ?? old.start, patch.end ?? old.end, tz),
    timezone: tz,
    location: patch.location ?? old.location,
    description: patch.description_markdown ?? old.description,
    attendees,
    sequence: old.sequence + 1,
    updatedAt: ctx.now(),
  };
  const removed = reachable(
    ctx,
    old.attendees.filter((a) => !attendees.includes(a)),
  );
  // Reserve the update and the cancellation together so a parallel send cannot take a slot.
  const reviewWarnings = await reviewOf(ctx, rec);
  const [requestSlot, cancelSlot] = reserveSends(ctx, removed.to.length > 0 ? 2 : 1);

  let warnings: string[];
  try {
    warnings = await send(
      ctx,
      rec,
      'REQUEST',
      attendees,
      'Updated invitation',
      'event_update',
      requestSlot,
    );
  } catch (err) {
    releaseSends(ctx, [cancelSlot]);
    throw err;
  }
  ctx.store.saveEvent(rec);
  warnings.unshift(...reviewWarnings);
  warnings.push(...removed.warnings);
  if (removed.to.length > 0) {
    try {
      warnings.push(
        ...(await send(ctx, rec, 'CANCEL', removed.to, 'Cancelled', 'event_cancel', cancelSlot)),
      );
    } catch (err) {
      ctx.log.warn(
        { mailbox: ctx.config.name, err: (err as Error).message },
        'cancel to removed attendees failed',
      );
      warnings.push('cancel_failed');
    }
  }
  return view(rec, warnings);
}

export async function cancelEvent(ctx: MailboxContext, id: string): Promise<EventView> {
  const old = load(ctx, id);
  const rec: EventRecord = {
    ...old,
    status: 'cancelled',
    sequence: old.sequence + 1,
    updatedAt: ctx.now(),
  };
  const { to, warnings } = reachable(ctx, rec.attendees);
  if (to.length > 0) {
    warnings.push(...(await send(ctx, rec, 'CANCEL', to, 'Cancelled', 'event_cancel')));
  }
  ctx.store.saveEvent(rec);
  return view(rec, warnings);
}

export function listEvents(ctx: MailboxContext): EventView[] {
  return ctx.store.listEvents(ctx.config.name).map((r) => view(r));
}
