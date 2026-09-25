import test from 'node:test';
import assert from 'node:assert/strict';
import { SECRET_PATTERNS, SYNTHETIC_VALUES, scanRepository, scanText } from '../scripts/scan-secrets.mjs';

// The repository is public, history included: no tracked file may carry a
// credential shape. Runs in Studio CI's classify job on every pull request and
// push, before any path classification, as well as in `npm test`.

// Samples are assembled at runtime so this file never matches itself.
const join = (...parts) => parts.join('');
const SAMPLES = {
  'private-key': join('-----BEGIN ', 'PRIVATE KEY-----'),
  'github-token': join('ghp', '_', 'Zq8vN2mT5xK1pR7wY4bC9dF3gH6jL0sA'),
  'anthropic-key': join('sk', '-ant-', 'api03-Zq8vN2mT5xK1pR7wY4bC9dF3'),
  'openai-key': join('sk', '-proj-', 'Zq8vN2mT5xK1pR7wY4bC9dF3gH6j'),
  'aws-access-key': join('AK', 'IA', 'Z7Q2M5T8X1K4P6W9'),
};

test('no tracked file carries a credential shape', () => {
  const { files, findings } = scanRepository();
  assert.ok(files > 300, 'the scan reads the whole repository');
  assert.deepEqual(findings, []);
});

test('every pattern catches its credential shape, and reports where', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), SECRET_PATTERNS.map(([name]) => name).sort());
  for (const [name, sample] of Object.entries(SAMPLES)) {
    // An Anthropic key is also OpenAI-shaped (`sk-…`); both names are reported.
    const found = scanText(`line one\nvalue = ${sample}\n`);
    assert.ok(found.some(hit => hit.name === name), name);
    assert.ok(found.every(hit => hit.line === 2), `${name} line`);
  }
});

test('only the exact synthetic values are exempt', () => {
  for (const value of SYNTHETIC_VALUES) {
    assert.deepEqual(scanText(value), []);
    assert.equal(scanText(`${value}X`).length, 1, 'a longer value is not the synthetic one');
  }
});
