import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// OSS Export CI must run whenever something the public export ships changes.
// Its path filter listed only part of what scripts/export-oss.mjs copies, so a
// change to, say, tests/mcp-studio.test.mjs or scripts/build-studio-web.mjs --
// both executed by the public `npm test` and `npm run build` -- never ran the
// export check.

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = path => readFileSync(resolve(root, path), 'utf8');

function exportedPaths() {
  const script = read('scripts/export-oss.mjs');
  const files = [...script.matchAll(/copyFile\('([^']+)'\)/g)].map(m => m[1]);
  for (const block of script.matchAll(/for \(const path of \[([\s\S]*?)\]\) await copyFile\(path\);/g)) {
    files.push(...[...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]));
  }
  const trees = [...script.matchAll(/copyTree\('([^']+)'\)/g)].map(m => `${m[1]}/`);
  return { files, trees };
}

function filterPaths(trigger) {
  const yaml = read('.github/workflows/oss-export-ci.yml');
  const block = yaml.match(new RegExp(`\\n  ${trigger}:\\n([\\s\\S]*?)\\n  [a-z_]+:`));
  assert.ok(block, `the ${trigger} trigger is present`);
  const paths = `\n${block[1]}`.match(/\n    paths:\n((?:      - .+\n?)+)/);
  assert.ok(paths, `the ${trigger} trigger has a paths filter`);
  return [...paths[1].matchAll(/- '([^']+)'/g)].map(m => m[1]);
}

const globToRegExp = glob => new RegExp(`^${glob.split('**').map(part => part.split('*').map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`);
const covered = (patterns, path) => patterns.some(pattern => globToRegExp(pattern).test(path));

test('the export script copies what this test can see', () => {
  const { files, trees } = exportedPaths();
  assert.ok(files.includes('tests/mcp-studio.test.mjs') && files.includes('scripts/build-studio-web.mjs'), files.join(', '));
  assert.deepEqual(trees.sort(), ['server/', 'studio/']);
});

for (const trigger of ['pull_request', 'push']) {
  test(`every exported path triggers OSS Export CI on ${trigger}`, () => {
    const patterns = filterPaths(trigger);
    const { files, trees } = exportedPaths();
    const missing = [
      ...files.filter(path => !covered(patterns, path)),
      ...trees.filter(tree => !covered(patterns, `${tree}any/file.mjs`)),
      ...['scripts/export-oss.mjs', 'oss/public/package.json', 'package.json', '.github/workflows/oss-export-ci.yml', 'tests/oss-export-ci-policy.test.mjs'].filter(path => !covered(patterns, path)),
    ];
    assert.deepEqual(missing, []);
  });
}

test('the public package pins the same dependencies as the repository', () => {
  const pub = JSON.parse(read('oss/public/package.json'));
  const own = JSON.parse(read('package.json'));
  assert.deepEqual(pub.dependencies, own.dependencies);
  assert.deepEqual(pub.devDependencies, own.devDependencies);
});
