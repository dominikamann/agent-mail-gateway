import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Gateway } from '../services/gateway.js';
import { VERSION } from '../version.js';
import { authenticate } from './auth.js';
import { errorHandler } from './errors.js';
import { eventRoutes } from './routes/events.js';
import { registerHealth } from './routes/health.js';
import { mailboxRoutes } from './routes/mailbox.js';
import { messageRoutes } from './routes/messages.js';

export async function buildApp(
  gateway: Gateway,
  opts: { loggerInstance?: FastifyBaseLogger } = {},
): Promise<FastifyInstance> {
  const maxMb = Math.max(...gateway.contexts.map((c) => c.config.max_attachment_mb));
  const app = Fastify({
    loggerInstance: opts.loggerInstance,
    bodyLimit: Math.ceil(maxMb * 1024 * 1024 * 1.37) + 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.decorateRequest('mailbox', null);

  await app.register(swagger, {
    openapi: {
      info: { title: 'Agent Mail Gateway', version: VERSION },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  registerHealth(app, gateway);

  await app.register(
    async (v1) => {
      v1.addHook('onRequest', async (req) => {
        req.mailbox = authenticate(gateway, req);
      });
      await v1.register(mailboxRoutes);
      await v1.register(messageRoutes);
      await v1.register(eventRoutes);
    },
    { prefix: '/v1' },
  );

  return app;
}
