import * as p from '@clack/prompts';
import { matches, setupBadge } from './catalog.js';

const categoryNames = {
  ui: 'UI', context: 'Token saving', 'reverse-engineering': 'Reverse engineering',
  languages: 'Language specific', 'code-quality': 'Code quality', workflow: 'Workflows',
  writing: 'Writing', browser: 'Browser & testing', documentation: 'Documentation',
  debugging: 'Debugging', cloud: 'Cloud & deployment', database: 'Databases', 'source-control': 'Git & hosting',
};
const languageNames = { python: 'Python', rust: 'Rust', swift: 'Swift', javascript: 'JavaScript', typescript: 'TypeScript', go: 'Go', sql: 'SQL', cpp: 'C++', csharp: 'C#' };
const firstFolders = ['UI', 'Token saving', 'Reverse engineering', 'Language specific'];
const title = value => value.replace(/-/g, ' ').replace(/^./, letter => letter.toUpperCase());
const startsWithPath = (full, prefix) => prefix.every((part, index) => full[index] === part);

export function folderPaths(entry) {
  const result = [];
  for (const category of new Set([entry.category, ...(entry.alsoIn ?? [])])) {
    if (category !== 'languages') result.push([categoryNames[category] ?? title(category)]);
  }
  for (const language of entry.languages ?? []) result.push(['Language specific', languageNames[language] ?? title(language)]);
  if (!result.length) result.push(['Language specific', 'General']);
  return result;
}

export function folderContents(entries, current = []) {
  const children = new Map();
  const items = new Map();
  for (const entry of entries) for (const route of folderPaths(entry)) {
    if (!startsWithPath(route, current)) continue;
    if (route.length === current.length) items.set(entry.id, entry);
    else {
      const label = route[current.length];
      if (!children.has(label)) children.set(label, new Set());
      children.get(label).add(entry.id);
    }
  }
  const folders = [...children].map(([label, ids]) => ({ label, path: [...current, label], ids: [...ids] }));
  folders.sort((a, b) => {
    const rank = label => firstFolders.includes(label) ? firstFolders.indexOf(label) : firstFolders.length;
    return rank(a.label) - rank(b.label) || a.label.localeCompare(b.label);
  });
  return { folders, items: [...items.values()] };
}

export function answer(value) {
  if (p.isCancel(value)) throw new Error('Cancelled. No further changes were made.');
  return value;
}

export async function promptWithBack(method, options, prompts = p) {
  const input = options.input ?? process.stdin;
  const multiple = method === 'autocompleteMultiselect';
  let escaped = false;
  let selected = options.initialValues ?? [];
  let activePrompt;
  const onKey = (_, key) => {
    escaped = key?.name === 'escape';
    if (escaped && activePrompt) selected = [...activePrompt.selectedValues];
  };
  input.prependListener('keypress', onKey);
  try {
    const result = await prompts[method]({
      ...options,
      input,
      // Clack returns a cancel symbol on Esc, so keep its current selections.
      ...(multiple ? { options() { activePrompt = this; return options.options; } } : {}),
    });
    if (p.isCancel(result) && escaped) return multiple ? selected : 'back';
    return answer(result);
  } finally { input.removeListener('keypress', onKey); }
}

export async function pickCatalog(entries, { client, scope, query = '' }, prompts = p) {
  const selected = new Set();
  let current = [];
  async function pickItems(items, label, search = '') {
    const visible = search ? items.filter(entry => matches(entry, search)) : items;
    if (!visible.length) return;
    const chosen = await promptWithBack('autocompleteMultiselect', {
      message: `${label} / ${selected.size} selected | Enter/Esc: back`,
      required: false,
      maxItems: 9,
      initialValues: visible.filter(entry => selected.has(entry.id)).map(entry => entry.id),
      options: visible.map(entry => {
        const unavailable = !entry.clients.includes(client) ? 'Not available for this harness.' :
          entry.install?.type === 'command' && entry.install.scope !== scope ? `Requires ${entry.install.scope} scope.` : '';
        const badge = !entry.clients.includes(client) ? `${entry.clients.join(', ')} only` :
          unavailable ? `${entry.install.scope} only` : setupBadge(entry);
        return { value: entry.id, label: `${entry.name} [${badge}]`,
          hint: `${entry.description}${unavailable ? ` ${unavailable}` : ''}`,
          disabled: Boolean(unavailable) };
      }),
      filter: (search, option) => matches(visible.find(entry => entry.id === option.value), search),
    }, prompts);
    for (const entry of visible) selected.delete(entry.id);
    for (const id of chosen) selected.add(id);
  }
  if (query) await pickItems(entries, `Search: ${query}`, query);
  while (true) {
    const { folders, items } = folderContents(entries, current);
    let search = '';
    const action = await promptWithBack('autocomplete', {
      message: `${current.join(' / ') || 'Browse folders'} / ${selected.size} selected | Esc: ${current.length ? 'back' : 'quit'}`,
      maxItems: 12,
      options: [
        ...folders.map(folder => ({ value: `folder:${folder.label}`, label: `${folder.label}/`,
          hint: `${folder.ids.length} tools, ${folder.ids.filter(id => selected.has(id)).length} selected` })),
        ...(items.length ? [{ value: 'items', label: 'Choose tools', hint: `${items.length} tools in this folder` }] : []),
        { value: 'search', label: 'Search all tools', hint: 'Search by name, language, author or task.' },
        ...(current.length ? [{ value: 'back', label: 'Back [Esc]', hint: 'Go up one folder.' }] : []),
        { value: 'review', label: `Review selection (${selected.size})`, hint: 'Review setup and install.', disabled: selected.size === 0 },
      ],
      filter: (input, option) => {
        search = input.trim();
        if (['review', 'back', 'search'].includes(search.toLowerCase())) return option.value === search.toLowerCase();
        if (option.value === 'search') return true;
        if (!search) return true;
        if (option.value.startsWith('folder:')) {
          const folder = folders.find(folder => `folder:${folder.label}` === option.value);
          return option.label.toLowerCase().includes(search.toLowerCase()) || entries.some(entry => folder.ids.includes(entry.id) && matches(entry, search));
        }
        return option.label.toLowerCase().includes(search.toLowerCase());
      },
    }, prompts);
    if (action === 'review') return [...selected];
    if (action === 'back') {
      if (!current.length) throw new Error('Cancelled. No changes made.');
      current = current.slice(0, -1);
      continue;
    }
    if (action === 'search') { await pickItems(entries, search ? `Search: ${search}` : 'Search all tools', search); continue; }
    if (action === 'items') { await pickItems(items, current.join(' / ')); continue; }
    const folder = folders.find(folder => `folder:${folder.label}` === action);
    current = folder.path;
    const contents = folderContents(entries, current);
    if (!contents.folders.length) {
      await pickItems(contents.items, current.join(' / '));
      current = current.slice(0, -1);
    }
  }
}
