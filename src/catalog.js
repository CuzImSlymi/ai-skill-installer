import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const identifier = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const text = value => typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value);
const strings = value => Array.isArray(value) && value.every(text);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateCatalog(entries) {
  if (!Array.isArray(entries)) throw new Error('Catalog must be an array');
  const seen = new Set();
  for (const entry of entries) {
    const fail = message => { throw new Error(`Catalog ${entry?.id ?? 'entry'}: ${message}`); };
    if (!object(entry) || !identifier.test(entry.id) || seen.has(entry.id)) fail('invalid or duplicate id');
    seen.add(entry.id);
    for (const key of ['name', 'category', 'description', 'why', 'source', 'license', 'reviewedAt']) {
      if (typeof entry[key] !== 'string' || !entry[key].trim() || /[\x00-\x1f\x7f]/.test(entry[key])) fail(`invalid ${key}`);
    }
    if (!['skill', 'mcp', 'cli'].includes(entry.kind)) fail('invalid kind');
    if (!strings(entry.tags) || !strings(entry.cautions) || !strings(entry.clients) || !entry.clients.length) fail('invalid tags, cautions, or clients');
    if (entry.languages !== undefined && (!strings(entry.languages) || !entry.languages.length || entry.languages.some(language => !identifier.test(language)))) fail('invalid languages');
    if (entry.alsoIn !== undefined && (!strings(entry.alsoIn) || entry.alsoIn.some(category => !identifier.test(category)))) fail('invalid extra categories');
    if ([entry.category, ...(entry.alsoIn ?? [])].includes('languages') && !entry.languages?.length) fail('language-specific entries need languages');
    if (!Array.isArray(entry.setup) || entry.setup.some(step => !object(step) || !text(step.label) || !text(step.detail))) fail('invalid setup');
    if (entry.requires !== undefined && !strings(entry.requires)) fail('invalid dependencies');
    if (entry.requires?.length && entry.kind !== 'skill') fail('only skills can declare companion dependencies');
    if (!/^https:\/\//.test(entry.source)) fail('source must be HTTPS');
    const recipe = entry.install;
    if (recipe === null) continue;
    if (!object(recipe)) fail('invalid install recipe');
    if (recipe.type === 'skill') {
      if (entry.kind !== 'skill' || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(recipe.repo) || !/^[a-f0-9]{40}$/.test(recipe.ref)) fail('skill requires canonical GitHub repo and full commit SHA');
      if (typeof recipe.path !== 'string' || recipe.path.split('/').some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9_.-]+$/.test(part))) fail('unsafe skill path');
      if (recipe.name !== undefined && (!identifier.test(recipe.name) || recipe.name.length > 64)) fail('invalid skill destination name');
    } else if (recipe.type === 'mcp') {
      if (entry.kind !== 'mcp' || !object(recipe.server) || !['http', 'stdio'].includes(recipe.server.transport)) fail('invalid MCP recipe');
      if (recipe.server.transport === 'stdio' && (!text(recipe.server.command) || !strings(recipe.server.args) || !strings(recipe.server.env))) fail('invalid stdio command');
    } else if (recipe.type === 'command') {
      if (entry.kind !== 'cli' || recipe.command !== 'npm' || !strings(recipe.args) || recipe.args[0] !== 'install' || !['project', 'global'].includes(recipe.scope)) fail('invalid CLI recipe');
      const global = recipe.args.includes('--global') || recipe.args.includes('-g');
      if ((recipe.scope === 'global') !== global) fail('CLI arguments must match the declared scope');
      const packages = recipe.args.slice(1).filter(arg => !arg.startsWith('-'));
      if (!packages.length || packages.some(arg => !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+@[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(arg))) fail('CLI package must use an exact version');
      if (recipe.args.some(arg => arg.startsWith('-') && !['--global', '-g', '--save-dev', '-D', '--save-exact'].includes(arg))) fail('unsupported npm install flag');
    } else fail('unknown recipe type');
  }
  expandSelection(entries, entries.map(entry => entry.id));
  return entries;
}

export function expandSelection(catalog, ids) {
  const selected = new Map();
  const visiting = new Set();
  function add(id) {
    if (visiting.has(id)) throw new Error(`Circular catalog dependency: ${id}`);
    if (selected.has(id)) return;
    const entry = catalog.find(item => item.id === id);
    if (!entry) throw new Error(`Unknown catalog ID: ${id}. Use --list to find entries.`);
    visiting.add(id);
    for (const dependency of entry.requires ?? []) add(dependency);
    visiting.delete(id);
    selected.set(id, entry);
  }
  for (const id of ids) add(id);
  return [...selected.values()];
}

export async function loadCatalog(directory = fileURLToPath(new URL('../catalog/', import.meta.url))) {
  const files = (await readdir(directory)).filter(file => file.endsWith('.json')).sort();
  const lists = await Promise.all(files.map(async file => JSON.parse(await readFile(path.join(directory, file), 'utf8'))));
  if (lists.some(list => !Array.isArray(list))) throw new Error('Each catalog file must contain an array');
  return validateCatalog(lists.flat());
}

export function matches(entry, search = '') {
  const text = [entry.id, entry.name, entry.kind, entry.category, entry.description, entry.why, entry.source, ...entry.tags, ...(entry.languages ?? [])].join(' ').toLowerCase();
  return search.toLowerCase().trim().split(/\s+/).every(word => text.includes(word));
}

export function setupBadge(entry) {
  if (!entry.install) return 'Manual setup';
  if (entry.kind === 'skill') return 'Skill folder';
  if (entry.setup.some(step => /optional.*(?:key|account)/i.test(step.detail))) return 'Optional key / setup';
  const auth = entry.setup.find(step => /auth|key|sign.in|account/i.test(step.label + ' ' + step.detail));
  return auth ? 'Requires setup / auth' : entry.install.type === 'command' ? 'Installs CLI' : 'Runtime / setup';
}
