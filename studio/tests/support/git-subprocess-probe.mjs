// Passive instrumentation for the M6 stress runner. Loaded through
// `NODE_OPTIONS=--import=<this file>` so every Node process in a test run,
// including test-file processes, spawned builds and the Bootstrap CLI, records
// each synchronous `git` child process it starts to `M6_PROBE_LOG` (JSON lines).
// It changes nothing about the call: the same result is returned and the same
// error is rethrown. It is not imported by any production module.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const log = process.env.M6_PROBE_LOG;
const original = cp.execFileSync;

if (log) {
  cp.execFileSync = function execFileSyncProbe(file, args, options) {
    if (file !== 'git') return original.apply(this, arguments);
    const t0 = Date.now();
    let ok = true, bytes = 0, hash = null, error = null;
    try {
      const out = original.apply(this, arguments);
      bytes = Buffer.byteLength(out);
      if (args[0] === 'show' || args[0] === 'cat-file') hash = createHash('sha256').update(out).digest('hex').slice(0, 16);
      return out;
    } catch (thrown) {
      ok = false;
      error = String(thrown?.message ?? thrown).split('\n')[0].slice(0, 200);
      throw thrown;
    } finally {
      const record = {
        pid: process.pid, ppid: process.ppid, entry: process.argv[1] ?? null,
        t0, t1: Date.now(), cwd: String(options?.cwd ?? process.cwd()),
        args: Array.from(args ?? []), input: typeof options?.input === 'string' ? options.input.slice(0, 400) : null,
        ok, bytes, hash, error,
      };
      appendFileSync(log, `${JSON.stringify(record)}\n`);
    }
  };
  syncBuiltinESMExports();
}
