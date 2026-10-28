import { parseArgs } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import * as p from '@clack/prompts';
import { clients, planMcp } from './clients.js';
import { loadCatalog, matches, setupBadge, expandSelection } from './catalog.js';
import { planInstallation, applyInstallation } from './installer.js';
import { answer, pickCatalog } from './picker.js';

const help = `Setup AI Installer

Run npx setup-ai-installer@latest to open the installer.

Choose a harness, browse folders, and select your tools.
Arrow keys: browse | Tab: select | Enter/Esc: back
Choose Review selection to install.
`;

function summary(item) {
  return { id: item.entry.id, name: item.entry.name, status: item.status, path: item.path, detail: item.detail,
    setup: item.entry.setup, source: item.entry.source };
}

function printPlan(plan) {
  for (const item of plan.items) {
    console.log(`\n${item.entry.name} [${item.status}]`);
    console.log(`  ${item.entry.description}`);
    console.log(`  ${item.path ?? item.detail ?? 'Manual setup'}`);
    if (item.path && item.detail) console.log(`  ${item.detail}`);
    if (item.entry.install?.type === 'skill') console.log(`  Source: ${item.entry.install.repo} @ ${item.entry.install.ref.slice(0, 12)} / ${item.entry.install.path}`);
    else console.log(`  Source: ${item.entry.source}`);
    for (const step of item.entry.setup) console.log(`  ${step.label}: ${step.detail}`);
    for (const caution of item.entry.cautions) console.log(`  Note: ${caution}`);
  }
  if (plan.files.some(file => file.original !== null)) console.log('\nExisting configuration files will be backed up before changes.');
  if (plan.context.client === 'codex' || plan.context.client === 'antigravity') console.log('\nOther harnesses may also use skills in .agents/skills.');
  if (plan.items.some(item => item.entry.kind === 'mcp')) console.log('\nFinish any sign-in steps in your harness.');
}

