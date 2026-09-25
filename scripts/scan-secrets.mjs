// Credential scan over every file Git tracks. The repository, its history
// included, is public, so a committed credential is published the moment it
// is pushed. The patterns are the ones the retired public-export audit used
// (scripts/audit-oss-export.mjs); that audit only ever saw the exported
// subset, while this scan covers the whole repository and runs on every pull
// request and push (Studio CI's classify job, and `npm test`).
//
// Deployment credentials belong in the deployment's own environment variables
// and secret stores (SECURITY.md). A match fails the scan; the only exceptions
// are the exact, obviously synthetic values below, which tests use to prove
// that credential shapes are redacted.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECRET_PATTERNS = Object.freeze([
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
]);

// Synthetic values only: each is a plain alphabet run, never a credential.
export const SYNTHETIC_VALUES = Object.freeze(new Set([
  // tests/railway-deployment-diagnostics.test.mjs: the log sanitizer's input.
  'github_pat_abcdefghijklmnopqrstuvwxyz123456',
]));

export function scanText(text) {
  const found = [];
  for (const [name, pattern] of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (SYNTHETIC_VALUES.has(match[0])) continue;
      found.push({ name, line: text.slice(0, match.index).split('\n').length });
    }
  }
  return found;
}

// A file with a NUL byte is binary (release archives, images); the patterns
// are text, and a binary's bytes would only produce noise.
const isBinary = bytes => bytes.subarray(0, 8192).includes(0);

export function scanRepository(root = resolve(fileURLToPath(new URL('../', import.meta.url)))) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean);
  const findings = [];
  for (const path of files) {
    let bytes;
    try { bytes = readFileSync(resolve(root, path)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (isBinary(bytes)) continue;
    for (const hit of scanText(bytes.toString('utf8'))) findings.push({ path, ...hit });
  }
  return { files: files.length, findings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { files, findings } = scanRepository();
  // Names the pattern and the place, never the matched value.
  for (const f of findings) console.error(`${f.path}:${f.line}: ${f.name}`);
  console.log(JSON.stringify({ files, findings: findings.length }));
  if (findings.length) process.exitCode = 1;
}
