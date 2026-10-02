import type { MailboxConfig } from '../config/schema.js';
import type { ImapMailbox, Logger } from '../mail/imap.js';
import type { SmtpSender } from '../mail/smtp.js';
import type { AuditAction, AuditEntry, Store } from '../store/store.js';

export type { Logger } from '../mail/imap.js';

export interface MailboxContext {
  config: MailboxConfig;
  imap: ImapMailbox;
  smtp: SmtpSender;
  store: Store;
  log: Logger;
  now: () => number;
  /** HTTP client for the optional LLM review; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export function recordAudit(
  ctx: MailboxContext,
  action: AuditAction,
  counterparts: string[],
  result: AuditEntry['result'],
  detail?: string,
): void {
  const entry: AuditEntry = {
    at: ctx.now(),
    mailbox: ctx.config.name,
    action,
    counterparts,
    result,
    detail,
  };
  ctx.store.audit(entry);
  ctx.log.info({ audit: entry }, 'audit');
}
