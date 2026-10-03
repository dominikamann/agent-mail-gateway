import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import type { Config } from './config/schema.js';
import { buildApp } from './http/app.js';
import { ImapFlowMailbox } from './mail/imap.js';
import { createSmtpSender } from './mail/smtp.js';
import type { MailboxContext } from './services/context.js';
import { Gateway } from './services/gateway.js';
import { Store } from './store/store.js';
import { VERSION } from './version.js';
import { InboundWatcher } from './watcher/watcher.js';
import { WebhookDispatcher } from './webhook/dispatcher.js';

export async function startGateway(
  config: Config,
  opts: { listen?: boolean; port?: number } = {},
): Promise<{ app: FastifyInstance; gateway: Gateway; stop(): Promise<void> }> {
  const log = pino({
    level: config.server.log_level,
    redact: [
      'password',
      'api_key',
      'secret',
      '*.password',
      '*.api_key',
      '*.secret',
      'req.headers.authorization',
    ],
  });
  mkdirSync(config.server.data_dir, { recursive: true });
  const store = new Store(join(config.server.data_dir, 'gateway.sqlite'));

  const contexts: MailboxContext[] = config.mailboxes.map((mb) => {
    const mbLog = log.child({ mailbox: mb.name });
    return {
      config: mb,
      imap: new ImapFlowMailbox(mb, mbLog),
      smtp: createSmtpSender(mb),
      store,
      log: mbLog,
      now: Date.now,
    };
  });
  const gateway = new Gateway(contexts);
  const app = await buildApp(gateway, { loggerInstance: log });

  // Connect in the background so the API and /health are available immediately,
  // even while a mail server is slow or unreachable.
  for (const c of contexts) void c.imap.start();
  const watchers = contexts.map((c) => new InboundWatcher(c));
  for (const w of watchers) w.start();
  const dispatcher = new WebhookDispatcher({
    store,
    mailboxes: new Map(config.mailboxes.map((m) => [m.name, m])),
    log,
  });
  dispatcher.start();
  store.prune(Date.now());
  const pruneTimer = setInterval(() => store.prune(Date.now()), 3_600_000);
  pruneTimer.unref();

  if (opts.listen !== false) {
    await app.listen({ host: '0.0.0.0', port: opts.port ?? config.server.port });
  }
  log.info(
    { version: VERSION, mailboxes: config.mailboxes.map((m) => m.name) },
    'agent-mail-gateway started',
  );

  return {
    app,
    gateway,
    async stop() {
      clearInterval(pruneTimer);
      await app.close();
      await Promise.all(watchers.map((w) => w.stop()));
      await dispatcher.stop();
      await Promise.all(contexts.map((c) => c.imap.stop()));
      for (const c of contexts) c.smtp.close();
      store.close();
    },
  };
}
