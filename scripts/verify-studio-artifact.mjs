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
import { assertStableCanonicalPackage } from '../studio/web/canonical-contract.mjs';
import { BUILD_MANIFEST, SERVICE_WORKER_ASSET, byPath, computeBuildId, computeCacheId, readServiceWorkerTemplate, renderServiceWorker } from './studio-artifact-identity.mjs';

// build.json is the sidecar that carries the manifest, so it cannot be inside
// it. Everything else, the generated Service Worker included, must be covered:
// a file outside the manifest can be replaced or deleted without changing the
// declared identity.
export const UNHASHED = Object.freeze([BUILD_MANIFEST]);

// Read the Canonical payload the artifact actually ships, without executing any
// artifact JavaScript. The build emits each copy as one deterministic line.
const EMBEDDED = Object.freeze([
  ['studio/web/published.mjs', /^export const canonical = (\{.*\});$/m],
  ['studio/backend/bootstrap/index.mjs', /^const loaded = (\{.*\});$/m],
]);
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
export async function verifyStudioArtifact(dir, expected = {}, { serviceWorkerTemplate = null } = {}) {
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
  need(computeBuildId([...manifest.entries()]) === build.buildId, 'Declared buildId does not match the asset manifest');

  const present = new Set(await walk(dir));
  for (const name of UNHASHED) present.delete(name);
  for (const path of manifest.keys()) need(present.delete(path), `Asset declared in build.json is missing: ${path}`);
  need(present.size === 0, `Unexpected file not covered by the asset manifest: ${[...present].sort()[0]}`);

  for (const [path, hash] of manifest) {
    const actual = digest(await readFile(resolve(dir, path)));
    need(actual === hash, `Asset hash mismatch: ${path}`);
  }

  // Hash self-consistency only proves the artifact matches its own manifest. A
  // consistently re-signed artifact can still ship a Canonical payload the
  // browser will refuse to boot, so check the shipped bytes semantically too.
  const payloads = new Map();
  for (const [path, pattern] of EMBEDDED) {
    need(manifest.has(path), `Embedded Canonical bundle is missing: ${path}`);
    const matched = pattern.exec(await readFile(resolve(dir, path), 'utf8'));
    need(matched, `Embedded Canonical bundle is not in the expected generated form: ${path}`);
    payloads.set(path, matched[1]);
  }
  const [[primaryPath, primary], ...duplicates] = [...payloads];
  for (const [path, payload] of duplicates) {
    need(payload === primary, `Embedded Canonical bundles disagree: ${path} differs from ${primaryPath}`);
  }

  need(digest(primary) === build.release.runtimeBundleDigest, 'release.runtimeBundleDigest does not match the shipped Canonical runtime bundle');

  const published = await readFile(resolve(dir, 'studio/web/published.mjs'), 'utf8');
  const declaredDigest = /^export const canonicalDigest = '([a-f0-9]{64})';$/m.exec(published);
  need(declaredDigest, 'Shipped Canonical bundle declares no runtime digest');
  need(declaredDigest[1] === build.release.runtimeBundleDigest, 'Shipped Canonical digest disagrees with release.runtimeBundleDigest');

  let bundle;
  try { bundle = JSON.parse(primary); } catch { throw new ArtifactNotVerifiedError('Embedded Canonical bundle is not valid JSON'); }
  // The browser applies this same contract, so it cannot boot what this rejects.
  try { assertStableCanonicalPackage(bundle); }
  catch (error) { throw new ArtifactNotVerifiedError(`Shipped Canonical bundle fails the runtime contract: ${error.message}`); }
  for (const [key, value] of Object.entries(canonical)) {
    need(bundle.metadata[key] === value, `Shipped Canonical ${key} disagrees with build.json release identity`);
  }

  // The Service Worker is mandatory executable runtime code, so it is rebuilt
  // rather than pattern-matched. The template comes from this repository, never
  // from the artifact: an artifact that supplies its own template can always
  // recompute a cacheId that agrees with itself.
  need(manifest.has(SERVICE_WORKER_ASSET), `Artifact declares no ${SERVICE_WORKER_ASSET}; it is a mandatory runtime asset`);
  need(/^[a-f0-9]{64}$/.test(build.release.cacheId ?? ''), 'build.json declares no valid cacheId for the Service Worker');
  const template = serviceWorkerTemplate ?? await readServiceWorkerTemplate();
  need(template, 'No trusted Service Worker template is available to verify against');
  const runtimeHashes = [...manifest.entries()].filter(([path]) => path !== SERVICE_WORKER_ASSET).sort(byPath);
  need(build.release.cacheId === computeCacheId(runtimeHashes, template), 'release.cacheId does not match the trusted Service Worker template and the runtime assets');
  const expectedWorker = renderServiceWorker(template, build.release.cacheId, runtimeHashes.map(([path]) => path));
  need(await readFile(resolve(dir, SERVICE_WORKER_ASSET), 'utf8') === expectedWorker, 'Shipped Service Worker is not the deterministic render of the trusted template');

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
