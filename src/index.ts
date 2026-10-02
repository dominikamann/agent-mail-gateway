import { ConfigError, loadConfig } from './config/load.js';
import { startGateway } from './main.js';

const configPath = process.env.CONFIG_PATH ?? '/config/config.yaml';

try {
  const config = loadConfig(configPath);
  const gateway = await startGateway(config);
  const shutdown = async (signal: string) => {
    gateway.app.log.info({ signal }, 'shutting down');
    await gateway.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(2);
  }
  throw err;
}
