# Agent Mail Gateway

[![CI](https://github.com/dominikamann/agent-mail-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/dominikamann/agent-mail-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Give every AI agent its own email mailbox — without giving it the keys to that mailbox.

*An open-source project by [amannlabs.eu](https://amannlabs.eu).*

Agent Mail Gateway is a small self-hosted Docker service that sits between your agents and
ordinary IMAP/SMTP mailboxes (Plesk, IONOS, Outlook, your own server — any provider). Each agent
gets **one API key bound to exactly one mailbox**. Through the gateway it can read mail, send
mail with attachments, and send, update or cancel calendar invitations. You decide **who each
agent may receive mail from and who it may write to**; everything else is filtered out.

Mail bodies are delivered to the agent as **Markdown** (converted from HTML) and the agent
writes Markdown that is sent as HTML — far fewer tokens than raw HTML email.

## Features

- **N mailboxes, one key each** — a key can never reach another mailbox.
- **Allow lists per mailbox** for receiving and sending (`name@domain` or `*@domain`).
- **Filtered mail is invisible** — not listed, not readable, not even by guessing an id.
  Non-allowed mail is moved to Trash (default) or left untouched.
- **Spoofing protection** — senders must pass SPF/DKIM/DMARC as reported by your mail server.
- **HTML ⇄ Markdown** conversion in both directions.
- **Attachments** in and out.
- **Calendar invites** (iCalendar) that update or cancel cleanly in Outlook, Gmail and Apple Calendar.
- **REST API** with OpenAPI docs at `/docs`, and an **MCP server** at `/mcp` with the same tools.
- **Webhooks** (HMAC-signed) when an allowed message arrives; new mail is detected instantly via IMAP IDLE.
- **Send rate limit** per mailbox and an **audit log** of every send, rejection and deletion.
- Works with **any IMAP/SMTP server**: TLS on 993/465 or STARTTLS on 143/587.

## How it works

```
 Agent ──REST/MCP + API key──▶ ┌──────────────────────────────────────┐
                               │ Auth      key → exactly one mailbox  │
 Agent ◀──signed webhook────── │ Policy    sender/recipient checks    │
                               │ Converter HTML ⇄ Markdown            │
                               │ Calendar  build/update/cancel .ics   │
                               │ Mailbox   IMAP read + IDLE watcher   │──IMAP──▶ mail server
                               │ Sender    SMTP + copy to Sent        │──SMTP──▶
                               │ Store     SQLite (small state)       │
                               └──────────────────────────────────────┘
                                 config.yaml + .env (read-only)
```

The gateway stores no mail content; mail stays on your mail server.

## Quick start

1. Get the files:
   ```bash
   mkdir agent-mail-gateway && cd agent-mail-gateway
   curl -LO https://raw.githubusercontent.com/dominikamann/agent-mail-gateway/main/docker-compose.yml
   curl -L -o config.yaml https://raw.githubusercontent.com/dominikamann/agent-mail-gateway/main/config.example.yaml
   curl -L -o .env https://raw.githubusercontent.com/dominikamann/agent-mail-gateway/main/.env.example
   ```
2. Edit `config.yaml`: one entry per agent with its mailbox server, login and allow lists.
3. Fill `.env` with the secrets referenced in `config.yaml`:
   ```bash
   openssl rand -hex 32   # an API key for each agent
   openssl rand -hex 24   # a webhook secret (optional)
   ```
4. Start it:
   ```bash
   docker compose up -d
   curl http://localhost:8080/health
   curl -H "Authorization: Bearer $AGENT_API_KEY" http://localhost:8080/v1/mailbox
   ```

Every option is explained in [docs/configuration.md](docs/configuration.md).

## Using it

**REST** — send a message:

```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "Authorization: Bearer $AGENT_API_KEY" -H "Content-Type: application/json" \
  -d '{"to":["you@example.net"],"subject":"Daily report","body_markdown":"All **green** today."}'
```

Read new mail:

```bash
curl -H "Authorization: Bearer $AGENT_API_KEY" "http://localhost:8080/v1/messages?unread=true"
```

**MCP** — point any MCP client at `http://<host>:8080/mcp` with the header
`Authorization: Bearer <api key>`. Tools: `get_mailbox_info`, `list_messages`, `read_message`,
`get_attachment`, `mark_message`, `delete_message`, `send_message`, `create_event`,
`update_event`, `cancel_event`, `list_events`.

See [docs/api.md](docs/api.md) for every endpoint, the webhook format and examples.

**Hermes Agent** — connect the MCP server in `~/.hermes/config.yaml` and install the plugin
that teaches your agents to use their mailbox safely:

```bash
hermes plugins install dominikamann/agent-mail-gateway/integrations/hermes/agent-mail-gateway --enable
```

Step by step: [docs/hermes.md](docs/hermes.md).

## Documentation

- [Configuration](docs/configuration.md)
- [REST API, webhooks and MCP tools](docs/api.md)
- [Hermes Agent integration and plugin](docs/hermes.md)
- [Security model](docs/security.md)
- [Contributing](CONTRIBUTING.md)

## Security

Run the gateway behind a TLS reverse proxy when it is reachable from other machines. Report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

---

<p align="center">Proudly provided by <a href="https://amannlabs.eu">amannlabs.eu</a></p>
