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

- **Always-on agents:** give the mailbox a `webhook` in the gateway config and point it at an
  HTTP endpoint that wakes the agent. The webhook carries only the message id, sender, subject
  and a short preview, signed with HMAC (see [api.md](api.md#webhooks)); the agent then calls
  `read_message` with that id.
- **Scheduled agents (cron):** no webhook needed. Start each run with `list_messages` and
  `unread: true`.

## Example task prompts

> Check your mailbox for unread mail. Summarise anything from Alex and answer questions you
> can answer from your notes. Reply in the same thread.

> Send Alex this week's report as a Markdown table and attach `report.csv`.

> Schedule a 30-minute review with Alex tomorrow at 14:00. If you already sent an invite for
> the review, move that one instead of creating a new one.
