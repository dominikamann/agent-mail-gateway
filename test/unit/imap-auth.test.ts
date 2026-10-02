import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ImapFlowMailbox } from '../../src/mail/imap.js';
import { testMailboxConfig } from '../helpers/config.js';
import { silentLogger } from '../helpers/wait.js';

/** Minimal IMAP server that rejects every login, counting the attempts. */
function rejectingImap(): Promise<{ port: number; logins: () => number; close: () => void }> {
  let logins = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl = buffer.indexOf('\r\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const [tag, cmd] = line.split(' ');
        if (cmd?.toUpperCase() === 'CAPABILITY') {
          socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK done\r\n`);
        } else if (cmd?.toUpperCase() === 'LOGIN' || cmd?.toUpperCase() === 'AUTHENTICATE') {
          logins++;
          socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        } else if (cmd?.toUpperCase() === 'LOGOUT') {
          socket.end(`* BYE\r\n${tag} OK bye\r\n`);
        } else if (tag) {
          socket.write(`${tag} BAD unknown\r\n`);
        }
        nl = buffer.indexOf('\r\n');
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as { port: number }).port,
        logins: () => logins,
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

describe('IMAP authentication failures', () => {
  it('does not hammer the server with logins (fail2ban)', async () => {
    const srv = await rejectingImap();
    cleanups.push(srv.close);
    const mb = new ImapFlowMailbox(
      testMailboxConfig({ imap: { host: '127.0.0.1', port: srv.port, security: 'none' } }),
      silentLogger,
    );
    cleanups.push(() => mb.stop());
    await mb.start();
    await new Promise((r) => setTimeout(r, 8000));
    expect(srv.logins()).toBe(1);
    expect(mb.state()).toBe('error');
  }, 15_000);
});
