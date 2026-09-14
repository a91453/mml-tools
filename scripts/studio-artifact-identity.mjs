// The single definition of Studio artifact identity, shared by the builder and
// the artifact verifier so the two cannot drift apart.
//
// Release identity is two-stage. A Service Worker cannot contain its own hash,
// so deriving its cache name from the final buildId would require
// buildId -> sw.js -> buildId. Stage A therefore derives cacheId from the
// runtime assets plus the Service Worker template, and Stage B hashes the
// rendered worker into the manifest that buildId covers.
//
// The verifier must render the expected worker from the TRUSTED repository
// template, never from bytes carried by the artifact: an attacker who supplies
// the template can always recompute a self-consistent cacheId for it.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const CACHE_PREFIX = 'mml-studio-v1-';
export const SERVICE_WORKER_ASSET = 'sw.js';
export const BUILD_MANIFEST = 'build.json';
export const SERVICE_WORKER_TEMPLATE = 'studio/web/sw.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

export const digest = value => createHash('sha256').update(value).digest('hex');

// One ordering for both sides; a mismatch here would change every digest.
export const byPath = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

// The template as committed to this repository, which is the trust anchor.
export const readServiceWorkerTemplate = async (root = repositoryRoot) =>
  readFile(resolve(root, SERVICE_WORKER_TEMPLATE), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });

// Stage A. Moves whenever a runtime asset or the worker template moves.
export function computeCacheId(runtimeHashes, serviceWorkerTemplate) {
  return digest(JSON.stringify([[...runtimeHashes].sort(byPath), digest(serviceWorkerTemplate)]));
}

// Deterministic rendering: identical inputs must give byte-identical output,
// because the verifier compares the shipped worker against this byte for byte.
export function renderServiceWorker(serviceWorkerTemplate, cacheId, runtimeFiles) {
  return serviceWorkerTemplate
    .replace('__CACHE_NAME__', `${CACHE_PREFIX}${cacheId}`)
    .replace('__PRECACHE__', JSON.stringify(['./', ...[...runtimeFiles].sort().map(path => `./${path}`), `./${BUILD_MANIFEST}`]));
}

// Stage B. The rendered worker is executable code controlling interception and
// offline serving, so release identity must cover it.
export function computeBuildId(assetHashes) {
  return digest(JSON.stringify([...assetHashes].sort(byPath)));
}
