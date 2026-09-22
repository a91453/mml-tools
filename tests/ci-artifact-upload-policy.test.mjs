import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function uploadArtifactBlocks(yaml) {
  const lines = yaml.split(/\r?\n/);
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('uses: actions/upload-artifact@v4')) continue;
    const indent = lines[i].match(/^\s*/)[0].length;
    let block = lines[i];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      const trimmed = line.trim();
      const lineIndent = line.match(/^\s*/)[0].length;
      if (trimmed && lineIndent <= indent && /^-\s/.test(trimmed)) break;
      block += '\n' + line;
    }
    if (!/^\s*continue-on-error:\s*true\s*$/m.test(block)) {
      violations.push({ line: i + 1, block });
    }
  }
  return violations;
}

test('Wait-for-CI Studio workflows do not fail only because optional artifact storage failed', () => {
  for (const path of [
    '.github/workflows/studio-ci.yml',
    '.github/workflows/studio-service-ci.yml',
  ]) {
    const violations = uploadArtifactBlocks(read(path));
    assert.deepEqual(
      violations,
      [],
      `${path} has blocking actions/upload-artifact steps: ${violations.map(v => v.line).join(', ')}`,
    );
  }
});
