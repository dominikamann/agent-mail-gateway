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
