import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../../src/config/load.js';

const KEY = 'a'.repeat(32);
const base = (extra = '') => `
mailboxes:
  - name: assistant
    address: agent@example.com
    api_key: \${AGENT_KEY}
    imap: { host: mail.example.com, port: 993, security: tls }
    smtp: { host: mail.example.com, port: 465, security: tls }
    username: agent@example.com
    password: \${AGENT_PW}
    allow_receive_from: [you@example.net, "*@Example.org"]
    allow_send_to: [you@example.net]
${extra}`;
const env = { AGENT_KEY: KEY, AGENT_PW: 'pw' };

describe('parseConfig', () => {
  it('substitutes env vars, lowercases addresses and applies defaults', () => {
    const cfg = parseConfig(base(), env);
    const mb = cfg.mailboxes[0]!;
    expect(mb.api_key).toBe(KEY);
    expect(mb.password).toBe('pw');
    expect(mb.address).toBe('agent@example.com');
    expect(mb.allow_receive_from).toEqual(['you@example.net', '*@example.org']);
    expect(mb.non_allowed_action).toBe('delete');
    expect(mb.require_sender_auth).toBe(true);
    expect(mb.allow_delete).toBe(false);
    expect(mb.max_sends_per_hour).toBe(30);
    expect(mb.max_attachment_mb).toBe(15);
    expect(mb.timezone).toBe('UTC');
    expect(mb.poll_interval_seconds).toBe(300);
    expect(mb.folders).toEqual({});
    expect(cfg.server).toEqual({ port: 8080, log_level: 'info', data_dir: '/data' });
  });

  it('reports all missing env vars at once', () => {
    expect(() => parseConfig(base(), {})).toThrow(/AGENT_KEY, AGENT_PW/);
  });

  it('rejects unknown keys', () => {
    expect(() => parseConfig(base('    surprise: true'), env)).toThrow(ConfigError);
  });

  it('rejects short api keys', () => {
    expect(() => parseConfig(base(), { ...env, AGENT_KEY: 'short' })).toThrow(/api_key/);
  });

  it('rejects invalid address patterns', () => {
    const text = base().replace('"*@Example.org"', '"*.example.org"');
    expect(() => parseConfig(text, env)).toThrow(/email address or \*@domain/);
  });

  it('rejects invalid time zones', () => {
    expect(() => parseConfig(base('    timezone: Mars/Base'), env)).toThrow(/time zone/);
  });

  it('rejects duplicate api keys and names', () => {
    const text = `${base()}
  - name: assistant
    address: other@example.com
    api_key: \${AGENT_KEY}
    imap: { host: h, port: 993, security: tls }
    smtp: { host: h, port: 465, security: tls }
    username: u
    password: p
`;
    expect(() => parseConfig(text, env)).toThrow(
      /duplicate name.*duplicate api_key|duplicate api_key.*duplicate name/s,
    );
  });
});
