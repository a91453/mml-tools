// The legacy Workbench source archive (`dist/workbench-source.zip`), offered by
// `dist/index.html` as 「下載可修改的原始碼」 and embedded in the Sites Worker.
//
// It is a build output, never a tracked file: `npm run build` writes it from the
// inputs below on every build, and `.gitignore` keeps it out of Git, so there is
// no committed copy that can drift from them (roadmap G12). A committed copy did
// drift: it kept 23 entries after the build had grown to 26.
//
// The inputs are explicit: no credentials, songs, uploads or generated Worker
// bundles. They include every file the build itself reads, this module among
// them, so the archive can rebuild itself byte for byte from nothing but its own
// entries; tests/sites-build.test.mjs holds it to that.
import { chmod, copyFile, mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const WORKBENCH_SOURCE_ZIP = 'dist/workbench-source.zip';

export const WORKBENCH_SOURCE_FILES = Object.freeze([
  'README.md', 'package.json', '.gitignore', '.dockerignore', '.openai/hosting.json',
  'dist/index.html', 'dist/style.css', 'dist/core.js', 'dist/player.js', 'dist/app.js',
  'server/mcp.mjs', 'server/worker.mjs',
  'scripts/build.mjs', 'scripts/bundle-sites-worker.mjs', 'scripts/workbench-source.mjs',
  'studio/backend/application/contracts.mjs', 'studio/backend/application/technical-service.mjs',
  'tests/core.test.mjs', 'tests/player.test.mjs', 'tests/mcp.test.mjs', 'tests/railway.test.mjs',
  'railway/service-settings.json', 'railway/Dockerfile', 'railway/auth.mjs', 'railway/server.mjs',
  'railway/README.md', 'railway/deployment-target.json',
]);

// The archive depends on the inputs' bytes only. A checkout stamps every file
// with its own checkout time and umask, and zip records both, so each input is
// staged with one fixed timestamp and mode first. TZ is pinned because zip
// stores local DOS time; -X drops the extra fields (UID/GID, UTC timestamps).
const ENTRY_TIME = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
const ENTRY_MODE = 0o644;

export async function buildWorkbenchSourceZip(root) {
  const staging = await mkdtemp(join(tmpdir(), 'mml-workbench-source-'));
  try {
    for (const file of WORKBENCH_SOURCE_FILES) {
      const staged = resolve(staging, file);
      await mkdir(dirname(staged), { recursive: true });
      await copyFile(resolve(root, file), staged);
      await chmod(staged, ENTRY_MODE);
      await utimes(staged, ENTRY_TIME, ENTRY_TIME);
    }
    // No shell is involved: the file list is passed as arguments.
    return execFileSync('zip', ['-X', '-q', '-', ...WORKBENCH_SOURCE_FILES], {
      cwd: staging, env: { ...process.env, TZ: 'UTC' }, maxBuffer: 4 * 1024 * 1024,
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
