import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Studio CI and Studio Service CI skip their heavy jobs (the full `npm test`
// run, the browser suites) when a change touches only "Railway-only" paths,
// because Railway ops CI covers those. That is only true while no test outside
// Railway ops CI reads one of those paths. railway/service-settings.json was
// on the list while tests/deployment-topology.test.mjs and
// tests/railway-canonical-image.test.mjs check its watchPatterns against what
// the image ships, so a PR that dropped a watch pattern skipped exactly the
// tests that would have caught it.

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = path => readFileSync(resolve(root, path), 'utf8');

function railwayOnlyPaths(workflow) {
  const match = read(workflow).match(/case "\$path" in\s*\n\s*([^\n]+)\)\s*\n\s*;;/);
  assert.ok(match, `${workflow} has a Railway-only classification case`);
  return match[1].split('|');
}

const OPS_TESTS = [...new Set([...read('.github/workflows/railway-ops-ci.yml').matchAll(/tests\/[\w.-]+\.test\.mjs/g)].map(m => m[0]))];
const TEST_FILES = [
  ...readdirSync(resolve(root, 'tests')).map(name => `tests/${name}`),
  ...readdirSync(resolve(root, 'studio/tests')).map(name => `studio/tests/${name}`),
].filter(path => path.endsWith('.test.mjs'))
  // This file reads the workflows by design and runs in every classify job,
  // before the classification, so no path can skip it.
  .filter(path => path !== 'tests/ci-classify-policy.test.mjs');

test('both heavy workflows classify the same Railway-only paths', () => {
  assert.deepEqual(railwayOnlyPaths('.github/workflows/studio-service-ci.yml'), railwayOnlyPaths('.github/workflows/studio-ci.yml'));
});

test('no test that only the heavy jobs run reads a path classified as Railway-only', () => {
  assert.ok(OPS_TESTS.length > 0, 'Railway ops CI names the tests it runs');
  const light = railwayOnlyPaths('.github/workflows/studio-ci.yml');
  const skipped = [];
  for (const file of TEST_FILES) {
    if (OPS_TESTS.includes(file) || light.includes(file)) continue;
    const text = read(file);
    for (const path of light) if (text.includes(path)) skipped.push(`${file} reads ${path}`);
  }
  assert.deepEqual(skipped, [], 'a change to these paths would skip the tests that read them');
});

test('Railway settings changes run the watch-pattern tests', () => {
  const light = railwayOnlyPaths('.github/workflows/studio-ci.yml');
  assert.equal(light.includes('railway/service-settings.json'), false);
  assert.equal(light.includes('railway/deployment-target.json'), false);
});
