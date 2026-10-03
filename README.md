# Agent Mail Gateway

[![CI](https://github.com/dominikamann/agent-mail-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/dominikamann/agent-mail-gateway/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/dominikamann/agent-mail-gateway)](https://github.com/dominikamann/agent-mail-gateway/releases)
[![Docker image](https://img.shields.io/badge/docker-ghcr.io-blue?logo=docker)](https://github.com/dominikamann/agent-mail-gateway/pkgs/container/agent-mail-gateway)
[![MCP server on Glama](https://glama.ai/mcp/servers/dominikamann/agent-mail-gateway/badges/score.svg)](https://glama.ai/mcp/servers/dominikamann/agent-mail-gateway)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Give every AI agent its own email address — without giving it the keys to the mailbox.**

Agent Mail Gateway is a small self-hosted service (one Docker container) that sits between your
AI agents and ordinary mailboxes on your existing mail server. Each agent gets **one API key for
exactly one mailbox**. Through the gateway it can read and answer mail, send attachments and
manage calendar invitations — but only with the people you allow, and every outgoing message is
checked before it leaves.

Agents talk to it over **MCP** (Model Context Protocol) or a plain **REST API**. Mail arrives as
**Markdown** instead of HTML, which saves a lot of tokens.

---

## Why

Giving an agent the IMAP/SMTP password of a mailbox means it can read everything, write to
anyone, and a single prompt injection in an incoming email can make it leak data or spam people.
The gateway keeps the password to itself and enforces your rules on every request:

| Without the gateway | With the gateway |
|---|---|
| Agent knows the mailbox password | Agent only has an API key for its mailbox |
| Reads every mail, incl. spam and phishing | Sees only mail from senders you allow |
| Can write to anyone | Can only write to recipients you allow |
| Sloppy or wrong mails go out | Every mail is checked before sending (rules, optional LLM, your policies) |
| HTML mails cost thousands of tokens | Mail arrives as compact Markdown |

## Features

**Mailbox access**
- List, search, read, mark, delete; attachments in and out.
- Reply (incl. reply-all) and forward — the gateway fills in recipients, `Re:`/`Fwd:` and threading.
- HTML → Markdown for reading, Markdown → HTML for sending.

**Calendar**
- Send, update and cancel invitations; they update cleanly in Outlook, Gmail and Apple Calendar.
- See who accepted or declined your invitations.
- Read invitations you receive and accept, decline or tentatively accept them.

**Control and safety**
- Allow lists per mailbox for who the agent may receive mail from and write to
  (`name@domain` or `*@domain`). Everything else is invisible to the agent and moved to Trash
  (or kept).
- Forged senders are rejected (SPF/DKIM/DMARC as checked by your mail server).
- Send limit per hour, audit log of every send, rejection and deletion.
- No fast retries on wrong passwords, so your server's fail2ban never blocks the gateway.

**Review before sending** (details [below](#review-before-sending))
- Built-in rules catch empty mails, attachment-only mails, "see attached" without attachment,
  leftover placeholders and accidental duplicates — on by default.
- Optional LLM review (e.g. a local model in Ollama) for "is this mail complete and sensible?".
- Optional **policies**: your own rules in plain language, for everyone or for specific
  recipients — e.g. *"never share financial information"*, *"never mention gifts to Alex"*.

**Integration**
- MCP over Streamable HTTP, a stdio bridge for stdio-only clients, and a REST API with
  OpenAPI docs at `/docs`.
- Signed webhooks when new mail arrives (compatible with Hermes Agent webhook routes).
- [Hermes Agent](https://hermes-agent.nousresearch.com/) plugin with a skill that teaches the
  agent how to use its mailbox.
- Works with any IMAP/SMTP server: Plesk, IONOS, Outlook, Postfix/Dovecot, …

## How it works

```
 Agent ──MCP / REST + API key──▶ ┌────────────────────────────────────────┐
                                 │ Auth       key → exactly one mailbox   │
 Agent ◀──signed webhook──────── │ Policy     who may write / be written  │
                                 │ Review     rules · LLM · your policies │
                                 │ Converter  HTML ⇄ Markdown             │
                                 │ Calendar   invitations and replies     │
                                 │ Mailbox    IMAP + instant new-mail push│──IMAP──▶ your mail server
                                 │ Sender     SMTP + copy to "Sent"       │──SMTP──▶
                                 └────────────────────────────────────────┘
                                   config.yaml + .env (read-only)
```

Mail stays on your mail server; the gateway only keeps a small SQLite file with its own state.

## Quick start

> **Use a dedicated mailbox for each agent** (for example `assistant@yourmailserver.eu`), not your
> personal one: by default, mail from senders that are not on the allow list is moved to Trash.

1. Get the files:
   ```bash
   mkdir agent-mail-gateway && cd agent-mail-gateway
   curl -LO https://raw.githubusercontent.com/dominikamann/agent-mail-gateway/main/docker-compose.yml
   curl -L -o config.yaml https://raw.githubusercontent.com/dominikamann/agent-mail-gateway/main/config.example.yaml
   curl -L -o .env https://raw.githubusercontent.com/dominikamann/agent-mail-gateway/main/.env.example
   ```
2. Edit `config.yaml`: one entry per agent with its mail server, login and allow lists.
3. Put the secrets into `.env` (`openssl rand -hex 32` makes a good API key).
4. Start it and check:
   ```bash
   docker compose up -d
   curl http://localhost:8080/health
   curl -H "Authorization: Bearer <the AGENT_API_KEY from .env>" http://localhost:8080/v1/mailbox
   ```

A minimal mailbox entry:

```yaml
mailboxes:
  - name: assistant
    address: youragent@yourmailserver.eu
    api_key: ${AGENT_API_KEY}
    imap: { host: mail.yourmailserver.eu, port: 993, security: tls }
    smtp: { host: mail.yourmailserver.eu, port: 465, security: tls }
    username: youragent@yourmailserver.eu
    password: ${AGENT_MAIL_PASSWORD}
    allow_receive_from: [you@yourmailserver.eu, "*@yourcompany.eu"]
    allow_send_to: [you@yourmailserver.eu]
```

Every option is explained in [docs/configuration.md](docs/configuration.md).

## Review before sending

Agents are sometimes sloppy — an email with only an attachment, "please find attached" without
a file, `Hello {name}`. The gateway checks every outgoing email and invitation **before** it is
sent. If something is wrong, nothing is sent and the agent gets a clear error with the reasons
(`review_rejected`), so it can fix the message and try again. Rejected attempts don't count
towards the send limit.

There are three layers; you choose per mailbox:

| Layer | Default | What it does |
|---|---|---|
| **Rules** | on (`block`) | Fixed checks without AI: empty text, only an attachment, missing subject, attachment mentioned but missing, leftover placeholders, the same mail twice within 10 minutes, invitations in the past. |
| **LLM review** | off | Asks a language model whether the message is complete and makes sense (e.g. does the reply actually answer the question?). |
| **Policies** | off | Your own rules in plain language, checked by the language model — for all recipients or only for specific ones. |

Rules and the LLM review can block the message, only warn (send anyway and report it), or be
switched off; each policy rule either blocks or warns. The check covers new mails, replies,
forwards, invitations and their changes, and comments in invitation answers.

```yaml
    review:
      rules: block                       # block | warn | off
      llm:                               # any OpenAI-compatible endpoint, e.g. a local Ollama
        url: http://ollama:11434/v1
        model: llama3.1:8b
        mode: warn                       # quality check: warn | block | off
      policies:
        mode: block                      # what a violation does: block | warn
        rules:
          - rule: Never share financial information such as revenue, prices, invoices, bank details or salaries.
          - rule: Never mention gifts, presents or surprise plans.
            recipients: [alex@yourmailserver.eu]
          - rule: Never send calendar invitations.
            recipients: [sam@yourmailserver.eu]
```

A rule with `recipients` applies only when one of those people receives the message (To, Cc,
Bcc or invitation attendee). With [Ollama](https://ollama.com) the review runs entirely on your
own machine; no mail content leaves your server. Long messages are checked in parts — nothing
is cut off; part size and limits are configurable to fit your model's context window. The built-in review prompt can be replaced or
extended — see [docs/configuration.md](docs/configuration.md#review-before-sending).

## Using it

### MCP tools

Point any MCP client at `http://<host>:8080/mcp` with the header
`Authorization: Bearer <api key>`, or use the [stdio bridge](docs/stdio.md).

| Tool | What it does |
|---|---|
| `get_mailbox_info` | Own address, allow lists and limits |
| `list_messages` / `search_messages` | Received mail, newest first; search by text, sender, subject, date |
| `read_message` | One message as Markdown, incl. attachments list and received invitations |
| `get_attachment` | Download an attachment |
| `mark_message` / `delete_message` | Mark read/unread; move to Trash (if allowed) |
| `send_message` | Send a new email (Markdown, attachments) |
| `reply_message` / `forward_message` | Reply (or reply-all) in the thread; forward with attachments |
| `create_event` / `update_event` / `cancel_event` | Send, change and cancel invitations |
| `list_events` / `get_event` | Own events with attendee responses |
| `respond_to_invitation` | Accept, decline or tentatively accept a received invitation |

### REST

```bash
# send a message
curl -X POST http://localhost:8080/v1/messages \
  -H "Authorization: Bearer $AGENT_API_KEY" -H "Content-Type: application/json" \
  -d '{"to":["you@yourmailserver.eu"],"subject":"Daily report","body_markdown":"All **green** today."}'

# unread mail
curl -H "Authorization: Bearer $AGENT_API_KEY" "http://localhost:8080/v1/messages?unread=true"
```

All endpoints, error codes and the webhook format: [docs/api.md](docs/api.md).

### Hermes Agent

Connect the MCP server in `~/.hermes/config.yaml` and install the plugin that teaches your
agents to use their mailbox safely:

```bash
hermes plugins install dominikamann/agent-mail-gateway/integrations/hermes/agent-mail-gateway --enable
```

Step by step, including waking the agent on new mail: [docs/hermes.md](docs/hermes.md).

## Documentation

- [Configuration](docs/configuration.md) — every option, allow lists, review, ports, sender authentication
- [REST API, webhooks and MCP tools](docs/api.md)
- [Hermes Agent integration and plugin](docs/hermes.md)
- [stdio clients](docs/stdio.md)
- [Security model](docs/security.md)
- [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

[![Agent Mail Gateway on Glama](https://glama.ai/mcp/servers/dominikamann/agent-mail-gateway/badges/card.svg)](https://glama.ai/mcp/servers/dominikamann/agent-mail-gateway)

## Security

Run the gateway on a private network or behind a reverse proxy with TLS — API keys travel in
the `Authorization` header. Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

---

<p align="center">Proudly provided by <a href="https://amannlabs.eu">amannlabs.eu</a></p>
