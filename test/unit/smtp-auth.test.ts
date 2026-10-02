import { createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_RETRY_MS, isAuthFailure } from '../../src/mail/imap.js';
import { createSmtpSender } from '../../src/mail/smtp.js';
import { testMailboxConfig } from '../helpers/config.js';

/** Minimal SMTP server that rejects every AUTH, counting the attempts. */
function rejectingSmtp(): Promise<{ port: number; auths: () => number; close: () => void }> {
  let auths = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk) => {
      for (const line of chunk.toString().split('\r\n').filter(Boolean)) {
        const cmd = line.split(' ')[0]!.toUpperCase();
        if (cmd === 'EHLO') socket.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (cmd === 'AUTH') {
          auths++;
          socket.write('535 5.7.8 Authentication credentials invalid\r\n');
        } else if (cmd === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as { port: number }).port,
        auths: () => auths,
        close: () => {
          for (const s of sockets) s.destroy();
          server.close();
        },
      }),
    ),
  );
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('authentication failures', () => {
  it('recognises auth errors, not network errors', () => {
    expect(isAuthFailure({ authenticationFailed: true })).toBe(true);
    expect(isAuthFailure({ serverResponseCode: 'AUTHENTICATIONFAILED' })).toBe(true);
    expect(isAuthFailure(new Error('Invalid credentials (Failure)'))).toBe(true);
    expect(isAuthFailure(new Error('connect ECONNREFUSED 127.0.0.1:993'))).toBe(false);
    expect(AUTH_RETRY_MS[0]).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it('SMTP stops logging in after a rejected login', async () => {
    const srv = await rejectingSmtp();
    cleanups.push(srv.close);
    const sender = createSmtpSender(
      testMailboxConfig({ smtp: { host: '127.0.0.1', port: srv.port, security: 'none' } }),
    );
    cleanups.push(() => sender.close());
    const raw = Buffer.from('From: a@b.c\r\nTo: d@e.f\r\nSubject: x\r\n\r\nx\r\n');
    for (let i = 0; i < 3; i++) {
      await expect(sender.send({ from: 'a@b.c', to: ['d@e.f'] }, raw)).rejects.toThrow();
    }
    expect(srv.auths()).toBe(1);
  });
});
