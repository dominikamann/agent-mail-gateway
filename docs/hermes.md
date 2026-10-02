# Hermes Agent integration

[Hermes Agent](https://hermes-agent.nousresearch.com/) can load tools from remote MCP servers.
Give each Hermes agent its own mailbox entry and API key in the gateway's `config.yaml`, then
add the gateway to that agent's `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  mail:
    url: "http://agent-mail-gateway:8080/mcp"
    headers:
      Authorization: "Bearer <this agent's api_key>"
```

The tools appear in Hermes as `mcp__mail__send_message`, `mcp__mail__list_messages`, etc.
Use a different key per agent — the key decides which mailbox the agent works with.

## Reacting to new mail

For agents that run continuously or react to events, configure a `webhook` for the mailbox
and point it at an HTTP endpoint that triggers the agent. The webhook only carries the
message id and a short preview; the agent then calls `read_message` with that id.

Agents that run on a schedule (cron) need no webhook: call `list_messages` with
`unread: true` at the start of each run.

## Example instructions for the agent

> You have your own mailbox via the `mail` tools. Call `get_mailbox_info` to see whom you may
> write to. Check for new mail with `list_messages` (`unread: true`) and read it with
> `read_message`. Write replies in Markdown with `send_message` and pass `reply_to_id` so the
> reply stays in the same thread. To schedule a meeting, use `create_event`; to move it, use
> `update_event` with the event id instead of creating a new one.

## Running both in Docker

If Hermes and the gateway run in the same Compose project, use the service name as host
(`http://agent-mail-gateway:8080/mcp`). Otherwise put the gateway behind a TLS reverse proxy
and use its `https://` URL.
