# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
