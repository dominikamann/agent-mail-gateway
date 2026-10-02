import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { cancelEvent, createEvent, listEvents, updateEvent } from '../../services/events.js';
import { eventPatchSchema, eventSchema } from '../../services/schemas.js';
import { mailboxOf } from '../auth.js';

const idParams = z.object({ id: z.string() });
const tags = ['events'];

export const eventRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/events',
    { schema: { tags, summary: 'Events created by this mailbox' } },
    async (req) => ({
      events: listEvents(mailboxOf(req)),
    }),
  );

  app.post(
    '/events',
    { schema: { tags, summary: 'Send a calendar invitation', body: eventSchema } },
    async (req, reply) => {
      reply.status(201);
      return createEvent(mailboxOf(req), req.body);
    },
  );

  app.patch(
    '/events/:id',
    {
      schema: {
        tags,
        summary: 'Update an event and notify attendees',
        params: idParams,
        body: eventPatchSchema,
      },
    },
    async (req) => updateEvent(mailboxOf(req), req.params.id, req.body),
  );

  app.delete(
    '/events/:id',
    { schema: { tags, summary: 'Cancel an event', params: idParams } },
    async (req) => cancelEvent(mailboxOf(req), req.params.id),
  );
};
