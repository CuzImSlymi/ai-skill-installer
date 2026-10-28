import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import TOML from '@iarna/toml';
import { parse, parseTree, modify, applyEdits } from 'jsonc-parser';

export const clients = [
  { id: 'codex', name: 'Codex', description: 'Project skills use the shared .agents directory.' },
  { id: 'claude-code', name: 'Claude Code', description: 'Project skills and MCP settings can be shared with the repository.' },
  { id: 'antigravity', name: 'Antigravity CLI / IDE', description: 'App MCP configuration is not supported.' },
  { id: 'opencode', name: 'OpenCode', description: 'MCP configuration depends on the installed major version.' },
];

function check(clientId, scope, options) {
  if (!clients.some(client => client.id === clientId)) throw new Error(`Unknown client: ${clientId}`);
  if (!['project', 'global'].includes(scope)) throw new Error(`Unknown scope: ${scope}`);
  const base = scope === 'project' ? options.project : options.home;
  if (typeof base !== 'string' || !path.isAbsolute(base)) throw new Error(`An absolute ${scope === 'project' ? 'project' : 'home'} path is required`);
  return base;
}

export function skillDestination(clientId, scope, options) {
  const base = check(clientId, scope, options);
  if (clientId === 'antigravity' && options.antigravitySurface !== undefined && !['cli', 'ide'].includes(options.antigravitySurface)) throw new Error('Unknown Antigravity surface');
  const locations = {
    codex: ['.agents', 'skills'],
    'claude-code': ['.claude', 'skills'],
    antigravity: scope === 'project' ? ['.agents', 'skills'] : ['.gemini', options.antigravitySurface === 'cli' ? 'antigravity-cli' : 'config', 'skills'],
    opencode: scope === 'project' ? ['.opencode', 'skills'] : ['.config', 'opencode', 'skills'],
  };
  return path.join(base, ...locations[clientId]);
}

export function mcpTarget(clientId, scope, options) {
  const base = check(clientId, scope, options);
  switch (clientId) {
    case 'codex': {
      const dir = scope === 'global' && options.codexHome ? options.codexHome : path.join(base, '.codex');
      if (!path.isAbsolute(dir)) throw new Error('codexHome must be absolute');
      return { path: path.join(dir, 'config.toml'), format: 'toml' };
    }
    case 'claude-code': return { path: path.join(base, scope === 'project' ? '.mcp.json' : '.claude.json'), format: 'jsonc' };
    case 'antigravity': return { path: path.join(base, ...(scope === 'project' ? ['.agents', 'mcp_config.json'] : ['.gemini', 'config', 'mcp_config.json'])), format: 'jsonc' };
    case 'opencode':
      if (!['1', '2'].includes(options.opencodeVersion)) throw new Error('OpenCode major version must be 1 or 2');
      if (options.opencodeConfigPath) {
        if (!path.isAbsolute(options.opencodeConfigPath)) throw new Error('opencodeConfigPath must be absolute');
        const directory = path.join(base, ...(scope === 'project' ? [] : ['.config', 'opencode']));
        const directories = [path.resolve(directory), ...(scope === 'project' ? [path.resolve(directory, '.opencode')] : [])];
        if (!directories.includes(path.dirname(path.resolve(options.opencodeConfigPath))) || !['opencode.json', 'opencode.jsonc'].includes(path.basename(options.opencodeConfigPath))) throw new Error('Invalid OpenCode configuration path');
        return { path: options.opencodeConfigPath, format: 'jsonc' };
      }
      return { path: path.join(base, ...(scope === 'project' ? ['opencode.json'] : ['.config', 'opencode', 'opencode.json'])), format: 'jsonc' };
  }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
function definition(clientId, server) {
  if (!object(server)) throw new Error('Invalid MCP server');
  if (server.transport === 'http') {
    let url;
    try { url = new URL(server.url); } catch { throw new Error('Invalid MCP URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid MCP URL');
    const headers = server.headerEnv ?? {};
    if (!object(headers) || Object.entries(headers).some(([header, env]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header) || typeof env !== 'string' || !envName.test(env))) throw new Error('Invalid header environment references');
    if (clientId === 'antigravity' && Object.keys(headers).length) throw new Error('Antigravity header environment references are not verified');
    if (clientId === 'codex') return { url: server.url, ...(Object.keys(headers).length ? { env_http_headers: headers } : {}) };
    if (clientId === 'claude-code') return { type: 'http', url: server.url, ...(Object.keys(headers).length ? { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, `\${${v}}`])) } : {}) };
    if (clientId === 'antigravity') return { serverUrl: server.url };
    return { type: 'remote', url: server.url, ...(Object.keys(headers).length ? { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, `{env:${v}}`])) } : {}) };
  }
  if (server.transport !== 'stdio' || typeof server.command !== 'string' || !server.command.trim() || !Array.isArray(server.args) || !server.args.every(x => typeof x === 'string') || !Array.isArray(server.env) || !server.env.every(x => typeof x === 'string' && envName.test(x))) throw new Error('Invalid stdio server');
  if (clientId === 'antigravity' && server.env.length) throw new Error('Antigravity environment references are not verified');
  if (clientId === 'codex') return { command: server.command, args: server.args, ...(server.env.length ? { env_vars: server.env } : {}) };
  if (clientId === 'claude-code') return { type: 'stdio', command: server.command, args: server.args, ...(server.env.length ? { env: Object.fromEntries(server.env.map(x => [x, `\${${x}}`])) } : {}) };
  if (clientId === 'antigravity') return { command: server.command, args: server.args };
  return { type: 'local', command: [server.command, ...server.args], ...(server.env.length ? { environment: Object.fromEntries(server.env.map(x => [x, `{env:${x}}`])) } : {}) };
}

