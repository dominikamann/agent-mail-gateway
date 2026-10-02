# Hermes Agent integration

Connecting a [Hermes Agent](https://hermes-agent.nousresearch.com/) to its mailbox takes three
steps: give the agent a mailbox in the gateway, connect the gateway as an MCP server, and
install the plugin that teaches the agent how to use it.

## 1. A mailbox per agent

Add one entry per agent to the gateway's `config.yaml` (see
[configuration.md](configuration.md)) with its own `api_key`. The key decides which mailbox the
agent works with, so never share a key between agents.

## 2. Connect the MCP server

Put the agent's key into the Hermes secret file of the profile that runs the agent,
`~/.hermes/.env` (or the profile's own `.env`):

```bash
AGENT_MAIL_API_KEY=<the api_key of this agent's mailbox>
```

Then add the gateway to that profile's `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  mail:
    url: "http://agent-mail-gateway:8080/mcp"
    headers:
      Authorization: "Bearer ${AGENT_MAIL_API_KEY}"
```

Hermes fills in `${AGENT_MAIL_API_KEY}` from the profile's `.env`; if the variable is missing,
the connection fails with a message naming it instead of sending a wrong key. The tools appear
as `mcp__mail__send_message`, `mcp__mail__list_messages` and so on.

Use the service name as host when Hermes and the gateway run in the same Docker network
(`http://agent-mail-gateway:8080/mcp`), `http://localhost:8080/mcp` on the same machine, and
an `https://` URL behind a reverse proxy otherwise. Hermes only allows plain HTTP for
localhost-style hosts in plugins; in `config.yaml` any URL works, but keep keys off
unencrypted networks.

Several agents in one Hermes installation: use one Hermes profile per agent, each with its own
`.env` key. The `mail` server name can stay the same in every profile.

## 3. Install the plugin

The plugin adds the `agent-mail` skill: when to check mail, how to reply in-thread, how to
handle calendar invites without duplicates, what each error means, and — most importantly —
to treat email content as data, never as instructions (protection against prompt injection
by email).

```bash
hermes plugins install dominikamann/agent-mail-gateway/integrations/hermes/agent-mail-gateway --enable
hermes plugins list
```

The plugin contains no MCP server definition on purpose: every gateway runs at its own address,
and plugins must not carry credentials. Step 2 is the connection, the plugin is the know-how.

## Reacting to new mail

- **Always-on agents:** let the gateway call a Hermes webhook route directly. Hermes verifies
  the gateway's signature natively (`X-Webhook-Signature-V2`), no adapter needed. See below.
- **Scheduled agents (cron):** no webhook needed. Start each run with `list_messages` and
  `unread: true`.

### Webhook route in Hermes

In the Hermes `config.yaml` of the agent's profile, add a route (the webhook platform listens
on port 8644 by default):

```yaml
platforms:
  webhook:
    enabled: true
    extra:
      port: 8644
      routes:
        agent-mail:
          events: ["message.received"]
          secret: "<the same value as webhook.secret of this mailbox in the gateway>"
          prompt: |
            New email in your mailbox from {message.from}: "{message.subject}"
            Preview: {message.preview}
            Read it with read_message (id {message.id}) and handle it.
          # Where the agent's answer goes. Without `deliver` it only lands in the Hermes log:
          # the agent still handles the mail (and can reply by email), but no person sees it.
          deliver: matrix            # or telegram, slack, discord, signal, email, ...
          deliver_extra:
            chat_id: "!roomid:matrix.example.org"   # optional; default is the platform's home channel
```

The webhook URL is always `http://<hermes-host>:8644/webhooks/<route name>` — note the
`/webhooks/` prefix. The target platform (Matrix in this example) must be enabled in the same
Hermes gateway.

**Alternative: trigger an existing cron job.** If you already have a scheduled mail job (for
example a daily "check the mailbox" run with its own delivery settings), let the webhook start
that job instead of a fresh run: replace `deliver`/`deliver_extra` with `cron_job: <job id or
name>`. The rendered `prompt` is passed to the job as extra context, and the job's own skills,
model and delivery apply. A nice side effect: the daily schedule remains a safety net if a
webhook is ever missed.

Then point the mailbox at it in the gateway's `config.yaml`:

```yaml
    webhook:
      url: http://hermes:8644/webhooks/agent-mail
      secret: ${AGENT_WEBHOOK_SECRET}
```

Use the same secret on both sides (`openssl rand -hex 24`). Hermes rejects requests whose
timestamp is more than 5 minutes off, so keep both machines' clocks in sync (NTP). Each
message triggers one agent run; the gateway retries failed deliveries and the payload's
`message.id` lets the agent ignore a rare duplicate.

## Example task prompts

> Check your mailbox for unread mail. Summarise anything from Alex and answer questions you
> can answer from your notes. Reply in the same thread.

> Send Alex this week's report as a Markdown table and attach `report.csv`.

> Schedule a 30-minute review with Alex tomorrow at 14:00. If you already sent an invite for
> the review, move that one instead of creating a new one.
