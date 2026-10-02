# Hermes plugin for Agent Mail Gateway

This portable plugin (Agent Plugins v1) adds the `agent-mail` skill to Hermes. The skill tells
the agent how to use its mailbox through Agent Mail Gateway correctly and safely.

The connection itself is configured in Hermes, because every gateway runs at its own address
and plugins must not contain credentials. See [docs/hermes.md](../../../docs/hermes.md).

```bash
hermes plugins install dominikamann/agent-mail-gateway/integrations/hermes/agent-mail-gateway --enable
```
