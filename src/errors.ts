export type ErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'recipient_not_allowed'
  | 'delete_not_allowed'
  | 'attachment_too_large'
  | 'rate_limited'
  | 'validation_error'
  | 'mailbox_unavailable'
  | 'send_failed';

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  recipient_not_allowed: 403,
  delete_not_allowed: 403,
  attachment_too_large: 413,
  rate_limited: 429,
  validation_error: 400,
  mailbox_unavailable: 503,
  send_failed: 502,
};

export class GatewayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GatewayError';
  }

  get status(): number {
    return STATUS[this.code];
  }
}
