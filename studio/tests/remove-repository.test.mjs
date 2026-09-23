import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { removeRepository } from './support/remove-repository.mjs';

// A detached process that keeps adding files for a while, as Git's detached
// auto-maintenance does after a fetch.
test('a repository still being written by a background process is removed once it stops', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mml-remove-'));
  const objects = join(dir, 'objects');
  mkdirSync(objects);
  const writer = spawn(process.execPath, ['-e', `
    const fs = require('node:fs'); const end = Date.now() + 250; let n = 0;
    while (Date.now() < end) { try { fs.writeFileSync(${JSON.stringify(objects)} + '/f' + n++, 'x'); } catch {} }`],
    { stdio: 'ignore' });
  const exited = new Promise(resolve => writer.on('exit', resolve));
  while (!existsSync(objects) || readdirSync(objects).length === 0) await delay(5);
  await removeRepository(dir);
  assert.equal(existsSync(dir), false);
  await exited;
});

test('errors other than ENOTEMPTY are not retried', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mml-remove-')), 'plain');
  writeFileSync(file, 'x');
  await assert.rejects(removeRepository(join(file, 'child'), { attempts: 3, delayMs: 1000 }), { code: 'ENOTDIR' });
});
