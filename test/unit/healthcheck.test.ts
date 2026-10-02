import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { healthUrl } from '../../src/healthcheck.js';

const config = (port: string) => `
server:
  port: ${port}
mailboxes:
  - name: a
    address: a@example.com
    api_key: \${KEY}
    imap: { host: h, port: 993, security: tls }
    smtp: { host: h, port: 465, security: tls }
    username: u
    password: p
`;

describe('healthUrl', () => {
  it('uses the configured port', () => {
    const dir = mkdtempSync(join(tmpdir(), 'amg-hc-'));
    writeFileSync(join(dir, 'c.yaml'), config('9000'));
    expect(healthUrl({ CONFIG_PATH: join(dir, 'c.yaml'), KEY: 'k'.repeat(32) })).toBe(
      'http://127.0.0.1:9000/health',
    );
  });

  it('falls back to 8080 when the config cannot be read', () => {
    expect(healthUrl({ CONFIG_PATH: '/nope' })).toBe('http://127.0.0.1:8080/health');
  });
});
