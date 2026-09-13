// Fail-closed verification of a built Studio Web artifact directory.
//
// A permanent deployment must be able to prove, offline and without trusting
// the transport it fetched the bundle over, that the artifact it is about to
// serve is exactly the reviewed release. Every check below therefore rejects
// rather than repairs: there is no partial-trust or best-effort outcome.
//
// This verifier consumes the published Canonical identity recorded at build
// time. It never defines Canonical rules and never re-derives them.
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Written after the asset inventory, so they are deliberately not hashed.
export const UNHASHED = Object.freeze(['build.json', 'sw.js']);
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;

export class ArtifactNotVerifiedError extends Error {
  constructor(reason) {
    super(`ARTIFACT_NOT_VERIFIED: ${reason}`);
    this.name = 'ArtifactNotVerifiedError';
    this.code = 'ARTIFACT_NOT_VERIFIED';
  }
}

const need = (condition, reason) => { if (!condition) throw new ArtifactNotVerifiedError(reason); };
const digest = value => createHash('sha256').update(value).digest('hex');

async function walk(dir, base = '') {
  const found = [];
  for (const entry of await readdir(resolve(dir, base), { withFileTypes: true })) {
    const path = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await walk(dir, path));
    else found.push(path);
  }
  return found;
}

// `expected` optionally pins the identity a deployment was authorised to serve.
export async function verifyStudioArtifact(dir, expected = {}) {
  let build;
  try { build = JSON.parse(await readFile(resolve(dir, 'build.json'), 'utf8')); }
  catch { throw new ArtifactNotVerifiedError('build.json is missing or unreadable'); }

  need(SHA256.test(build.buildId ?? ''), 'build.json declares no valid buildId');
  need(Array.isArray(build.files) && build.files.length > 0, 'build.json declares no asset manifest');

  const canonical = build.release?.canonical;
  need(canonical && typeof canonical === 'object', 'build.json declares no stable release identity');
  need(canonical.canonical_status === 'PUBLISHED', 'Release identity is not a PUBLISHED Canonical release');
  need(/^\d{4}-\d{2}-\d{2}-v\d+$/.test(canonical.canonical_version ?? ''), 'Release identity has no valid canonical_version');
  need(String(canonical.manifest_version ?? '').startsWith(`${canonical.canonical_version}-manifest`), 'manifest_version does not identify this Canonical release');
  need(SHA1.test(canonical.rules_snapshot_sha ?? ''), 'Release identity has no valid rules_snapshot_sha');
  need(build.release.rules_snapshot_sha === canonical.rules_snapshot_sha, 'build.json rules_snapshot_sha disagrees with the Canonical metadata');

  // Dynamic provenance is audit-only; it must never be read as release identity.
  need(build.audit && SHA1.test(build.audit.repository_head ?? ''), 'build.json preserves no dynamic build provenance');

  for (const [key, value] of Object.entries(expected)) {
    if (key === 'buildId') need(build.buildId === value, `buildId mismatch: expected ${value}, artifact declares ${build.buildId}`);
    else if (key === 'sourceSha') need(build.audit.source_sha === value, `source SHA mismatch: expected ${value}, artifact declares ${build.audit.source_sha}`);
    else need(canonical[key] === value, `${key} mismatch: expected ${value}, artifact declares ${canonical[key]}`);
  }

  const manifest = new Map();
  for (const entry of build.files) {
    need(Array.isArray(entry) && entry.length === 2, 'Asset manifest entry is malformed');
    const [path, hash] = entry;
    need(typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.split('/').some(part => part === '..' || part === '.'), `Unsafe asset path: ${path}`);
    need(SHA256.test(hash ?? ''), `Asset hash is not a SHA-256 digest: ${path}`);
    need(!manifest.has(path), `Duplicate asset manifest entry: ${path}`);
    manifest.set(path, hash);
  }

  // buildId must be reproducible from the manifest it ships with, so a tampered
  // manifest cannot be laundered by rewriting the declared buildId to match.
  const ordered = [...manifest.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  need(digest(JSON.stringify(ordered)) === build.buildId, 'Declared buildId does not match the asset manifest');

  const present = new Set(await walk(dir));
  for (const name of UNHASHED) present.delete(name);
  for (const path of manifest.keys()) need(present.delete(path), `Asset declared in build.json is missing: ${path}`);
  need(present.size === 0, `Unexpected file not covered by the asset manifest: ${[...present].sort()[0]}`);

  for (const [path, hash] of manifest) {
    const actual = digest(await readFile(resolve(dir, path)));
    need(actual === hash, `Asset hash mismatch: ${path}`);
  }

  return { buildId: build.buildId, release: build.release, audit: build.audit, assetCount: manifest.size };
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const [dir = 'studio/web-build', ...pins] = process.argv.slice(2);
  const expected = Object.fromEntries(pins.map(pin => {
    const index = pin.indexOf('=');
    if (!pin.startsWith('--') || index < 0) throw new ArtifactNotVerifiedError(`Usage: node scripts/verify-studio-artifact.mjs [dir] [--buildId=...] [--sourceSha=...] [--canonical_version=...] [--rules_snapshot_sha=...]`);
    return [pin.slice(2, index), pin.slice(index + 1)];
  }));
  try {
    const summary = await verifyStudioArtifact(dir, expected);
    console.log(JSON.stringify({ status: 'ARTIFACT_VERIFIED', ...summary }));
  } catch (error) {
    console.error(JSON.stringify({ status: 'ARTIFACT_NOT_VERIFIED', message: error.message }));
    process.exitCode = 1;
  }
}
