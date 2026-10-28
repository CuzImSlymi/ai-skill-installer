import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/ai-skill-installer.js', import.meta.url));
async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'installer-cli-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, CODEX_HOME: path.join(dir, 'custom-codex'), TEST_SECRET: 'secret-sentinel-must-not-appear' };
  return { dir, run: (...args) => exec(process.execPath, [cli, ...args], { cwd: dir, env }) };
}

test('list and check validate offline without exposing environment values', async t => {
  const { dir, run } = await setup(t);
  const list = await run('--list', '--json', '--search', 'writing');
  const entries = JSON.parse(list.stdout);
  assert.ok(entries.length);
  assert.ok(entries.every(entry => entry.id && entry.name));
  const checked = await run('--check');
  assert.match(checked.stdout, /Validated \d+ catalog entries/);
  const checkedJson = await run('--check', '--json');
  assert.ok(JSON.parse(checkedJson.stdout));
  assert.doesNotMatch(list.stdout + checked.stdout + list.stderr + checked.stderr, /secret-sentinel-must-not-appear/);
  assert.deepEqual(await readdir(dir), []);
});

test('dry run emits JSON without changes and refuses ambiguous noninteractive requests', async t => {
  const { dir, run } = await setup(t);
  const preview = await run('--client', 'codex', '--scope', 'project', '--install', 'unslop', '--dry-run', '--json');
  assert.equal(JSON.parse(preview.stdout)[0].id, 'unslop');
  assert.doesNotMatch(preview.stdout + preview.stderr, /secret-sentinel-must-not-appear/);
  await assert.rejects(run('--yes'), /--install|interactive/);
  await assert.rejects(run('--client', 'codex', '--scope', 'project', '--install', 'unknown-id', '--dry-run'), /Unknown catalog ID/);
  const mcpList = JSON.parse((await run('--list', '--kind', 'mcp', '--client', 'opencode', '--json')).stdout);
  const mcp = mcpList.find(entry => entry.install);
  assert.ok(mcp);
  await assert.rejects(run('--client', 'opencode', '--scope', 'project', '--install', mcp.id, '--dry-run'), /opencode-version/);
  assert.deepEqual(await readdir(dir), []);
});
