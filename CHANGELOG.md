# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.1]

### Fixed

- Comments in invitation answers (`respond_to_invitation`) go through the review and policies.
- Cancellations to removed attendees are reviewed against those attendees' policies.
- Malformed policy answers from the model (e.g. unknown rule numbers) count as a failed check
  (fail closed) instead of "no violation".
- Everything written by the agent or by others is passed to the model as JSON inside markers
  with a random nonce, so mail text cannot pose as instructions to the reviewer.
- Recipient-scoped policies also match sub-addresses (`alex+x@…`).
- Attendee answers are only accepted from the attendee themself and for the current version;
  they are cleared when the time changes.
- Received invitations with Outlook/Exchange (Windows) time zone names are read correctly;
  unknown zones are flagged as `timezone_unknown`.
- iCalendar text unescaping and quoted parameters with semicolons.

## [0.2.0]

### Added

- Review before sending. Stage 1 (on by default): rules for empty bodies, attachment-only
  mails, missing subjects, mentioned-but-missing attachments, leftover placeholders, duplicate
  sends and invitations in the past. Stage 2 (off by default): an LLM reviewer on any
  OpenAI-compatible endpoint such as Ollama, in `warn` or `block` mode, with a built-in prompt
  that can be replaced (`prompt`) or extended (`instructions`). Rejections return
  `review_rejected` (422) with reasons and do not count towards the send limit.
- Policies: own rules in plain language per mailbox, optionally only for specific recipients,
  checked by the configured model (`review.policies`, fail-closed by default).
- `search_messages` and search filters (`text`, `from`, `subject`, `before`) for listing.
- `reply_message` (incl. reply-all, honours Reply-To) and `forward_message` (with attachments).
- `get_event` with attendee responses; responses to own invitations are recorded automatically.
- Received invitations are shown in `read_message`; `respond_to_invitation` accepts, declines
  or tentatively accepts them with a standard calendar reply.

## [0.1.4]

### Fixed

- A wrong IMAP or SMTP password no longer causes repeated login attempts that get the
  gateway's IP banned (fail2ban). Rejected IMAP logins are retried after 15/30/60 minutes;
  SMTP pauses logins for 15 minutes. Network errors still reconnect quickly.

## [0.1.3]

### Added

- stdio entry point `dist/stdio.js` for clients that cannot speak HTTP. It bridges to a running
  gateway with the agent's own key (`AGENT_MAIL_URL`, `AGENT_MAIL_API_KEY`) and never reads the
  gateway configuration. Without a URL it runs in preview mode (tools listed, calls explain how
  to connect), which MCP directories use for inspection.
- `glama.json` naming the maintainer.

## [0.1.2]

### Added

- Webhooks are also signed in the generic V2 scheme (`X-Webhook-Timestamp`,
  `X-Webhook-Signature-V2`) and carry `event_type`, so Hermes Agent webhook routes accept them
  directly. Existing `X-Gateway-*` headers are unchanged.

## [0.1.1]

### Fixed

- Messages with oversized or unparsable headers are filtered (and audited) instead of breaking
  the mailbox listing.
- HTML conversion runs in bounded time for any input (deep nesting, unclosed tags).
- Listing and the watcher decide on headers only; bodies of blocked mail are never downloaded,
  and large messages are listed without a preview.
- `dmarc=none` (no DMARC policy) no longer rejects mail with an aligned DKIM/SPF pass.
- `since` filters on the arrival time instead of the sender's `Date` header.
- `next_cursor` always points at a returned message.
- Invalid dates such as `2026-02-30` are rejected with `validation_error`.
- Event updates reserve the cancellation send together with the update.
- The webhook dispatcher stops between deliveries on shutdown; docs now say at-least-once.
- A failed copy to Sent is retried only when the folder is missing, never stored twice.
- The Docker healthcheck follows `server.port`; compose binds to localhost by default.
- Releases run the full test suite first; pre-release tags no longer move `latest`.

### Added

- `trusted_authserv_id` to only trust `Authentication-Results` from your own mail server.
- Published to the official MCP Registry on every release.

## [0.1.0]

### Added

- Multiple IMAP/SMTP mailboxes, each bound to one API key.
- Per-mailbox allow lists for receiving and sending; non-allowed mail moved to Trash or kept.
- Sender authentication via `Authentication-Results` (SPF/DKIM/DMARC).
- HTML → Markdown for reading, Markdown → HTML for sending; attachments both ways.
- Calendar invitations with update and cancel.
- REST API with OpenAPI docs, MCP server over Streamable HTTP.
- Signed webhooks with persistent retries; IMAP IDLE with polling fallback.
- Send rate limit, audit log, health endpoint, Docker image.
- Hermes Agent plugin with the `agent-mail` skill.

### Hardening

- The API and `/health` are available immediately, even while a mail server is slow or down.
- Clean shutdown: in-flight webhook deliveries and mailbox checks finish before exit.
- Attachments are served with `nosniff` and a sandbox CSP.
- Renamed or deleted Sent/Trash folders are detected again without a restart.
- Stopping the watcher also stops reacting to new-mail notifications.
- `since` accepts plain dates in MCP too, and filters by exact time instead of whole days.
- Hostile HTML can no longer stall mail processing; conversion time is bounded.
- Messages with several `From` headers or a DMARC result for another domain are rejected.
- The send limit holds under parallel requests.
- Event updates check capacity first and are saved as soon as the update is sent.
