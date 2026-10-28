import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { folderContents, pickCatalog, promptWithBack } from '../src/picker.js';

const make = (id, category, languages = [], extra = {}) => ({
  id, name: id, kind: 'skill', category, languages, description: `Description for ${id}`,
  why: '', source: 'https://example.com/author', tags: [], clients: ['codex'], setup: [],
  install: { type: 'skill' }, ...extra,
});
const entries = [make('ui-python', 'ui', ['python'], { alsoIn: ['context', 'ui'] }), make('swift-tool', 'languages', ['swift']),
  make('writing-tool', 'writing'), make('unavailable', 'ui', [], { clients: ['opencode'] }),
  make('global-command', 'ui', [], { kind: 'cli', install: { type: 'command', scope: 'global' } })];
function scripted(steps) {
  return {
    async autocomplete(options) {
      const step = steps.shift();
      assert.equal(step.type, 'menu');
      if (step.check) step.check(options);
      if (step.input) options.filter(step.input, options.options.find(x => x.value === 'search'));
      const choice = options.options.find(x => x.value === step.value);
      assert.ok(choice, `missing menu choice ${step.value}`);
      assert.ok(!choice.disabled, `menu choice ${step.value} disabled`);
      return step.value;
    },
    async autocompleteMultiselect(options) {
      const step = steps.shift();
      assert.equal(step.type, 'items');
      if (typeof options.options === 'function') options.options = options.options.call({ selectedValues: options.initialValues });
      if (step.check) step.check(options);
      for (const value of step.value) assert.ok(options.options.some(x => x.value === value && !x.disabled));
      return step.value;
    },
  };
}

test('folder hierarchy exposes the same entry in UI and its language', () => {
  const root = folderContents(entries);
  assert.deepEqual(root.folders.slice(0, 3).map(x => x.label), ['UI', 'Token saving', 'Language specific']);
  assert.deepEqual(folderContents(entries, ['Language specific']).folders.map(x => x.label), ['Python', 'Swift']);
  assert.equal(folderContents(entries, ['UI']).items[0].id, 'ui-python');
  assert.equal(folderContents(entries, ['Token saving']).items[0].id, 'ui-python');
  assert.equal(root.folders.find(folder => folder.label === 'UI').ids.filter(id => id === 'ui-python').length, 1);
  assert.equal(folderContents(entries, ['Language specific', 'Python']).items[0].id, 'ui-python');
});

test('Escape saves selection changes and Ctrl+C still quits', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const options = { message: 'Tools', input, output, initialValues: ['first'], options: [{ value: 'first' }, { value: 'second' }],
    filter: (search, option) => option.value.includes(search.trim()) };
  const selected = promptWithBack('autocompleteMultiselect', options);
  input.emit('keypress', '\t', { name: 'tab', sequence: '\t' });
  input.emit('keypress', undefined, { name: 'down', sequence: '\x1b[B' });
  input.emit('keypress', '\t', { name: 'tab', sequence: '\t' });
  input.emit('keypress', '\x1b', { name: 'escape', sequence: '\x1b' });
  assert.deepEqual(await selected, ['second']);
  assert.equal(input.listenerCount('keypress'), 0);

  const back = promptWithBack('autocomplete', options);
  input.emit('keypress', '\x1b', { name: 'escape', sequence: '\x1b' });
  assert.equal(await back, 'back');
  const cancelled = promptWithBack('autocomplete', options);
  input.emit('keypress', '\x03', { name: 'c', ctrl: true, sequence: '\x03' });
  await assert.rejects(cancelled, /Cancelled/);
  assert.equal(input.listenerCount('keypress'), 0);
  input.destroy();
  output.destroy();
});

test('Escape works through consecutive prompts with keyboard input', { timeout: 3000 }, async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const options = { message: 'Tools', input, output, options: [{ value: 'first' }, { value: 'second' }],
    filter: (search, option) => option.value.includes(search.trim()) };
  try {
    const tools = promptWithBack('autocompleteMultiselect', options);
    input.write('\t');
    input.write('\x1b');
    assert.deepEqual(await tools, ['first']);
    const menu = promptWithBack('autocomplete', options);
    input.write('second\r');
    assert.equal(await menu, 'second');
    const nestedMenu = promptWithBack('autocomplete', options);
    input.write('\x1b');
    assert.equal(await nestedMenu, 'back');
  } finally { input.destroy(); output.destroy(); }
});

test('selection persists across folders and duplicates can be deselected', async () => {
  const steps = [
    { type: 'menu', value: 'folder:UI', check: o => assert.equal(o.options.find(x => x.value === 'review').disabled, true) },
    { type: 'items', value: ['ui-python'], check: o => {
      assert.equal(o.options.find(x => x.value === 'unavailable').disabled, true);
      assert.equal(o.options.find(x => x.value === 'global-command').disabled, true);
      assert.match(o.options.find(x => x.value === 'ui-python').hint, /Description/);
    } },
    { type: 'menu', value: 'folder:Writing' }, { type: 'items', value: ['writing-tool'] },
    { type: 'menu', value: 'folder:Language specific' }, { type: 'menu', value: 'folder:Python' },
    { type: 'items', value: [], check: o => assert.deepEqual(o.initialValues, ['ui-python']) },
    { type: 'menu', value: 'back' },
    { type: 'menu', value: 'review', check: o => {
      assert.equal(o.options.find(x => x.value === 'review').disabled, false);
      const visible = o.options.filter(option => o.filter('review', option));
      assert.deepEqual(visible.map(option => option.value), ['review']);
    } },
  ];
  const chosen = await pickCatalog(entries, { client: 'codex', scope: 'project' }, scripted(steps));
  assert.deepEqual(chosen, ['writing-tool']);
  assert.equal(steps.length, 0);
});

test('global search carries the query and retains selections outside the results', async () => {
  const steps = [
    { type: 'menu', value: 'folder:Writing' }, { type: 'items', value: ['writing-tool'] },
    { type: 'menu', value: 'search', input: 'python' },
    { type: 'items', value: ['ui-python'], check: o => {
      assert.match(o.message, /Search: python/);
      assert.deepEqual(o.options.map(x => x.value), ['ui-python']);
      assert.equal(o.filter('python', o.options[0]), true);
    } },
    { type: 'menu', value: 'review' },
  ];
  assert.deepEqual(await pickCatalog(entries, { client: 'codex', scope: 'project' }, scripted(steps)), ['writing-tool', 'ui-python']);
  assert.equal(steps.length, 0);
});
