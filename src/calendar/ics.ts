import ical, {
  ICalAttendeeRole,
  ICalAttendeeStatus,
  ICalCalendarMethod,
  ICalEventStatus,
} from 'ical-generator';

export interface IcsInput {
  uid: string;
  sequence: number;
  method: 'REQUEST' | 'CANCEL';
  organizer: string;
  attendees: string[];
  title: string;
  start: Date;
  end: Date;
  location: string | null;
  description: string | null;
}

export function buildIcs(input: IcsInput): string {
  const calendar = ical({
    prodId: { company: 'agent-mail-gateway', product: 'gateway', language: 'EN' },
    method: input.method === 'REQUEST' ? ICalCalendarMethod.REQUEST : ICalCalendarMethod.CANCEL,
  });
  calendar.createEvent({
    id: input.uid,
    sequence: input.sequence,
    stamp: new Date(),
    start: input.start,
    end: input.end,
    summary: input.title,
    location: input.location ?? undefined,
    description: input.description ?? undefined,
    status: input.method === 'CANCEL' ? ICalEventStatus.CANCELLED : ICalEventStatus.CONFIRMED,
    organizer: { name: input.organizer, email: input.organizer },
    attendees: input.attendees.map((email) => ({
      email,
      rsvp: true,
      role: ICalAttendeeRole.REQ,
      status: ICalAttendeeStatus.NEEDSACTION,
    })),
  });
  return calendar.toString();
}

export interface ReplyIcsInput {
  uid: string;
  sequence: number;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  organizer: string;
  attendee: string;
  partstat: 'ACCEPTED' | 'DECLINED' | 'TENTATIVE';
  comment: string | null;
}

/** iCalendar REPLY telling the organizer whether we attend. */
export function buildReplyIcs(input: ReplyIcsInput): string {
  const status = {
    ACCEPTED: ICalAttendeeStatus.ACCEPTED,
    DECLINED: ICalAttendeeStatus.DECLINED,
    TENTATIVE: ICalAttendeeStatus.TENTATIVE,
  }[input.partstat];
  const calendar = ical({
    prodId: { company: 'agent-mail-gateway', product: 'gateway', language: 'EN' },
    method: ICalCalendarMethod.REPLY,
  });
  calendar.createEvent({
    id: input.uid,
    sequence: input.sequence,
    stamp: new Date(),
    start: new Date(input.start),
    end: input.end ? new Date(input.end) : undefined,
    allDay: input.allDay,
    summary: input.title,
    description: input.comment ?? undefined,
    organizer: { name: input.organizer, email: input.organizer },
    attendees: [{ email: input.attendee, status, role: ICalAttendeeRole.REQ }],
  });
  return calendar.toString();
}
