import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { asGatewayError, GatewayError } from '../errors.js';

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  const known = asGatewayError(err);
  if (known) err = known;
  if (err instanceof GatewayError) {
    const retry = err.details.retry_after_seconds;
    if (typeof retry === 'number') reply.header('retry-after', String(retry));
    return reply
      .status(err.status)
      .send({ error: err.code, message: err.message, details: err.details });
  }
  if (hasZodFastifySchemaValidationErrors(err)) {
    return reply.status(400).send({
      error: 'validation_error',
      message: 'Request validation failed',
      details: {
        issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      },
    });
  }
  const fe = err as FastifyError;
  if (fe.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return reply
      .status(413)
      .send({ error: 'attachment_too_large', message: 'Request body too large', details: {} });
  }
  if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
    return reply
      .status(fe.statusCode)
      .send({ error: 'validation_error', message: fe.message, details: {} });
  }
  req.log.error({ err: fe.message }, 'unhandled error');
  return reply
    .status(500)
    .send({ error: 'internal_error', message: 'Internal error', details: {} });
}
