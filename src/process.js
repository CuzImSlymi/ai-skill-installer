import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function run(command, args, options = {}) {
  if (command === 'npm' && process.platform === 'win32') {
    const candidates = [
      process.env.npm_execpath,
      path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].filter(candidate => candidate && path.basename(candidate) === 'npm-cli.js');
    let npm;
    for (const candidate of candidates) {
      try { await access(candidate); npm = candidate; break; } catch {}
    }
    if (!npm) throw new Error('Cannot locate npm-cli.js. Install Node.js with npm, then retry.');
    args = [npm, ...args];
    command = process.execPath;
  }
  try {
    return await execute(command, args, { windowsHide: true, timeout: 300_000, maxBuffer: 2 * 1024 * 1024, ...options });
  } catch (error) {
    // Command output may contain credentials; keep it out of error messages.
    throw new Error(`${path.basename(command)} failed${error.code ? ` (${error.code})` : ''}. Check the prerequisites and run the displayed command manually.`, { cause: error });
  }
}
