import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mcpTarget, planMcp, skillDestination } from './clients.js';
import { run } from './process.js';

async function info(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function assertNoLinks(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    const value = await info(current);
    if (value?.isSymbolicLink()) throw new Error('Destination contains a symbolic link. Choose a regular directory.');
    if (path.dirname(current) === current) return;
  }
}

async function readExisting(file) {
  await assertNoLinks(file);
  const value = await info(file);
  if (value && !value.isFile()) throw new Error('Configuration destination is not a regular file');
  return value ? readFile(file, 'utf8') : null;
}

async function resolveOptions(options, hasMcp) {
  const resolved = { ...options, project: path.resolve(options.project), home: path.resolve(options.home) };
  if (!(await stat(resolved.project)).isDirectory()) throw new Error('Project must be an existing directory');
  if (resolved.client === 'opencode' && hasMcp) {
    const base = resolved.scope === 'project' ? resolved.project : path.join(resolved.home, '.config', 'opencode');
    const possible = [path.join(base, 'opencode.json'), path.join(base, 'opencode.jsonc')];
    if (resolved.scope === 'project') possible.push(path.join(base, '.opencode', 'opencode.json'), path.join(base, '.opencode', 'opencode.jsonc'));
    const found = [];
    for (const file of possible) if (await info(file)) found.push(file);
    if (found.length > 1) throw new Error('Multiple OpenCode config files exist. Resolve the competing files before installing MCPs.');
    if (found.length) resolved.opencodeConfigPath = found[0];
  }
  return resolved;
}

export async function planInstallation(entries, options) {
  const context = await resolveOptions(options, entries.some(entry => entry.install?.type === 'mcp'));
  const files = new Map();
  const destinations = new Set();
  const items = [];
  for (const entry of entries) {
    const item = { entry, status: 'ready' };
    items.push(item);
    try {
      if (!entry.clients.includes(context.client)) throw new Error('This entry has not been reviewed for the selected client');
      for (const dependency of entry.requires ?? []) {
        const required = items.find(item => item.entry.id === dependency);
        if (!required || ['blocked', 'manual'].includes(required.status)) throw new Error(`Required companion ${dependency} is unavailable. Install dependencies together in order.`);
      }
      if (!entry.install) { item.status = 'manual'; item.detail = 'Follow the setup steps below; no automatic recipe.'; continue; }
      if (entry.install.type === 'command') {
        if (entry.install.scope !== context.scope) throw new Error(`This CLI recipe requires ${entry.install.scope} scope`);
        if (context.scope === 'project') {
          await readExisting(path.join(context.project, 'package.json'));
          if (!(await info(path.join(context.project, 'package.json')))) throw new Error('Project CLI installation requires an existing package.json');
        }
        item.command = entry.install;
        item.detail = `${entry.install.command} ${entry.install.args.join(' ')}`;
      } else if (entry.install.type === 'skill') {
        const name = entry.install.name ?? path.posix.basename(entry.install.path);
        item.path = path.join(skillDestination(context.client, context.scope, context), name);
        await assertNoLinks(item.path);
        if (destinations.has(item.path)) throw new Error('Two selections have the same skill destination');
        destinations.add(item.path);
        const existing = await info(item.path);
        if (existing) {
          const receipt = await readExisting(path.join(item.path, '.ai-skill-source.json'));
          if (!existing.isDirectory() || !receipt || !isDeepStrictEqual(JSON.parse(receipt), entry.install) || !(await readExisting(path.join(item.path, 'SKILL.md')))) throw new Error('Skill already exists. It will not be overwritten; remove or move it yourself first.');
          item.status = 'present';
          item.detail = 'Previously installed revision is present. Local edits are preserved.';
        }
      } else {
        const target = mcpTarget(context.client, context.scope, context);
        let file = files.get(target.path);
        if (!file) {
          const original = await readExisting(target.path);
          file = { path: target.path, original, content: original ?? '', items: [] };
        }
        const result = planMcp(context.client, context.scope, entry.id, entry.install.server, { ...context, existingContent: file.content });
        item.path = result.path;
        if (result.unchanged) { item.status = 'present'; item.detail = 'Matching MCP configuration already exists; connection is unverified.'; }
        else {
          file.content = result.content;
          file.items.push(item);
          files.set(file.path, file);
        }
      }
    } catch (error) { item.status = 'blocked'; item.detail = error.message; }
  }
  return { context, items, files: [...files.values()] };
}

