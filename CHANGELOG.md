# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.4]

### Changed

- The Docker image runs on Node.js 26 (base image `node:26-slim`); CI and release builds use
  Node.js 26 too. Node.js 24 is still supported when running from source.
- GitHub Actions updated to their current major versions.

### Documentation

- Security model: health endpoint, webhook isolation, duplicate protection and supply chain.

## [0.3.3]

### Fixed

- The duplicate check also catches the same message sent twice at the same time.
- Changes to the same event are applied one after another, so every update gets its own
  SEQUENCE and none is lost; attendee answers that arrive during an update are kept.
- Webhooks are delivered per mailbox in parallel: a slow or failing endpoint only delays its
  own mailbox.

### Changed

- `update_event` / `PATCH /v1/events/{id}`: `location` and `description_markdown` can be set to
  `null` to remove them.
- `/health` without a key only returns the overall status; mailbox names and states need a key
  (and show only that mailbox).
- GitHub Actions are pinned to commit SHAs and the Docker base image to a digest; Dependabot
  keeps them current.

## [0.3.2]

### Fixed

- Policies never fall back to the Markdown source for the rendered form: text that cannot be
  converted is tag-stripped with HTML entities decoded.
- Attachments the agent writes are policy-checked whenever their bytes are text, whatever the
  declared type; new `review.policies.binary_attachments: allow|block` for the others.
- Message and description texts are limited to 512,000 characters; texts the renderer cannot
  handle return `validation_error` instead of stalling or crashing.
- The send limit is checked before any review model is called.
- Invitations are policy-checked as the whole rendered mail (title, time, place, description).
- Forwarding drops `.ics` files by name as well as by type.
- Attendee answers are limited to the standard values.
- Webhooks do not follow redirects (the signed payload is never re-sent elsewhere).
- Old rows are pruned hourly (sends, fingerprints, audit after 180 days, finished webhooks after 30 days).
- Unexpected errors no longer reach the agent with internal details; a dropped IMAP connection
  returns `mailbox_unavailable` (503).
- Release workflow: least-privilege permissions per job, tag must match package.json and
  server.json, pinned mcp-publisher.
- `binary_attachments: block` only applies when a policy covers the recipients; files from
  received mail (forwarded or `from_message`) are policy-checked when they are text and never
  blocked as binary.
- Text attachments in Windows-1252 (e.g. CSV from Excel) are recognised as text.
- Unexpected MCP tool errors are logged for the operator.
- RSVP comments are limited to 20,000 characters; `duplicate_window_minutes` to 7 days.

### Changed

- Base64 attachments whose bytes are text are policy-checked whatever their declared type, so
  very large ones can now be rejected with `policy_too_long`.
- Webhook deliveries answered with a redirect (3xx) count as failed.

## [0.3.1]

### Fixed

- Policies check everything a recipient can read again: the source text (plain-text part and
  invitation description) as well as its rendered form, so content hidden in HTML comments,
  link definitions or image text is caught; invisible format characters are removed first.
- Text attachments written by the agent are checked by policies.
- Attachments: at most 20 per message; files from received messages are loaded once each and
  the size limit stops loading early; calendar files cannot be re-attached.
- Policy and quality prompts name the current data fields.
- Credentials in `review.llm.url` are detected with a URL parser.
- A failure while recording an invitee's answer no longer keeps a filtered mail in the inbox.
- `DURATION` for all-day invitations; zero or negative durations are ignored.
- Text attachments are returned in their declared charset.

## [0.3.0]

### Changed

- Policies check long messages in overlapping parts instead of cutting them off; a violation
  in any part blocks, more than `max_chunks` parts refuses to send. New settings
  `review.llm.chunk_chars`, `chunk_overlap_chars`, `max_chunks`.
- The review model sees the text as recipients will see it (rendered, entities decoded).
- Custom `review.llm.prompt`s now receive the message as JSON in nonce-marked data blocks
  (since 0.2.1) instead of `--- MESSAGE START ---` text.

### Changed (MCP)

- `search_messages` was merged into `list_messages` (same filters): one tool for listing and
  searching, 15 tools in total.
- Every tool has a title, MCP annotations (read-only / destructive / idempotent / open-world),
  a description that says when to use it instead of its siblings, its side effects and what it
  returns, and a description for every parameter.

### Added

- MCP server instructions with the essentials for any MCP client; every id/index argument
  is described.
- `get_mailbox_info` returns `now`, `now_local` and the active review setup incl. policies.
- Events and received invitations show `start_local` (and `end_local` for events).
- Attachments as `content_text` or `from_message`; `get_attachment` returns text files as text.
- Answers from invitees who are not on `allow_receive_from` are recorded (the mail itself stays
  filtered).
- `DURATION` in received invitations; times without a zone are read in the mailbox time zone.

### Fixed

- `review.llm.url` with credentials is rejected; error texts for the agent contain no hosts or URLs.
- Example config starts without the webhook secret; webhook path matches Hermes routes.
- Replies don't stack `Re:` on `AW:`, `SV:` etc.; moving only an event's start keeps its duration.

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
