import { readFile, writeFile, mkdir, readdir, rm, cp } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadPublishedCanonical } from '../studio/backend/bootstrap/index.mjs';
import { SERVICE_WORKER_ASSET, byPath, computeBuildId, computeCacheId, readServiceWorkerTemplate, renderServiceWorker } from './studio-artifact-identity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Overridable so verification can build into an isolated directory without
// racing the default output another test or deployment step is using.
const out = resolve(root, process.env.STUDIO_WEB_BUILD_OUT ?? 'studio/web-build');
const prHead = process.env.GITHUB_EVENT_NAME === 'pull_request'
  ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request.head.sha : null;
// Fail before producing any output if published discovery/history is missing.
const canonical = loadPublishedCanonical({ root, prHead, supportedCanonicalVersion: '2026-09-13-v1' });
const digest = value => createHash('sha256').update(value).digest('hex');
await rm(out, { recursive: true, force: true });
const put = async (path, text) => { await mkdir(dirname(resolve(out, path)), { recursive: true }); await writeFile(resolve(out, path), text); };
// Server-only backend directories. The browser bundle carries the Canonical
// engines; it must not carry the transport-facing layers built on top of them.
// `application/` orchestrates the engines for HTTP and MCP callers and reaches
// for node:fs, node:crypto and a filesystem store, none of which exist in a
// browser. Nothing the Studio Web app loads imports it, so excluding it removes
// no capability from the PWA — and shipping it would put Node imports into an
// offline bundle that is asserted to have none.
const SERVER_ONLY_MODULES = new Set(['studio/backend/application']);
// Build-time-only backend modules, excluded for the same reason as the
// directories above. `bootstrap/materialize.mjs` gives an Agent backend image
// the published Git history its build context arrived without: it shells out to
// git over the network, runs once while that image is built, and is imported by
// nothing the browser loads. The PWA has no Git-backed bootstrap to materialize
// for at all -- its loader is replaced below by the resolved static package --
// so shipping it would put node:child_process into an offline bundle that is
// asserted to carry no Node imports, and would remove no capability by leaving.
const SERVER_ONLY_FILES = new Set(['studio/backend/bootstrap/materialize.mjs']);

async function copyModules(directory) {
  if (SERVER_ONLY_MODULES.has(directory)) return;
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await copyModules(path);
    else if (entry.name.endsWith('.mjs') && !SERVER_ONLY_FILES.has(path)) await put(path, await readFile(resolve(root, path)));
  }
}
await copyModules('studio/backend');
await copyModules('studio/web');
for (const name of ['index.html', 'style.css']) await put(`studio/web/service/${name}`, await readFile(resolve(root, 'studio/web/service', name)));
await put('dist/core.js', await readFile(resolve(root, 'dist/core.js')));
// Preserve all engine modules. Only replace the environment-specific Git loader.
// Dynamic Git provenance (repository_head / published_main_head / pr_head and
// the Manifest commit) is audit metadata, not runtime content. Embedding it in
// hashed assets made buildId move whenever main advanced, even with identical
// sources and an unchanged Canonical release. It ships in build.json instead.
const { provenance, ...runtimeCanonical } = canonical;
const data = JSON.stringify(runtimeCanonical);
await put('studio/backend/bootstrap/index.mjs', `const loaded = ${data};\nfunction freeze(x){for(const v of Object.values(x))if(v&&typeof v==='object')freeze(v);return Object.freeze(x)}\nfreeze(loaded);\nexport function loadPublishedCanonical({supportedCanonicalVersion=null}={}){if(supportedCanonicalVersion&&supportedCanonicalVersion!==loaded.metadata.canonical_version)throw Error('CANONICAL_NOT_LOADED');return loaded}\n`);
await put('studio/web/published.mjs', `export const canonical = ${data};\nexport const canonicalDigest = '${digest(data)}';\n`);
const parserDir = dirname(dirname(fileURLToPath(import.meta.resolve('fast-xml-parser'))));
const vendor = await readFile(resolve(parserDir, 'lib/fxp.min.js'), 'utf8');
// Ship the installed package's own browser build, without a CDN or new parser.
await put('vendor/xml.mjs', `(function(){${vendor}\n}).call(globalThis);\nexport const { XMLParser, XMLValidator } = globalThis.fxp;\n`);
const xmlPath = 'studio/backend/score/musicxml.mjs';
await put(xmlPath, (await readFile(resolve(root, xmlPath), 'utf8')).replace("from 'fast-xml-parser'", "from '../../../vendor/xml.mjs'"));
for (const name of ['index.html', 'style.css', 'manifest.webmanifest', 'icon.svg', 'apple-touch-icon.png']) {
  try { await cp(resolve(root, 'studio/web', name), resolve(out, name)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const files = [];
async function inventory(dir = '') {
  for (const entry of await readdir(resolve(out, dir), { withFileTypes: true })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await inventory(path);
    else files.push(path);
  }
}
await inventory();
const runtimeFiles = files.sort();
const runtimeHashes = await Promise.all(runtimeFiles.map(async path => [path, digest(await readFile(resolve(out, path)))]));

// Stage A - cache identity, shared with the artifact verifier so the two
// cannot drift. See scripts/studio-artifact-identity.mjs for why it is derived
// from the template rather than from the final buildId.
const swTemplate = await readServiceWorkerTemplate(root);
const cacheId = computeCacheId(runtimeHashes, swTemplate);
// The worker does not precache itself; the browser fetches that script directly.
if (swTemplate) await put(SERVICE_WORKER_ASSET, renderServiceWorker(swTemplate, cacheId, runtimeFiles));

// Stage B - release identity over the complete manifest, worker included.
const hashes = swTemplate
  ? [...runtimeHashes, [SERVICE_WORKER_ASSET, digest(await readFile(resolve(out, SERVICE_WORKER_ASSET)))]].sort(byPath)
  : [...runtimeHashes].sort(byPath);
const buildId = computeBuildId(hashes);
const audit = { note: 'Dynamic Git and build provenance. Audit only: excluded from hashed runtime assets and from buildId.', source_sha: provenance.repository_head, ...provenance };
// Stable release identity defines the artifact; audit provenance never does.
await put('build.json', JSON.stringify({
  buildId,
  release: { canonical: canonical.metadata, rules_snapshot_sha: canonical.metadata.rules_snapshot_sha, runtimeBundleDigest: digest(data), cacheId },
  audit,
  files: hashes,
}, null, 2));
console.log(JSON.stringify({ output: 'studio/web-build', buildId, cacheId, canonical: canonical.metadata, audit, assetCount: hashes.length }));
