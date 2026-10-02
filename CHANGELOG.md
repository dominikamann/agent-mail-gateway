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
