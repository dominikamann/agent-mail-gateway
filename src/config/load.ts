import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { type Config, configSchema } from './schema.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function substitute(value: unknown, env: Env, missing: Set<string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => {
      const v = env[name];
      if (v === undefined || v === '') {
        missing.add(name);
        return '';
      }
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, env, missing));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substitute(v, env, missing)]),
    );
  }
  return value;
}

export function parseConfig(text: string, env: Env): Config {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    throw new ConfigError(`config.yaml is not valid YAML: ${(err as Error).message}`);
  }
  const missing = new Set<string>();
  const substituted = substitute(raw, env, missing);
  if (missing.size > 0) {
    throw new ConfigError(`Missing environment variables: ${[...missing].sort().join(', ')}`);
  }
  const result = configSchema.safeParse(substituted);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadConfig(path: string, env: Env = process.env): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read config file ${path}: ${(err as Error).message}`);
  }
  return parseConfig(text, env);
}
