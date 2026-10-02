import { pathToFileURL } from 'node:url';
import { loadConfig } from './config/load.js';

type Env = Record<string, string | undefined>;

/** The local /health URL, using server.port from the config (8080 if it cannot be read). */
export function healthUrl(env: Env = process.env): string {
  let port = 8080;
  try {
    port = loadConfig(env.CONFIG_PATH ?? '/config/config.yaml', env).server.port;
  } catch {
    // Unreadable config: the server would not be running either; probe the default port.
  }
  return `http://127.0.0.1:${port}/health`;
}

// Used by the Docker HEALTHCHECK: exit 0 when the gateway answers, 1 otherwise.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  fetch(healthUrl(), { signal: AbortSignal.timeout(4000) })
    .then((res) => process.exit(res.ok ? 0 : 1))
    .catch(() => process.exit(1));
}
