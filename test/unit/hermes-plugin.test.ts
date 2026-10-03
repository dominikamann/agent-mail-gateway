import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

// Mirrors the validation Hermes applies to portable Agent Plugins v1 packages.
const ROOT = 'integrations/hermes/agent-mail-gateway';
const PLUGIN_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);
const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const SKILL_NAME = /^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe('Hermes plugin package', () => {
  it('has a valid plugin.json', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8'));
    expect(manifest.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    expect(Object.keys(manifest).every((k) => PLUGIN_FIELDS.has(k))).toBe(true);
    expect(manifest.name).toMatch(PLUGIN_NAME);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(manifest.version).toBe(pkg.version);
    expect(Object.keys(manifest.author).every((k) => ['name', 'email', 'url'].includes(k))).toBe(
      true,
    );
  });

  it('has valid skills whose names match their directories', () => {
    const dirs = readdirSync(join(ROOT, 'skills'));
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      const text = readFileSync(join(ROOT, 'skills', dir, 'SKILL.md'), 'utf8');
      const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
      expect(match, `${dir} has frontmatter`).not.toBeNull();
      const fm = YAML.parse(match![1]!);
      expect(fm.name).toBe(dir);
      expect(fm.name).toMatch(SKILL_NAME);
      expect(typeof fm.description).toBe('string');
      expect(fm.description.length).toBeGreaterThan(0);
      expect(fm.description.length).toBeLessThanOrEqual(1024);
    }
  });

  it('documents every MCP tool the gateway exposes', () => {
    const skill = readFileSync(join(ROOT, 'skills', 'agent-mail', 'SKILL.md'), 'utf8');
    for (const tool of [
      'cancel_event',
      'create_event',
      'delete_message',
      'forward_message',
      'get_attachment',
      'get_event',
      'get_mailbox_info',
      'list_events',
      'list_messages',
      'mark_message',
      'read_message',
      'reply_message',
      'respond_to_invitation',
      'search_messages',
      'send_message',
      'update_event',
    ]) {
      expect(skill, tool).toContain(tool);
    }
    expect(existsSync(join(ROOT, 'mcp.json'))).toBe(false);
  });
});
