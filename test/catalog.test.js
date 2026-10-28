import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog, validateCatalog, expandSelection, matches } from '../src/catalog.js';

test('catalog is validated and dependencies expand once in dependency order', async () => {
  const catalog = await loadCatalog();
  assert.ok(catalog.length > 0);
  const example = catalog.find(item => item.requires?.length);
  assert.ok(example);
  const expanded = expandSelection(catalog, [example.id, example.id]);
  assert.equal(expanded.at(-1).id, example.id);
  assert.equal(new Set(expanded.map(x => x.id)).size, expanded.length);
  assert.ok(example.requires.every(id => expanded.findIndex(x => x.id === id) < expanded.length - 1));
  assert.throws(() => expandSelection(catalog, ['unknown-id']), /Unknown catalog ID/);
  assert.ok(matches(example, example.tags[0]));
  assert.ok(matches(example, `${example.kind.toUpperCase()} ${example.name.split(' ')[0]}`));
  assert.equal(matches(example, 'unlikely-not-a-match-12345'), false);
});

test('invalid and circular dependencies are rejected', async () => {
  const original = (await loadCatalog())[0];
  const a = { ...original, id: 'a', requires: ['missing'] };
  assert.throws(() => validateCatalog([a]), /Unknown catalog ID/);
  const b = { ...original, id: 'b', requires: ['a'] };
  assert.throws(() => validateCatalog([{ ...a, requires: ['b'] }, b]), /Circular/);
  assert.throws(() => validateCatalog([{ ...a, requires: 'b' }]), /invalid dependencies/);
  assert.throws(() => validateCatalog([{ ...original, tags: ['ok\nnot-ok'] }]), /invalid tags/);
  assert.throws(() => validateCatalog([{ ...original, category: 'languages', languages: undefined }]), /need languages/);
  assert.throws(() => validateCatalog([{ ...original, languages: ['../python'] }]), /invalid languages/);
  assert.throws(() => validateCatalog([{ ...original, alsoIn: 'context' }]), /invalid extra categories/);
  assert.throws(() => validateCatalog([{ ...original, alsoIn: ['../context'] }]), /invalid extra categories/);
  const ponytail = (await loadCatalog()).find(entry => entry.id === 'ponytail');
  assert.equal(ponytail.category, 'code-quality');
  assert.ok(ponytail.alsoIn.includes('context'));
  assert.ok(matches({ ...original, languages: ['example-language'] }, 'example-language'));
});
