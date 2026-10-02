import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import type { MailboxConfig, MailboxConfigInput } from '../../src/config/schema.js';
import { testMailboxConfig } from '../helpers/config.js';

export interface GreenMail {
  host: string;
  smtpPort: number;
  imapPort: number;
  stop(): Promise<void>;
  mailboxConfig(user: string, overrides?: Partial<MailboxConfigInput>): MailboxConfig;
  deliver(from: string, to: string, raw: Buffer): Promise<void>;
  client(user: string): Promise<ImapFlow>;
  count(user: string, folder: string): Promise<number>;
}

export async function startGreenMail(): Promise<GreenMail> {
  const container: StartedTestContainer = await new GenericContainer('greenmail/standalone:2.1.14')
    .withEnvironment({
      GREENMAIL_OPTS: [
        '-Dgreenmail.setup.test.smtp',
        '-Dgreenmail.setup.test.imap',
        '-Dgreenmail.hostname=0.0.0.0',
        '-Dgreenmail.users=agent:secret@test.local,boss:secret@test.local,stranger:secret@evil.local',
        '-Dgreenmail.users.login=email',
      ].join(' '),
    })
    .withExposedPorts(3025, 3143)
    .start();
  const host = container.getHost();
  const smtpPort = container.getMappedPort(3025);
  const imapPort = container.getMappedPort(3143);

  const gm: GreenMail = {
    host,
    smtpPort,
    imapPort,
    stop: async () => {
      await container.stop();
    },
    mailboxConfig(user, overrides = {}) {
      return testMailboxConfig({
        name: user.split('@')[0],
        address: user,
        username: user,
        imap: { host, port: imapPort, security: 'none' },
        smtp: { host, port: smtpPort, security: 'none' },
        ...overrides,
      });
    },
    async deliver(from, to, raw) {
      const t = nodemailer.createTransport({
        host,
        port: smtpPort,
        secure: false,
        ignoreTLS: true,
        auth: { user: from, pass: 'secret' },
      });
      await t.sendMail({ envelope: { from, to: [to] }, raw });
      t.close();
    },
    async client(user) {
      const c = new ImapFlow({
        host,
        port: imapPort,
        secure: false,
        doSTARTTLS: false,
        auth: { user, pass: 'secret' },
        logger: false,
      });
      await c.connect();
      return c;
    },
    async count(user, folder) {
      const c = await gm.client(user);
      try {
        const s = await c.status(folder, { messages: true });
        return s ? (s.messages ?? 0) : 0;
      } finally {
        await c.logout();
      }
    },
  };
  return gm;
}
