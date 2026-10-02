import {
  type MailboxConfig,
  type MailboxConfigInput,
  mailboxSchema,
} from '../../src/config/schema.js';

export function testMailboxConfig(overrides: Partial<MailboxConfigInput> = {}): MailboxConfig {
  return mailboxSchema.parse({
    name: 'agent',
    address: 'agent@test.local',
    api_key: 'k'.repeat(32),
    imap: { host: '127.0.0.1', port: 3143, security: 'none' },
    smtp: { host: '127.0.0.1', port: 3025, security: 'none' },
    username: 'agent@test.local',
    password: 'secret',
    allow_receive_from: ['boss@test.local', '*@partner.local'],
    allow_send_to: ['boss@test.local', '*@partner.local'],
    require_sender_auth: false,
    ...overrides,
  });
}
