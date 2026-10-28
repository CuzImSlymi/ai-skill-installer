import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { clients, skillDestination, mcpTarget, planMcp } from '../src/clients.js';

const opts = { project: path.resolve('project'), home: path.resolve('home'), opencodeVersion: '1' };
const http = { transport: 'http', url: 'https://example.com/mcp' };
const local = { transport: 'stdio', command: 'node', args: ['server.js'], env: ['API_KEY'] };

test('all clients and scopes plan an MCP entry and preserve unrelated data', () => {
  for (const { id } of clients) for (const scope of ['project', 'global']) {
    const original = id === 'codex' ? '# retained\nmodel = "example"\n' : '{\n  // retained\n  "other": 1\n}';
    const result = planMcp(id, scope, 'example', http, { ...opts, existingContent: original });
    assert.match(result.content, /retained/);
    assert.equal(result.unchanged, false);
    assert.equal(planMcp(id, scope, 'example', http, { ...opts, existingContent: result.content }).unchanged, true);
    assert.throws(() => planMcp(id, scope, 'example', { ...http, url: 'https://other.example/mcp' }, { ...opts, existingContent: result.content }), /already exists/);
    assert.ok(path.isAbsolute(skillDestination(id, scope, opts)));
  }
});

test('configuration parsing and target shapes fail closed', () => {
  for (const [id, content] of [['codex', '[broken'], ['claude-code', '{"mcpServers":[] }'], ['antigravity', '{"mcpServers":1}'], ['opencode', '{"mcp":[] }'], ['claude-code', '{"a":1,"a":2}']]) {
    assert.throws(() => planMcp(id, 'project', 'example', http, { ...opts, existingContent: content }));
  }
  assert.throws(() => planMcp('claude-code', 'project', '__proto__', http, opts));
  assert.throws(() => planMcp('claude-code', 'project', 'example', http, { ...opts, existingContent: '{"__proto__":{"polluted":true}}' }), /Unsafe/);
  assert.throws(() => mcpTarget('opencode', 'project', { ...opts, opencodeConfigPath: path.resolve('elsewhere/opencode.jsonc') }), /Invalid/);
  assert.throws(() => planMcp('claude-code', 'project', 'example', { ...http, url: 'file:///secret' }, opts));
  assert.throws(() => mcpTarget('opencode', 'project', { ...opts, opencodeVersion: undefined }), /version/);
  assert.throws(() => planMcp('opencode', 'project', 'example', http, { ...opts, opencodeVersion: '2', existingContent: '{"mcp":{"old":{"type":"remote","url":"https://example.com"}}}' }), /v1/);
});

test('environment references are represented in each native format', () => {
  const codex = planMcp('codex', 'global', 'example', local, opts).content;
  assert.match(codex, /env_vars = \[ "API_KEY" \]/);
  const claude = planMcp('claude-code', 'project', 'example', local, opts).content;
  assert.match(claude, /\$\{API_KEY\}/);
  const opencode = planMcp('opencode', 'project', 'example', local, { ...opts, opencodeVersion: '2' }).content;
  assert.match(opencode, /\{env:API_KEY\}/);
  assert.match(opencode, /"servers"/);
  assert.throws(() => planMcp('antigravity', 'project', 'example', local, opts), /not verified/);
  assert.throws(() => planMcp('claude-code', 'global', 'example', local, opts), /not verified/);
  const auth = { ...http, headerEnv: { Authorization: 'API_KEY' } };
  assert.match(planMcp('codex', 'project', 'example', auth, opts).content, /env_http_headers/);
  assert.throws(() => planMcp('antigravity', 'project', 'example', auth, opts), /not verified/);
});

test('scope paths and client-specific options', () => {
  assert.equal(skillDestination('codex', 'project', opts), path.join(opts.project, '.agents', 'skills'));
  assert.equal(skillDestination('antigravity', 'global', { ...opts, antigravitySurface: 'cli' }), path.join(opts.home, '.gemini', 'antigravity-cli', 'skills'));
  assert.equal(mcpTarget('codex', 'global', { ...opts, codexHome: path.resolve('custom') }).path, path.resolve('custom/config.toml'));
  assert.equal(mcpTarget('opencode', 'project', { ...opts, opencodeConfigPath: path.resolve('project/opencode.jsonc') }).path, path.resolve('project/opencode.jsonc'));
});

