import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { bundleSitesWorker } from './bundle-sites-worker.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(root, '.openai/hosting.json'), 'utf8'));
if (manifest.static) throw Error('MCP needs a Worker, not a static-only deployment');
// ZIP source inputs are explicit: no credentials, songs, uploads or generated
// Worker bundles. zip -X removes extra file metadata; no shell is involved.
const sourceFiles = ['README.md', 'package.json', '.gitignore', '.dockerignore', '.openai/hosting.json', 'dist/index.html', 'dist/style.css', 'dist/core.js', 'dist/player.js', 'dist/app.js', 'server/mcp.mjs', 'server/worker.mjs', 'scripts/build.mjs', 'scripts/bundle-sites-worker.mjs', 'studio/backend/application/contracts.mjs', 'studio/backend/application/technical-service.mjs', 'tests/core.test.mjs', 'tests/player.test.mjs', 'tests/mcp.test.mjs', 'tests/railway.test.mjs', 'railway/service-settings.json', 'railway/Dockerfile', 'railway/auth.mjs', 'railway/server.mjs', 'railway/README.md', 'railway/deployment-target.json'];
const zipBytes = execFileSync('zip', ['-X', '-q', '-', ...sourceFiles], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
await writeFile(resolve(root, 'dist/workbench-source.zip'), zipBytes);
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
