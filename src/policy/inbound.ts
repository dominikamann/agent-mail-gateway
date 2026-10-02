import type { MailboxConfig } from '../config/schema.js';
import { isAllowed } from './address.js';
import { evaluateSenderAuth } from './sender-auth.js';

export type InboundDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'sender_not_allowed' | 'sender_auth_failed' | 'sender_auth_missing';
    };

export function decideInbound(
  cfg: Pick<MailboxConfig, 'allow_receive_from' | 'require_sender_auth'>,
  msg: { from: string | null; authResults: string[] },
): InboundDecision {
  if (!msg.from || !isAllowed(msg.from, cfg.allow_receive_from)) {
    return { allowed: false, reason: 'sender_not_allowed' };
  }
  if (!cfg.require_sender_auth) return { allowed: true };
  const auth = evaluateSenderAuth(msg.authResults, msg.from);
  if (auth === 'pass') return { allowed: true };
  return {
    allowed: false,
    reason: auth === 'missing' ? 'sender_auth_missing' : 'sender_auth_failed',
  };
}
