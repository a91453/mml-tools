import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleSitesWorker } from './bundle-sites-worker.mjs';
import { WORKBENCH_SOURCE_ZIP, buildWorkbenchSourceZip } from './workbench-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(root, '.openai/hosting.json'), 'utf8'));
if (manifest.static) throw Error('MCP needs a Worker, not a static-only deployment');
// The source archive is a build output, regenerated here from its explicit
// inputs on every build and never tracked (see workbench-source.mjs).
await writeFile(resolve(root, WORKBENCH_SOURCE_ZIP), await buildWorkbenchSourceZip(root));
const assets = {};
for (const [file, type] of [['index.html', 'text/html; charset=utf-8'], ['style.css', 'text/css; charset=utf-8'], ['core.js', 'text/javascript; charset=utf-8'], ['player.js', 'text/javascript; charset=utf-8'], ['app.js', 'text/javascript; charset=utf-8'], ['workbench-source.zip', 'application/zip']]) {
  const data = await readFile(resolve(root, 'dist', file));
  assets[`/${file}`] = { type, encoding: file.endsWith('.zip') ? 'base64' : 'utf8', body: data.toString(file.endsWith('.zip') ? 'base64' : 'utf8') };
}
// Isolated module scopes and explicit environment adapters: no unresolved
// Node imports may leak into the single-file Sites runtime.
const bundle = await bundleSitesWorker(root, assets);
await mkdir(resolve(root, 'dist/server'), { recursive: true });
await mkdir(resolve(root, 'dist/.openai'), { recursive: true });
await writeFile(resolve(root, 'dist/server/index.js'), bundle);
await writeFile(resolve(root, 'dist/.openai/hosting.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built single Worker module (${Buffer.byteLength(bundle)} bytes), ${Object.keys(assets).length} preserved website assets.`);