function assertUnique(node) {
  if (!node) return;
  if (node.type === 'object') {
    const seen = new Set();
    for (const property of node.children ?? []) {
      const key = property.children[0].value;
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`Unsafe configuration key: ${key}`);
      if (seen.has(key)) throw new Error(`Duplicate configuration key: ${key}`);
      seen.add(key);
      assertUnique(property.children[1]);
    }
  } else for (const child of node.children ?? []) assertUnique(child);
}

export function planMcp(clientId, scope, serverName, server, options) {
  if (typeof serverName !== 'string' || !/^[A-Za-z0-9_-]+$/.test(serverName) || ['__proto__', 'prototype', 'constructor'].includes(serverName)) throw new Error('Invalid server name');
  const target = mcpTarget(clientId, scope, options);
  if (clientId === 'claude-code' && scope === 'global' && (server?.env?.length || Object.keys(server?.headerEnv ?? {}).length)) throw new Error('Claude user-scope environment references are not verified');
  const entry = definition(clientId, server);
  const original = options.existingContent ?? '';
  if (typeof original !== 'string') throw new Error('Existing configuration must be text');
  const text = original.trim() ? original : target.format === 'toml' ? '' : '{}';
  if (target.format === 'toml') {
    let config;
    try { config = TOML.parse(text); } catch { throw new Error('Invalid TOML configuration'); }
    if (config.mcp_servers !== undefined && !object(config.mcp_servers)) throw new Error('Invalid mcp_servers configuration');
    const old = config.mcp_servers?.[serverName];
    if (old !== undefined) {
      if (!isDeepStrictEqual(old, entry)) throw new Error(`MCP server ${serverName} already exists with different settings`);
      return { path: target.path, content: original, unchanged: true };
    }
    const fragment = TOML.stringify({ mcp_servers: { [serverName]: entry } }).trimEnd();
    const content = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${fragment}\n`;
    try { TOML.parse(content); } catch { throw new Error('Cannot safely add server to TOML configuration'); }
    return { path: target.path, content, unchanged: false };
  }
  const errors = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !object(config)) throw new Error('Invalid JSON configuration');
  assertUnique(parseTree(text));
  const keys = clientId === 'opencode' ? options.opencodeVersion === '2' ? ['mcp', 'servers'] : ['mcp'] : ['mcpServers'];
  let current = config;
  for (const key of keys) {
    if (current[key] === undefined) break;
    if (!object(current[key])) throw new Error(`Invalid ${key} configuration`);
    current = current[key];
  }
  if (clientId === 'opencode' && object(config.mcp)) {
    if (options.opencodeVersion === '1' && 'servers' in config.mcp) throw new Error('OpenCode configuration may use the v2 MCP schema');
    if (options.opencodeVersion === '2' && Object.entries(config.mcp).some(([key, value]) => key !== 'servers' && object(value) && ('type' in value || 'command' in value || 'url' in value))) throw new Error('OpenCode configuration may use the v1 MCP schema');
  }
  let parent = config;
  for (const key of keys) parent = parent?.[key];
  const old = parent?.[serverName];
  if (old !== undefined) {
    if (!isDeepStrictEqual(old, entry)) throw new Error(`MCP server ${serverName} already exists with different settings`);
    return { path: target.path, content: original, unchanged: true };
  }
  const edits = modify(text, [...keys, serverName], entry, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' } });
  return { path: target.path, content: applyEdits(text, edits), unchanged: false };
}