export async function main(args = process.argv.slice(2)) {
  const { values: flags } = parseArgs({ args, options: {
    client: { type: 'string' }, scope: { type: 'string' }, project: { type: 'string' }, home: { type: 'string' },
    install: { type: 'string', multiple: true }, search: { type: 'string', default: '' }, category: { type: 'string' }, kind: { type: 'string' },
    'opencode-version': { type: 'string' }, 'antigravity-surface': { type: 'string', default: 'ide' },
    list: { type: 'boolean' }, check: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, yes: { type: 'boolean' },
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (flags.help) return console.log(help);
  if (flags.version) return console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version);
  const catalog = await loadCatalog();
  const knownClients = new Set(clients.map(client => client.id));
  if (flags.client && !knownClients.has(flags.client)) throw new Error(`Unknown client: ${flags.client}`);
  if (flags.scope && !['project', 'global'].includes(flags.scope)) throw new Error('Scope must be project or global');
  if (!['cli', 'ide'].includes(flags['antigravity-surface'])) throw new Error('Antigravity surface must be cli or ide');
  if (flags['opencode-version'] && !['1', '2'].includes(flags['opencode-version'])) throw new Error('OpenCode version must be 1 or 2');
  if (flags.kind && !['skill', 'mcp', 'cli'].includes(flags.kind)) throw new Error('Unknown catalog kind');
  if (flags.category && !catalog.some(entry => entry.category === flags.category)) throw new Error(`Unknown category: ${flags.category}`);
  if (flags.check) {
    for (const entry of catalog) {
      for (const client of entry.clients) if (!knownClients.has(client)) throw new Error(`${entry.id} has an unknown client: ${client}`);
      if (entry.install?.type === 'mcp') for (const client of entry.clients) {
        planMcp(client, 'project', entry.id, entry.install.server, { project: process.cwd(), home: os.homedir(), opencodeVersion: '1' });
        if (client === 'opencode') planMcp(client, 'project', entry.id, entry.install.server, { project: process.cwd(), home: os.homedir(), opencodeVersion: '2' });
      }
    }
    console.log(flags.json ? JSON.stringify({ valid: true, entries: catalog.length }) : `Validated ${catalog.length} catalog entries and their project MCP recipes.`);
    return;
  }
  let available = catalog.filter(entry => (!flags.category || entry.category === flags.category) && (!flags.kind || entry.kind === flags.kind));
  if (flags.list) {
    available = available.filter(entry => matches(entry, flags.search) && (!flags.client || entry.clients.includes(flags.client)));
    if (flags.json) console.log(JSON.stringify(available, null, 2));
    else {
      for (const entry of available) console.log(`${entry.id.padEnd(25)} ${entry.kind.padEnd(5)} ${entry.category.padEnd(20)} ${entry.name} [${setupBadge(entry)}]\n  ${entry.description}`);
      console.log(`\n${available.length} entries.`);
    }
    return;
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive && (!flags.install?.length || !flags.client || !flags.scope)) throw new Error('Use a terminal for interactive mode, or pass --client, --scope and --install. See --help.');
  if (flags.yes && !flags.install?.length) throw new Error('--yes requires explicit --install IDs');
  if (flags.json && !flags.install?.length) throw new Error('--json requires --list or explicit --install IDs');
  if (interactive && !flags.json) p.intro('Setup AI Installer');
  const client = flags.client ?? answer(await p.select({ message: 'Which harness?', options: clients.map(client => ({ value: client.id, label: client.name })) }));
  const scope = flags.scope ?? answer(await p.select({ message: 'Install for this project or your user account?', options: [
    { value: 'project', label: 'This project', hint: path.resolve(flags.project ?? process.cwd()) },
    { value: 'global', label: 'Every project for this user', hint: path.resolve(flags.home ?? os.homedir()) },
  ] }));
  let antigravitySurface = flags['antigravity-surface'];
  if (client === 'antigravity' && interactive && !flags.install) antigravitySurface = answer(await p.select({ message: 'Antigravity CLI or IDE?', options: [{ value: 'ide', label: 'IDE' }, { value: 'cli', label: 'CLI' }] }));
  let opencodeVersion = flags['opencode-version'];
  let selectedIds = flags.install?.flatMap(value => value.split(',').filter(Boolean));
  if (!selectedIds) {
    selectedIds = await pickCatalog(available, { client, scope, query: flags.search });
  }
  selectedIds = [...new Set(selectedIds)];
  if (!selectedIds.length) throw new Error('Select at least one entry');
  const selected = expandSelection(catalog, selectedIds);
  const added = selected.filter(entry => !selectedIds.includes(entry.id));
  if (added.length && !flags.json) console.log(`\nAlso needed: ${added.map(entry => entry.name).join(', ')}`);
  if (client === 'opencode' && selected.some(entry => entry.kind === 'mcp' && entry.install) && !opencodeVersion) {
    if (!interactive) throw new Error('Pass --opencode-version 1 or 2 for OpenCode MCP configuration');
    opencodeVersion = answer(await p.select({ message: 'Installed OpenCode major version', options: [{ value: '2', label: 'OpenCode 2' }, { value: '1', label: 'OpenCode 1' }] }));
  }
  const options = { client, scope, project: flags.project ?? process.cwd(), home: flags.home ?? os.homedir(), codexHome: flags.home ? undefined : process.env.CODEX_HOME,
    antigravitySurface, opencodeVersion };
  const plan = await planInstallation(selected, options);
  if (flags.json && flags['dry-run']) return console.log(JSON.stringify(plan.items.map(summary), null, 2));
  if (!flags.json) printPlan(plan);
  if (flags['dry-run']) return console.log('\nDry run. No files were written or downloaded.');
  if (!plan.items.some(item => item.status === 'ready')) {
    if (flags.json) console.log(JSON.stringify(plan.items.map(summary), null, 2));
    else console.log('\nNothing to install automatically. Follow the setup steps above.');
    if (plan.items.some(item => item.status === 'blocked')) process.exitCode = 1;
    return;
  }
  if (!flags.yes) {
    if (!interactive) throw new Error('No changes made. Use --yes to apply this explicit selection, or --dry-run to preview.');
    if (!answer(await p.confirm({ message: `Install ${plan.items.filter(item => item.status === 'ready').length} selected items?`, initialValue: false }))) {
      p.outro('No changes made.');
      return;
    }
  }
  const result = await applyInstallation(plan, { onProgress: message => { if (!flags.json) p.log.step(message); } });
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const item of result.results) p.log.message(`${item.name}: ${item.status}\n${item.detail ?? ''}${item.backup ? `\nBackup: ${item.backup}` : ''}`);
    p.outro(`Receipt: ${result.receipt}\nAnother project of mine: https://github.com/CuzImSlymi/parallel-agent-workflow`);
  }
  if (result.results.some(item => ['failed', 'blocked'].includes(item.status))) process.exitCode = 1;
}
