import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/process.js';

test('subprocesses receive literal arguments and npm resolves on this platform', async () => {
  const literal = 'spaces & $(not-a-command)';
  const result = await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal]);
  assert.equal(result.stdout, literal);
  const npm = await run('npm', ['--version']);
  assert.match(npm.stdout.trim(), /^\d+\.\d+\.\d+$/);
});
