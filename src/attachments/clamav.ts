import { connect } from 'node:net';
import type { MailboxConfig } from '../config/schema.js';

export type ClamavConfig = NonNullable<MailboxConfig['attachments']['clamav']>;

export type ScanResult = { infected: false } | { infected: true; signature: string };

const CHUNK = 64 * 1024;

/**
 * Scans bytes with clamd's INSTREAM command (TCP). Throws when clamd is unreachable, times out
 * or answers with an error (e.g. the file exceeds its StreamMaxLength).
 */
export function clamScan(cfg: ClamavConfig, content: Buffer): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: cfg.host, port: cfg.port });
    const replies: Buffer[] = [];
    let settled = false;
    const done = (err: Error | null, result?: ScanResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(result!);
    };
    socket.setTimeout(cfg.timeout_seconds * 1000, () => done(new Error('clamd timed out')));
    socket.on('error', (err) => done(err));
    socket.on('data', (d: Buffer) => replies.push(d));
    socket.on('end', () => finish());
    socket.on('close', () => finish());

    function finish() {
      const reply = Buffer.concat(replies).toString('utf8').replace(/\0/g, '').trim();
      if (/:\s*OK$/.test(reply)) return done(null, { infected: false });
      const found = /:\s*(.+?)\s+FOUND$/.exec(reply);
      if (found) return done(null, { infected: true, signature: found[1]! });
      done(new Error(reply ? `clamd: ${reply}` : 'clamd closed the connection'));
    }

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let i = 0; i < content.length; i += CHUNK) {
        const part = content.subarray(i, i + CHUNK);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(part.length);
        socket.write(size);
        socket.write(part);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}
