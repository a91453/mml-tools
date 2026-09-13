import { readFile, writeFile, mkdir, readdir, rm, cp } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadPublishedCanonical } from '../studio/backend/bootstrap/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(root, 'studio/web-build');
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
const data = JSON.stringify(canonical);
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
const hashes = await Promise.all(files.sort().map(async path => [path, digest(await readFile(resolve(out, path)))]));
const buildId = digest(JSON.stringify(hashes));
await put('build.json', JSON.stringify({ buildId, canonical: canonical.metadata, provenance: canonical.provenance, files: hashes }, null, 2));
const sw = await readFile(resolve(root, 'studio/web/sw.js'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
if (sw) await put('sw.js', sw.replace('__CACHE_NAME__', `mml-studio-v1-${buildId}`).replace('__PRECACHE__', JSON.stringify(['./', ...files.map(path => `./${path}`), './build.json'])));
console.log(JSON.stringify({ output: 'studio/web-build', buildId, canonical: canonical.metadata, provenance: canonical.provenance, assetCount: files.length }));
