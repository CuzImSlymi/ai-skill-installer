import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { planInstallation, applyInstallation } from '../src/installer.js';

const ref = 'a'.repeat(40);
const entry = (id, install, kind = 'mcp') => ({ id, name: id, kind, clients: ['codex'], install });
const mcp = id => entry(id, { type: 'mcp', server: { transport: 'http', url: `https://${id}.example/mcp` } });
const skill = entry('demo', { type: 'skill', repo: 'https://github.com/example/repo.git', ref, path: 'skills/demo' }, 'skill');
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'installer-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, options: { project: root, home: root, client: 'codex', scope: 'project', opencodeVersion: '1' } };
}
const fakeGit = (name = 'demo', revision = ref) => async (program, args) => {
  assert.equal(program, 'git');
  if (args[0] === 'init') {
    const root = args.at(-1);
    await mkdir(path.join(root, 'skills', 'demo', 'scripts'), { recursive: true });
    await writeFile(path.join(root, 'skills', 'demo', 'SKILL.md'), `---\nname: ${name}\ndescription: demo\n---\nInstructions\n`);
    await writeFile(path.join(root, 'skills', 'demo', 'scripts', 'check.js'), 'check');
    await writeFile(path.join(root, 'LICENSE'), 'license');
  }
  return { stdout: args.includes('rev-parse') ? revision + '\n' : '' };
};

test('merges MCPs, preserves comments, writes backup and refuses overwrite', async t => {
  const { root, options } = await setup(t);
  const config = path.join(root, '.codex', 'config.toml');
  await mkdir(path.dirname(config));
  const original = '# keep\nmodel = "demo"\n';
  await writeFile(config, original);
  const plan = await planInstallation([mcp('first'), mcp('second')], options);
  assert.equal(plan.files.length, 1);
  const { results } = await applyInstallation(plan);
  assert.deepEqual(results.map(x => x.status), ['configured', 'configured']);
  const contents = await readFile(config, 'utf8');
  assert.match(contents, /# keep/);
  assert.match(contents, /mcp_servers\.first/);
  assert.match(contents, /mcp_servers\.second/);
  assert.equal(await readFile(results[0].backup, 'utf8'), original);
  const conflict = mcp('first'); conflict.install.server.url = 'https://different.example/mcp';
  assert.equal((await planInstallation([conflict], options)).items[0].status, 'blocked');
  assert.equal(await readFile(config, 'utf8'), contents);
});

test('changed configuration after preview fails without overwriting and lock is released', async t => {
  const { root, options } = await setup(t);
  const config = path.join(root, '.codex', 'config.toml');
  await mkdir(path.dirname(config));
  await writeFile(config, '# before\n');
  const plan = await planInstallation([mcp('first')], options);
  await writeFile(config, '# changed\n');
  const result = await applyInstallation(plan);
  assert.equal(result.results[0].status, 'failed');
  assert.equal(await readFile(config, 'utf8'), '# changed\n');
  await assert.rejects(access(path.join(root, '.ai-skill-installer', 'install.lock')));
  assert.equal((await applyInstallation(await planInstallation([mcp('second')], options))).results[0].status, 'configured');
});

test('skill copies entire directory and license, validates name and never overwrites', async t => {
  const { root, options } = await setup(t);
  const target = path.join(root, '.agents', 'skills', 'demo');
  let result = await applyInstallation(await planInstallation([skill], options), { command: fakeGit() });
  assert.equal(result.results[0].status, 'installed');
  assert.equal(await readFile(path.join(target, 'scripts', 'check.js'), 'utf8'), 'check');
  assert.equal(await readFile(path.join(target, 'UPSTREAM-LICENSE'), 'utf8'), 'license');
  await writeFile(path.join(target, 'scripts', 'check.js'), 'user edits');
  assert.equal((await planInstallation([skill], options)).items[0].status, 'present');
  assert.equal(await readFile(path.join(target, 'scripts', 'check.js'), 'utf8'), 'user edits');
  await rm(target, { recursive: true });
  result = await applyInstallation(await planInstallation([skill], options), { command: fakeGit('wrong') });
  assert.equal(result.results[0].status, 'failed');
  await assert.rejects(access(target));
  result = await applyInstallation(await planInstallation([skill], options), { command: fakeGit('demo', 'b'.repeat(40)) });
  assert.equal(result.results[0].status, 'failed');
});

test('blocked, manual, and failed entries remain distinguishable while other items succeed', async t => {
  const { options } = await setup(t);
  const cli = entry('cli', { type: 'command', scope: 'global', command: 'npm', args: ['install', '-g', 'package@1.0.0'] }, 'cli');
  const manual = entry('manual', null, 'mcp');
  const plan = await planInstallation([cli, manual, mcp('ok'), skill], options);
  const result = await applyInstallation(plan, { command: async () => { throw new Error('offline'); } });
  assert.deepEqual(result.results.map(x => x.status), ['blocked', 'manual', 'configured', 'failed']);
});

test('refuses a symlinked skill destination', async t => {
  const { root, options } = await setup(t);
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await mkdir(path.join(root, '.agents'));
  try { await symlink(outside, path.join(root, '.agents', 'skills'), 'junction'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Symlinks unavailable'); throw error; }
  assert.equal((await planInstallation([skill], options)).items[0].status, 'blocked');
});

test('upstream folder and declared skill names may differ, and failed companions block the skill', async t => {
  const { root, options } = await setup(t);
  const renamed = { ...skill, id: 'renamed', install: { ...skill.install, name: 'different' } };
  const installed = await applyInstallation(await planInstallation([renamed], options), { command: fakeGit('different') });
  assert.equal(installed.results[0].status, 'installed');
  assert.match(await readFile(path.join(root, '.agents', 'skills', 'different', 'SKILL.md'), 'utf8'), /name: different/);
  const dependent = { ...skill, id: 'dependent', requires: ['broken'] };
  const broken = { ...skill, id: 'broken', install: { ...skill.install, name: 'broken' } };
  const plan = await planInstallation([broken, dependent], options);
  let calls = 0;
  const result = await applyInstallation(plan, { command: async () => { calls++; throw new Error('offline'); } });
  assert.equal(calls, 1);
  assert.deepEqual(result.results.map(item => item.status), ['failed', 'failed']);
  assert.match(result.results[1].detail, /Required companion/);
});

test('CLI recipes use argument arrays with lifecycle scripts disabled', async t => {
  const { root, options } = await setup(t);
  await writeFile(path.join(root, 'package.json'), '{"private":true}');
  const cli = entry('cli', { type: 'command', scope: 'project', command: 'npm', args: ['install', '--save-dev', 'example@1.2.3'] }, 'cli');
  const result = await applyInstallation(await planInstallation([cli], options), { command: async (program, args, config) => {
    assert.equal(program, 'npm');
    assert.deepEqual(args, ['install', '--save-dev', 'example@1.2.3', '--ignore-scripts']);
    assert.equal(config.cwd, root);
    return { stdout: '' };
  } });
  assert.equal(result.results[0].status, 'installed');
});
