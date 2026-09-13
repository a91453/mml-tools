import { readFileSync } from 'node:fs';
import { loadPublishedCanonical } from '../studio/backend/bootstrap/index.mjs';

try {
  if (process.argv.slice(2).some(arg => arg !== '--summary')) throw Error('Usage: node scripts/bootstrap-canonical.mjs [--summary]');
  const prHead = process.env.GITHUB_EVENT_NAME === 'pull_request'
    ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request.head.sha
    : null;
  const loaded = loadPublishedCanonical({ prHead });
  const { manifest, documents, ...summary } = loaded;
  console.log(JSON.stringify(process.argv.includes('--summary') ? summary : loaded, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'CANONICAL_NOT_LOADED', message: error.message, legacyFallbackAllowed: false }));
  process.exitCode = 1;
}
