import { readFile, writeFile, mkdir, readdir, rm, cp } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadPublishedCanonical } from '../studio/backend/bootstrap/index.mjs';

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
async function copyModules(directory) {
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await copyModules(path);
    else if (entry.name.endsWith('.mjs')) await put(path, await readFile(resolve(root, path)));
  }
}
await copyModules('studio/backend');
await copyModules('studio/web');
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

// Stage A - cache identity. A Service Worker cannot contain its own hash, so
// deriving its cache name from the final buildId would need buildId -> sw.js ->
// buildId. Derive it instead from the runtime assets plus the SW template: it
// moves whenever either moves, with no cycle.
const swTemplate = await readFile(resolve(root, 'studio/web/sw.js'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
const cacheId = digest(JSON.stringify([runtimeHashes, digest(swTemplate)]));
// The Service Worker is not precached by itself; the browser fetches it directly.
if (swTemplate) await put('sw.js', swTemplate.replace('__CACHE_NAME__', `mml-studio-v1-${cacheId}`).replace('__PRECACHE__', JSON.stringify(['./', ...runtimeFiles.map(path => `./${path}`), './build.json'])));

// Stage B - release identity. The generated Service Worker is executable code
// that controls interception, offline serving and the cached runtime graph, so
// the artifact manifest and buildId must cover it. Anything left out of the
// manifest can be swapped or deleted without changing the declared identity.
const hashes = swTemplate
  ? [...runtimeHashes, ['sw.js', digest(await readFile(resolve(out, 'sw.js')))]].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  : runtimeHashes;
const buildId = digest(JSON.stringify(hashes));
const audit = { note: 'Dynamic Git and build provenance. Audit only: excluded from hashed runtime assets and from buildId.', source_sha: provenance.repository_head, ...provenance };
// Stable release identity defines the artifact; audit provenance never does.
await put('build.json', JSON.stringify({
  buildId,
  release: { canonical: canonical.metadata, rules_snapshot_sha: canonical.metadata.rules_snapshot_sha, runtimeBundleDigest: digest(data), cacheId },
  audit,
  files: hashes,
}, null, 2));
console.log(JSON.stringify({ output: 'studio/web-build', buildId, cacheId, canonical: canonical.metadata, audit, assetCount: hashes.length }));
