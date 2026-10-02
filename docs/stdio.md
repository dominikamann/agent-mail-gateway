# stdio clients

Some MCP clients can only start local processes and talk over stdio. For them the image (and
the npm build) contains a small stdio entry point, `dist/stdio.js`.

It does **not** read the gateway configuration and never sees mailbox passwords. It is a
bridge: every request is forwarded to a running gateway with the agent's own API key.

```bash
AGENT_MAIL_URL=http://localhost:8080 \
AGENT_MAIL_API_KEY=<the agent's api_key> \
node dist/stdio.js
```

With Docker:

```bash
docker run -i --rm \
  -e AGENT_MAIL_URL=http://host.docker.internal:8080 \
  -e AGENT_MAIL_API_KEY=<the agent's api_key> \
  ghcr.io/dominikamann/agent-mail-gateway node dist/stdio.js
```

Example client entry:

```json
{
  "mcpServers": {
    "mail": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "AGENT_MAIL_URL", "-e", "AGENT_MAIL_API_KEY",
               "ghcr.io/dominikamann/agent-mail-gateway", "node", "dist/stdio.js"],
      "env": { "AGENT_MAIL_URL": "http://host.docker.internal:8080", "AGENT_MAIL_API_KEY": "…" }
    }
  }
}
```

## Preview mode

Without `AGENT_MAIL_URL` the entry point starts in preview mode: it lists all tools with their
schemas (taken from the real server) and answers every call with a message explaining how to
connect. MCP directories use this to inspect the server without any mail account.

For sandboxed directory builds (for example Glama), this Dockerfile is enough:

```dockerfile
FROM ghcr.io/dominikamann/agent-mail-gateway:latest
USER root
RUN npm install -g mcp-proxy@6
USER node
CMD ["mcp-proxy", "--", "node", "dist/stdio.js"]
```
