// Guards the one thing in the GPUtw continuation notes a reader copies verbatim.
// The document is implementation notes, not Canonical policy; only the snippet's
// structural correctness is asserted here, never its advice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const doc = readFileSync(fileURLToPath(new URL('../docs/GPUTW_AI_CONTINUATION.md', import.meta.url)), 'utf8');

test('the Codex TOML snippet selects the provider at the top level', () => {
  const blocks = [...doc.matchAll(/```toml\n([\s\S]*?)```/g)].map(match => match[1]);
  assert.equal(blocks.length, 1, 'expected exactly one toml snippet to guard');
  const lines = blocks[0].split('\n');
  const firstTable = lines.findIndex(line => line.trimStart().startsWith('['));
  assert.ok(firstTable > -1, 'snippet should declare a provider table');

  // A TOML table stays active until the next table header, and a blank line does
  // not end it. Selection keys written below [model_providers.*] silently become
  // fields of that provider, leaving nothing selected.
  const keyAt = name => lines.findIndex(line => new RegExp(`^\\s*${name}\\s*=`).test(line));
  for (const key of ['model_provider', 'model']) {
    const index = keyAt(key);
    assert.ok(index > -1, `snippet should set ${key}`);
    assert.ok(index < firstTable, `${key} must appear before the first table header, not inside it`);
  }
});
