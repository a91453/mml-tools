// Diagnostic preflight only. Source parse success is not a music/gate verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const name of ['audio-report-history.mjs', 'review-service.mjs', 'review-service-core.mjs']) {
  test(`audio revision checked source identity and syntax: ${name}`, t => {
    const path = fileURLToPath(new URL(`../studio/backend/application/${name}`, import.meta.url));
    const bytes = readFileSync(path);
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    t.diagnostic(JSON.stringify({ file: name, bytes: bytes.length, git_blob_sha1: blob, sha256, node: process.version }));
    const checked = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', timeout: 20000 });
    assert.ifError(checked.error);
    assert.equal(checked.status, 0, `${name}: ${checked.stderr || checked.stdout}`);
  });
}
