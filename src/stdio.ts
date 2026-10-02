import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mailboxSchema } from './config/schema.js';
import { GatewayError } from './errors.js';
import type { ImapMailbox } from './mail/imap.js';
import { createMcpServer } from './mcp/server.js';
import type { MailboxContext } from './services/context.js';
import { Store } from './store/store.js';
import { VERSION } from './version.js';

type Env = Record<string, string | undefined>;

const PREVIEW_MESSAGE =
  'Preview mode: no gateway configured. Set AGENT_MAIL_URL (e.g. http://localhost:8080) and ' +
  'AGENT_MAIL_API_KEY (the agent key from the gateway config) to use your mailbox.';

/**
 * Tool definitions without any mailbox behind them, taken from the real MCP server so the
 * preview always matches the gateway. No config, no credentials, no network.
 */
async function previewToolSource(): Promise<Client> {
  const unavailable = () => {
    throw new GatewayError('mailbox_unavailable', PREVIEW_MESSAGE);
  };
  const ctx: MailboxContext = {
    config: mailboxSchema.parse({
      name: 'preview',
      address: 'preview@example.invalid',
      api_key: 'p'.repeat(32),
      imap: { host: 'example.invalid', port: 993, security: 'tls' },
      smtp: { host: 'example.invalid', port: 465, security: 'tls' },
      username: 'preview',
      password: 'preview',
    }),
    imap: new Proxy({}, { get: () => unavailable }) as ImapMailbox,
    smtp: { send: async () => unavailable(), close() {} },
    store: new Store(':memory:'),
    log: { info() {}, warn() {}, error() {} },
    now: Date.now,
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(ctx).connect(serverSide);
  const client = new Client({ name: 'agent-mail-gateway-preview', version: VERSION });
  await client.connect(clientSide);
  return client;
}

/**
 * MCP over stdio for clients that cannot speak HTTP. With AGENT_MAIL_URL and
 * AGENT_MAIL_API_KEY it bridges every request to a running gateway, so the process only ever
 * holds the agent's own key. Without AGENT_MAIL_URL it starts in preview mode: tools are
 * listed, calls explain how to connect.
 */
export async function createStdioServer(env: Env = process.env): Promise<Server> {
  const url = env.AGENT_MAIL_URL?.trim();
  const key = env.AGENT_MAIL_API_KEY?.trim();
  if (url && !key) throw new Error('AGENT_MAIL_API_KEY is required when AGENT_MAIL_URL is set');

  let upstream: Promise<Client> | null = null;
  const connectUpstream = (): Promise<Client> => {
    upstream ??= url
      ? (async () => {
          const endpoint = new URL(
            url.replace(/\/+$/, '').endsWith('/mcp') ? url : `${url.replace(/\/+$/, '')}/mcp`,
          );
          const client = new Client({ name: 'agent-mail-gateway-stdio', version: VERSION });
          await client.connect(
            new StreamableHTTPClientTransport(endpoint, {
              requestInit: { headers: { authorization: `Bearer ${key}` } },
            }),
          );
          return client;
        })()
      : previewToolSource();
    upstream.catch(() => {
      upstream = null;
    });
    return upstream;
  };

  const server = new Server(
    { name: 'agent-mail-gateway', version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (req) =>
    (await connectUpstream()).listTools(req.params),
  );
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (!url) return { content: [{ type: 'text', text: PREVIEW_MESSAGE }], isError: true };
    return (await connectUpstream()).callTool(req.params);
  });
  server.onclose = () => {
    void upstream?.then((c) => c.close()).catch(() => {});
  };
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const server = await createStdioServer();
    await server.connect(new StdioServerTransport());
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
}
