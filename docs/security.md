# Security model

## Assumptions

- **The operator is trusted.** Whoever controls `config.yaml`, `.env` and the host controls
  every mailbox.
- **Agents are not trusted.** An agent may be confused, prompt-injected by incoming mail, or
  buggy. The gateway limits what it can do even then.

## What the gateway guarantees

- **One key, one mailbox.** Keys are compared in constant time; a key maps to exactly one
  mailbox and there is no way to address another one.
- **Agents never see mailbox credentials.** IMAP/SMTP passwords stay in the gateway.
- **Inbound filtering.** Mail from senders outside `allow_receive_from` — or failing sender
  authentication when `require_sender_auth` is on — is never returned by any endpoint or tool,
  including direct reads by id (`404`). By default it is moved to Trash.
- **Outbound enforcement.** Every recipient and attendee must be on `allow_send_to`; a single
  violation rejects the entire request.
- **Rate limit.** `max_sends_per_hour` stops a looping agent from sending floods.
- **Sanitised output.** Markdown written by agents is rendered and sanitised before sending;
  scripts and dangerous links are stripped. Incoming HTML is converted to Markdown, never
  passed through.
- **No secrets or content in logs.** Passwords, API keys, webhook secrets, message bodies and
  attachments are never logged. The audit log records time, mailbox, action, counterpart
  addresses and result.
- **Signed webhooks** (HMAC-SHA256 with timestamp) that carry only the message id, sender,
  subject, date and a 200-character preview — never the full body or attachments.
- **Blocked mail is never downloaded.** Policy is decided on the headers alone; bodies of
  filtered messages are not fetched, and messages with unparsable headers count as filtered.
  The one exception: a calendar reply (up to 1 MB) from an attendee of one of the mailbox's
  own events (sender-authenticated when `require_sender_auth` is on) is read to record their answer — the message itself stays hidden.
- **Bounded work per request.** Message and description texts are limited to 512,000
  characters, at most 20 attachments per message, and the send limit is checked before any
  review model is called.

## Sender spoofing

The `From` header can be forged. With `require_sender_auth: true` (default) the gateway relies
on the SPF/DKIM/DMARC verdict your receiving mail server writes into `Authentication-Results`.
This is only as good as that server's checks. If your server does not add the header you must
disable the option, and allow-lists then trust the `From` header as-is.

## Deployment advice

- Expose the gateway only on internal networks, or behind a reverse proxy with TLS. API keys
  travel in the `Authorization` header and must not cross networks in plain text.
- Generate keys with `openssl rand -hex 32` and rotate them by editing `.env` and restarting.
- Mount `config.yaml` read-only and keep `.env` out of version control.
- The container runs as a non-root user and only writes to `/data`.

## Reporting vulnerabilities

See [SECURITY.md](../SECURITY.md).
