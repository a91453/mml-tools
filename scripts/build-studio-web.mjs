import { readFile, writeFile, mkdir, readdir, rm, cp } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadPublishedCanonical } from '../studio/backend/bootstrap/index.mjs';
import { SUPPORTED_CANONICAL_VERSIONS } from '../studio/backend/rules/supported-releases.mjs';
import { SERVICE_WORKER_ASSET, byPath, computeBuildId, computeCacheId, readServiceWorkerTemplate, renderServiceWorker } from './studio-artifact-identity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Overridable so verification can build into an isolated directory without
// racing the default output another test or deployment step is using.
const out = resolve(root, process.env.STUDIO_WEB_BUILD_OUT ?? 'studio/web-build');
const prHead = process.env.GITHUB_EVENT_NAME === 'pull_request'
  ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request.head.sha : null;
// Fail before producing any output if published discovery/history is missing.
const canonical = loadPublishedCanonical({ root, prHead, supportedCanonicalVersion: SUPPORTED_CANONICAL_VERSIONS });
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
//
// `audio/prescreen/` is the server's audio prescreen: it renders in Node
// worker threads with the npm spessasynth_core package and caches a sound bank
// on the service's disk. The browser has its own preview engine (vendored
// below) and loads none of it. The shared instrument table beside it,
// `audio/instruments.mjs`, is pure and ships.
const SERVER_ONLY_MODULES = new Set(['studio/backend/application', 'studio/backend/audio/prescreen']);
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
// The Workshop editor page (studio/web/workshop/, outside the Canonical
// pipeline). Its modules are copied with the rest of studio/web above; the
// page, its stylesheet and its first-paint script are the only other files.
// It reuses vendor/spessasynth/ below and ships no bank and no icon font.
for (const name of ['index.html', 'workshop.css', 'boot.js']) await put(`studio/web/workshop/${name}`, await readFile(resolve(root, 'studio/web/workshop', name)));
await put('dist/core.js', await readFile(resolve(root, 'dist/core.js')));
// Preserve all engine modules. Only replace the environment-specific Git loader.
// Dynamic Git provenance (repository_head / published_main_head / pr_head and
// the Manifest commit) is audit metadata, not runtime content. Embedding it in
// hashed assets made buildId move whenever main advanced, even with identical
// sources and an unchanged Canonical release. It ships in build.json instead.
const { provenance, ...runtimeCanonical } = canonical;
const data = JSON.stringify(runtimeCanonical);
await put('studio/backend/bootstrap/index.mjs', `const loaded = ${data};\nfunction freeze(x){for(const v of Object.values(x))if(v&&typeof v==='object')freeze(v);return Object.freeze(x)}\nfreeze(loaded);\nexport function loadPublishedCanonical({supportedCanonicalVersion=null}={}){if(supportedCanonicalVersion&&![].concat(supportedCanonicalVersion).includes(loaded.metadata.canonical_version))throw Error('CANONICAL_NOT_LOADED');return loaded}\n`);
await put('studio/web/published.mjs', `export const canonical = ${data};\nexport const canonicalDigest = '${digest(data)}';\n`);
const parserDir = dirname(dirname(fileURLToPath(import.meta.resolve('fast-xml-parser'))));
const vendor = await readFile(resolve(parserDir, 'lib/fxp.min.js'), 'utf8');
// Ship the installed package's own browser build, without a CDN or new parser.
await put('vendor/xml.mjs', `(function(){${vendor}\n}).call(globalThis);\nexport const { XMLParser, XMLValidator } = globalThis.fxp;\n`);
// Timbre preview engine (studio/web/preview/player.mjs), from the installed npm
// packages spessasynth_lib / spessasynth_core (Apache-2.0), never a CDN. The lib
// imports its core by bare specifier; the browser build points it at the
// vendored copy. Source-map comments are dropped so no unlisted asset is asked for.
// The Apache-2.0 text travels as a comment header in lib.js rather than as a
// separate extension-less LICENSE file: hosts serve an allowlist of file types,
// and one unservable precache entry fails the whole Service Worker install.
const stripMap = text => text.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n');
const libDist = dirname(fileURLToPath(import.meta.resolve('spessasynth_lib')));
const coreDist = dirname(fileURLToPath(import.meta.resolve('spessasynth_core')));
const spessaLib = await readFile(resolve(libDist, 'index.js'), 'utf8');
if (!spessaLib.includes('from "spessasynth_core"')) throw Error('spessasynth_lib no longer imports spessasynth_core by bare specifier; update the vendoring step');
const spessaVersions = await Promise.all(['spessasynth_lib', 'spessasynth_core'].map(async name => `${name}@${JSON.parse(await readFile(resolve(name === 'spessasynth_lib' ? libDist : coreDist, '../package.json'), 'utf8')).version}`));
const spessaLicense = (await readFile(resolve(libDist, '../LICENSE'), 'utf8')).replaceAll('*/', '* /');
const spessaBanner = `/*! SpessaSynth — vendored from npm: ${spessaVersions.join(', ')} (https://github.com/spessasus/spessasynth_lib)\n * SPDX-License-Identifier: Apache-2.0. Not covered by this repository's MIT License.\n`;
await put('vendor/spessasynth/lib.js', `${spessaBanner}\n${spessaLicense}\n*/\n${stripMap(spessaLib.replaceAll('from "spessasynth_core"', 'from "./core.js"'))}`);
await put('vendor/spessasynth/core.js', `${spessaBanner} * Full license text: the header of vendor/spessasynth/lib.js.\n */\n${stripMap(await readFile(resolve(coreDist, 'index.js'), 'utf8'))}`);
await put('vendor/spessasynth/processor.js', `${spessaBanner} * Full license text: the header of vendor/spessasynth/lib.js.\n */\n${stripMap(await readFile(resolve(libDist, 'spessasynth_processor.min.js'), 'utf8'))}`);
// No sound bank is part of the build. The free default preview bank is
// downloaded from its upstream by the browser that first needs it and kept
// only there (studio/web/preview/default-bank.mjs); a bank the user picks
// stays in their browser too.
// Every backend module that imports the XML parser by bare specifier is pointed
// at the vendored browser build; a bare specifier left in any shipped module is
// refused below, because the browser cannot resolve it and the page never boots.
for (const xmlPath of ['studio/backend/score/musicxml.mjs', 'studio/backend/score/mxl.mjs']) {
  const text = await readFile(resolve(root, xmlPath), 'utf8');
  if (!text.includes("from 'fast-xml-parser'")) throw Error(`${xmlPath} no longer imports fast-xml-parser by bare specifier; update the vendoring step`);
  await put(xmlPath, text.replace("from 'fast-xml-parser'", "from '../../../vendor/xml.mjs'"));
}
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
for (const path of runtimeFiles.filter(path => /\.m?js$/.test(path))) {
  if (/\bfrom\s*['"]fast-xml-parser['"]/.test(await readFile(resolve(out, path), 'utf8'))) throw Error(`${path} imports fast-xml-parser by bare specifier, which a browser cannot resolve`);
}
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