async function writeConfig(file, stateDirectory) {
  const current = await readExisting(file.path);
  if (current !== file.original) throw new Error('Configuration changed after preview; rerun the installer');
  await mkdir(path.dirname(file.path), { recursive: true });
  await assertNoLinks(file.path);
  const mode = (await info(file.path))?.mode ?? 0o600;
  let backup;
  if (current !== null) {
    const backupDirectory = path.join(stateDirectory, 'backups');
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    await assertNoLinks(backupDirectory);
    backup = path.join(backupDirectory, `${Date.now()}-${randomUUID()}-${path.basename(file.path)}`);
    await writeFile(backup, current, { mode: 0o600, flag: 'wx' });
  }
  const temporary = path.join(path.dirname(file.path), `.ai-skill-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, file.content, { mode, flag: 'wx' });
    if (await readExisting(file.path) !== current) throw new Error('Configuration changed while saving; original retained');
    await rename(temporary, file.path);
  } finally { await rm(temporary, { force: true }); }
  return backup;
}

async function checkTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Skill contains symbolic links; manual installation is required');
    if (entry.isDirectory()) await checkTree(path.join(directory, entry.name));
    else if (!entry.isFile()) throw new Error('Skill contains a special file');
  }
}

async function checkout(recipe, cache, temporary, command) {
  const key = `${recipe.repo}#${recipe.ref}`;
  if (cache.has(key)) return cache.get(key);
  const directory = path.join(temporary, createHash('sha256').update(key).digest('hex').slice(0, 16));
  await command('git', ['init', '--quiet', directory]);
  await command('git', ['-C', directory, 'remote', 'add', 'origin', recipe.repo]);
  await command('git', ['-C', directory, '-c', 'credential.interactive=never', 'fetch', '--quiet', '--depth=1', 'origin', recipe.ref], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  await command('git', ['-C', directory, '-c', 'core.hooksPath=', 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  const result = await command('git', ['-C', directory, 'rev-parse', 'HEAD']);
  if (result.stdout.trim() !== recipe.ref) throw new Error('Downloaded skill revision does not match the reviewed commit');
  cache.set(key, directory);
  return directory;
}

async function installSkill(item, repository) {
  const recipe = item.entry.install;
  const source = path.join(repository, ...recipe.path.split('/'));
  const actual = await realpath(source);
  if (!actual.startsWith(await realpath(repository) + path.sep)) throw new Error('Skill source escapes the repository');
  const skillText = await readFile(path.join(source, 'SKILL.md'), 'utf8');
  const declaredName = /^name:\s*["']?([a-z0-9-]+)["']?\s*$/m.exec(skillText)?.[1];
  if (declaredName !== path.basename(item.path)) throw new Error('SKILL.md name must match its destination directory');
  await checkTree(source);
  await mkdir(path.dirname(item.path), { recursive: true });
  await assertNoLinks(item.path);
  const stage = await mkdtemp(path.join(path.dirname(item.path), '.ai-skill-stage-'));
  try {
    await cp(source, stage, { recursive: true, errorOnExist: false, force: false });
    for (let current = source; ; current = path.dirname(current)) {
      const licenses = (await readdir(current)).filter(name => /^(LICENSE|COPYING|NOTICE)(\..*)?$/i.test(name));
      for (const name of licenses) {
        const from = path.join(current, name);
        if ((await lstat(from)).isFile()) await cp(from, path.join(stage, `UPSTREAM-${name}`), { force: false });
      }
      if (licenses.length || current === repository) break;
    }
    await writeFile(path.join(stage, '.ai-skill-source.json'), JSON.stringify(recipe, null, 2) + '\n', { flag: 'wx' });
    if (await info(item.path)) throw new Error('Skill destination appeared after preview; existing files preserved');
    await rename(stage, item.path);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function applyInstallation(plan, { command = run, onProgress = () => {} } = {}) {
  const stateDirectory = path.join(plan.context.home, '.ai-skill-installer');
  await assertNoLinks(stateDirectory);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  // shortcut: one install per user, add per-file locks if parallel installs are needed.
  const lockPath = path.join(stateDirectory, 'install.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another install holds ${lockPath}. If it crashed, remove that lock before retrying.`);
    throw error;
  }
  let temporary;
  const cache = new Map();
  const results = plan.items.map(item => ({ id: item.entry.id, name: item.entry.name, status: item.status, detail: item.detail, path: item.path }));
  const update = (item, values) => Object.assign(results.find(result => result.id === item.entry.id), values);
  try {
    temporary = await mkdtemp(path.join(os.tmpdir(), 'ai-skill-installer-'));
    for (const file of plan.files) {
      try {
        onProgress(`Configuring ${file.items.map(item => item.entry.name).join(', ')}`);
        const backup = await writeConfig(file, stateDirectory);
        for (const item of file.items) update(item, { status: 'configured', detail: 'Settings saved. Open your harness to connect and finish setup.', backup });
      } catch (error) { for (const item of file.items) update(item, { status: 'failed', detail: error.message }); }
    }
    for (const item of plan.items.filter(item => item.status === 'ready' && item.entry.kind !== 'mcp')) {
      try {
        for (const dependency of item.entry.requires ?? []) {
          if (!results.some(result => result.id === dependency && ['installed', 'configured', 'present'].includes(result.status))) throw new Error(`Required companion ${dependency} did not install. Retry after fixing it.`);
        }
        onProgress(`Installing ${item.entry.name}`);
        if (item.entry.kind === 'skill') await installSkill(item, await checkout(item.entry.install, cache, temporary, command));
        else await command(item.command.command, [...item.command.args, '--ignore-scripts'], { cwd: plan.context.project });
        update(item, { status: 'installed', detail: item.entry.kind === 'skill' ? 'Skill installed. Restart your harness if it does not appear.' : 'CLI installed with install scripts disabled. Check its setup instructions.' });
      } catch (error) { update(item, { status: 'failed', detail: error.message }); }
    }
    const receipt = path.join(stateDirectory, `receipt-${Date.now()}-${randomUUID()}.json`);
    await writeFile(receipt, JSON.stringify({ date: new Date().toISOString(), client: plan.context.client, scope: plan.context.scope, items: results }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return { results, receipt };
  } finally {
    try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
    finally {
      try { await lock.close(); }
      finally { await rm(lockPath, { force: true }); }
    }
  }
}
