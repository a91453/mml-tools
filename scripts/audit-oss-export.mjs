import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_PREFIXES = Object.freeze([
  'ops/',
  'railway/',
  '.openai/',
  'imports/',
  'private/',
  'songs/',
]);

const FORBIDDEN_EXACT = new Set([
  '.env',
  'dist/workbench-source.zip',
  // Polices imports/, which is never exported, and names a private song
  // package while doing so. The source repository keeps and runs it.
  'studio/tests/song-reference-packages.test.mjs',
]);

const FORBIDDEN_EXTENSIONS = new Set([
  '.mid', '.midi', '.m4a', '.mp3', '.wav', '.flac', '.pdf', '.zip', '.mxl', '.sqlite', '.db',
]);

// The six Manifest-indexed documents and the Manifest itself appear in shipped
// tests as Canonical locator strings, not as files to open: the vendored
// package carries their content in canonical/published.json and docs/canonical/.
const CANONICAL_LOCATOR_DOCUMENTS = new Set([
  'docs/MASTER_RULES.md',
  'docs/SOURCE_POLICY.md',
  'docs/MOBILE_SYNTAX.md',
  'docs/ACCEPTANCE_CRITERIA.md',
  'docs/PENDING.md',
  'docs/OFFICIAL_EVIDENCE.md',
  'docs/CANONICAL_MANIFEST.md',
]);

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'web-build', 'browser-results', '__pycache__']);

const SECRET_PATTERNS = Object.freeze([
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
]);

const normalize = path => path.replaceAll('\\', '/');

async function walk(root, dir = root, files = [], special = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = resolve(dir, entry.name);
    const rel = normalize(relative(root, full));
    if (entry.isDirectory()) await walk(root, full, files, special);
    else if (entry.isFile()) files.push(rel);
    else special.push(rel);
  }
  return { files, special };
}

const probablyText = path => !new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico']).has(extname(path).toLowerCase());

export async function auditOssExport(root) {
  const walked = await walk(root);
  const files = walked.files.sort();
  const violations = walked.special.map(path => ({ type: 'forbidden-special-file', path }));

  for (const path of files) {
    if (FORBIDDEN_EXACT.has(path) || FORBIDDEN_PREFIXES.some(prefix => path.startsWith(prefix))) {
      violations.push({ type: 'forbidden-path', path });
    }
    if (FORBIDDEN_EXTENSIONS.has(extname(path).toLowerCase())) {
      violations.push({ type: 'forbidden-binary-or-song-source', path });
    }
    if (!probablyText(path)) continue;
    let text;
    try {
      text = await readFile(resolve(root, path), 'utf8');
    } catch {
      violations.push({ type: 'unreadable-text', path });
      continue;
    }
    for (const [name, pattern] of SECRET_PATTERNS) {
      if (pattern.test(text)) violations.push({ type: 'secret-pattern', name, path });
    }
  }

  // Documents, both directions. A shipped regression that opens a document the
  // export left behind fails publicly for a private reason; a document no
  // shipped regression reads is publication by accident. Checking both pins the
  // exported document set to exactly the Canonical vendoring plus what the
  // suite actually needs, so it cannot drift either way.
  const shipped = new Set(files);
  const readByTests = new Set();
  for (const path of files.filter(file => file.endsWith('.test.mjs'))) {
    let text;
    try {
      text = await readFile(resolve(root, path), 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/["'`](docs\/[A-Za-z0-9_][A-Za-z0-9_./-]*\.md)["'`]/g)) {
      const referenced = match[1];
      if (CANONICAL_LOCATOR_DOCUMENTS.has(referenced)) continue;
      readByTests.add(referenced);
      if (!shipped.has(referenced)) violations.push({ type: 'test-reads-unexported-document', path, referenced });
    }
  }
  for (const path of files) {
    if (!path.startsWith('docs/') || path.startsWith('docs/canonical/')) continue;
    if (!readByTests.has(path)) violations.push({ type: 'unreferenced-exported-document', path });
  }

  for (const required of ['README.md', 'LICENSE', 'NOTICE.md', 'package.json', 'PUBLIC_EXPORT.json', 'canonical/published.json', 'studio/backend/bootstrap/index.mjs']) {
    if (!files.includes(required)) violations.push({ type: 'missing-required-file', path: required });
  }

  try {
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    if (pkg.license !== 'MIT') violations.push({ type: 'license-mismatch', path: 'package.json', actual: pkg.license ?? null });
  } catch (error) {
    violations.push({ type: 'invalid-package-json', path: 'package.json', message: error.message });
  }

  try {
    const bootstrap = await readFile(resolve(root, 'studio/backend/bootstrap/index.mjs'), 'utf8');
    if (!bootstrap.includes('STATIC_VENDORED_CANONICAL')) violations.push({ type: 'bootstrap-not-vendored', path: 'studio/backend/bootstrap/index.mjs' });
    if (bootstrap.includes('node:child_process') || bootstrap.includes('refs/remotes/origin/main')) {
      violations.push({ type: 'bootstrap-private-history-dependency', path: 'studio/backend/bootstrap/index.mjs' });
    }
  } catch {}

  return Object.freeze({
    ok: violations.length === 0,
    fileCount: files.length,
    files: Object.freeze(files),
    violations: Object.freeze(violations),
  });
}

async function main() {
  const target = resolve(process.argv[2] ?? '.');
  const info = await stat(target).catch(() => null);
  if (!info?.isDirectory()) throw Error(`Not a directory: ${target}`);
  const report = await auditOssExport(target);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
