// A command-line script runs its main() only when it is the entry module. The
// check must compare two filesystem paths: a percent-encoded URL pathname
// (`new URL(import.meta.url).pathname`) or a URL built by pasting a raw path
// (`file://${path}`) differs from the path whenever it holds a space, a
// non-ASCII character or '#', so the script exited 0 having done nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));

// [script, exit status, stream, what main() writes]. verify-studio-artifact
// has no --help: its main() reads `--help` as the artifact directory and
// refuses it, which is output all the same.
const SCRIPTS = [
  ['studio-reproduce-review', 0, 'stdout', /node scripts\/studio-reproduce-review\.mjs/],
  ['studio-lead-review-queue', 0, 'stdout', /node scripts\/studio-lead-review-queue\.mjs/],
  ['studio-microtiming-audit', 0, 'stdout', /node scripts\/studio-microtiming-audit\.mjs/],
  ['studio-release-timing-e2e', 0, 'stdout', /node scripts\/studio-release-timing-e2e\.mjs/],
  ['jev-routing-eval', 0, 'stdout', /node scripts\/jev-routing-eval\.mjs/],
  ['verify-studio-artifact', 1, 'stderr', /ARTIFACT_NOT_VERIFIED/],
  ['studio-agent', 0, 'stdout', /node scripts\/studio-agent\.mjs/],
];

test('scripts started from a path with a space, CJK and # still run main()', t => {
  // The entry module must really live there: Node resolves the entry's
  // symlinks, so scripts/ is a copy, and its siblings are links back to the
  // repository only so that its relative imports resolve.
  const root = mkdtempSync(join(tmpdir(), 'mml entry 音樂 #'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  assert.match(realpathSync(root), / .*音樂 #/, 'precondition: the real path holds a space, CJK and #');
  cpSync(join(repo, 'scripts'), join(root, 'scripts'), { recursive: true });
  for (const entry of readdirSync(repo)) {
    if (entry === 'scripts' || entry === '.git') continue;
    symlinkSync(join(repo, entry), join(root, entry), statSync(join(repo, entry)).isDirectory() ? 'junction' : 'file');
  }
  const silent = [];
  for (const [name, status, stream, output] of SCRIPTS) {
    const proc = spawnSync(process.execPath, [join(root, 'scripts', `${name}.mjs`), '--help'], {
      cwd: root, encoding: 'utf8', input: '', timeout: 120000, windowsHide: true,
    });
    if (proc.status === status && output.test(proc[stream])) continue;
    silent.push({ name, status: proc.status, stdout: proc.stdout.slice(0, 200), stderr: proc.stderr.slice(0, 200) });
  }
  assert.deepEqual(silent, [], 'every script runs main() instead of exiting without output');
});
