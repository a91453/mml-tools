import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPublishedCanonical } from '../studio/backend/bootstrap/index.mjs';
import { SUPPORTED_CANONICAL_VERSIONS } from '../studio/backend/rules/supported-releases.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const output = resolve(root, process.argv[2] ?? '.oss-export');
const publicTemplate = resolve(root, 'oss/public');

if (output === root || !output.startsWith(`${root}${sep}`)) {
  throw new Error('OSS export target must be a directory inside the repository checkout.');
}

const blockedPathFragments = [
  '/ops/', '/railway/', '/.openai/', '/docs/history/', '/dist/workbench-source.zip',
  '/node_modules/', '/studio/web-build/', '/studio/browser-results/', '/.git/',
];
// Sound banks too: the free default preview bank is fetched from its upstream
// by each browser and never redistributed.
const blockedExtensions = new Set(['.m4a', '.mp3', '.flac', '.wav', '.mid', '.midi', '.musicxml', '.mxl', '.pdf', '.zip', '.sqlite', '.db', '.sf2', '.sf3', '.dls']);

function normalized(path) {
  return `/${relative(root, path).split(sep).join('/')}`;
}
function allowedSource(path) {
  const rel = normalized(path);
  if (blockedPathFragments.some(fragment => rel.includes(fragment))) return false;
  if (blockedExtensions.has(extname(path).toLowerCase())) return false;
  return true;
}

async function copyFile(sourceRelative, targetRelative = sourceRelative) {
  const source = resolve(root, sourceRelative);
  if (!allowedSource(source)) throw new Error(`Refusing blocked source path: ${sourceRelative}`);
  const target = resolve(output, targetRelative);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target);
}

async function copyTree(sourceRelative, targetRelative = sourceRelative) {
  const source = resolve(root, sourceRelative);
  const target = resolve(output, targetRelative);
  await cp(source, target, {
    recursive: true,
    filter: path => allowedSource(path),
  });
}

async function overlayTree(sourceDir, targetDir) {
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    const source = resolve(sourceDir, entry.name);
    const target = resolve(targetDir, entry.name);
    if (entry.isDirectory()) {
      await mkdir(target, { recursive: true });
      await overlayTree(source, target);
    } else {
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target);
    }
  }
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

// Public distribution templates are maintained separately from the private
// repository root so deployment notes and private-only metadata cannot leak by
// accident.
await overlayTree(publicTemplate, output);

// Explicit allowlist: production/source code only. Private deployment and
// operational directories are intentionally absent.
await copyFile('dist/core.js');
await copyFile('dist/player.js');
await copyTree('server');
await copyTree('studio');
// The legacy suites that cover exported code. `api.test.mjs` and
// `mcp-studio.test.mjs` cover `server/api.mjs` and `server/mcp-studio.mjs`,
// which the tree copy above already exports, so leaving them behind would ship
// two transports with no public regressions. `railway.test.mjs` stays out: it
// covers the private deployment's OAuth service, which is not exported.
for (const path of [
  'tests/core.test.mjs',
  'tests/mcp.test.mjs',
  'tests/player.test.mjs',
  'tests/api.test.mjs',
  'tests/mcp-studio.test.mjs',
]) await copyFile(path);
for (const path of [
  'scripts/build-studio-web.mjs',
  'scripts/serve-studio-web.mjs',
  'scripts/studio-artifact-identity.mjs',
  'scripts/verify-studio-artifact.mjs',
  'scripts/audit-oss-export.mjs',
  'scripts/build-default-soundbank.mjs',
]) await copyFile(path);

// Implementation documents that a shipped regression opens by path. The export
// carries code and the documents its own tests read; the repository's process
// records -- audits, roadmap, readiness and migration notes -- stay private.
// audit-oss-export.mjs checks both directions: a shipped test may not name a
// document outside the Canonical locator set that this list omits, and this
// list may not carry a document no shipped test reads.
for (const path of ['docs/G11C_CANDIDATE_ARRANGEMENT.md']) await copyFile(path);

// Regressions whose subject this export refuses to carry are removed from it
// rather than merely skipped: song-reference-packages.test.mjs exists to police
// imports/, which is never exported. Shipping it would leave a test with
// nothing to check. It is unchanged and still enforced in the source repository, and
// audit-oss-export.mjs refuses an export that carries it.
for (const path of ['studio/tests/song-reference-packages.test.mjs']) {
  await rm(resolve(output, path), { force: true });
}

// The Git-backed build-time materialization, and its regression, belong to the
// private Agent Control Plane image: they exist to give a Railway build context
// the published Git history it arrived without. This distribution vendors the
// resolved Canonical package below instead and has no Git-backed bootstrap to
// materialize for, so shipping either would leave a module that cannot import
// and a test that can never run.
for (const path of ['studio/backend/bootstrap/materialize.mjs', 'studio/tests/bootstrap-materialize.test.mjs']) {
  await rm(resolve(output, path), { force: true });
}

// Resolve the Published Canonical from the private source checkout once, then
// vendor the resulting immutable package. The public distribution therefore
// does not require access to the private repository's Git history.
const canonical = loadPublishedCanonical({ root, supportedCanonicalVersion: SUPPORTED_CANONICAL_VERSIONS });
const vendored = {
  ...canonical,
  provenance: {
    ...canonical.provenance,
    distribution_mode: 'vendored-static',
    source_repository: 'a91453/mml-tools',
  },
};
await mkdir(resolve(output, 'canonical'), { recursive: true });
await writeFile(resolve(output, 'canonical/published.json'), `${JSON.stringify(vendored, null, 2)}\n`);

// Keep the human-readable rule sources alongside the machine-readable package.
for (const document of canonical.documents) {
  const name = document.path.replace(/^docs\//, '');
  const target = resolve(output, 'docs/canonical', name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, document.content);
}

const publicBootstrap = `import { readFileSync } from 'node:fs';\n\nexport const STATIC_VENDORED_CANONICAL = true;\nconst loaded = JSON.parse(readFileSync(new URL('../../../canonical/published.json', import.meta.url), 'utf8'));\nfunction freeze(value) { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); }\nfreeze(loaded);\nexport const BOOTSTRAP_CONTRACT = freeze({ repository: 'a91453/mml-tools-oss', entryPoint: 'canonical/published.json', publishedRef: null, role: 'VENDORED_CONSUMER', localSkillAuthority: 'WORKFLOW_ONLY', executableContractDefinesRules: false, failureStatus: 'CANONICAL_NOT_LOADED', legacyFallbackAllowed: false });\nexport class CanonicalNotLoadedError extends Error { constructor(reason, cause) { super('CANONICAL_NOT_LOADED: ' + reason, { cause }); this.name = 'CanonicalNotLoadedError'; this.code = 'CANONICAL_NOT_LOADED'; } }\nexport function loadPublishedCanonical({ supportedCanonicalVersion = null } = {}) { if (supportedCanonicalVersion !== null && ![].concat(supportedCanonicalVersion).includes(loaded.metadata.canonical_version)) throw new CanonicalNotLoadedError('Unsupported vendored Canonical version'); return loaded; }\nexport function parseCanonicalManifest() { throw new CanonicalNotLoadedError('Manifest parsing is a source-repository concern; this distribution uses canonical/published.json'); }\nexport function gitEnvironment(environment = process.env) { return { ...environment, GIT_OPTIONAL_LOCKS: '0' }; }\nexport function gitSubprocess() { throw new CanonicalNotLoadedError('Git-backed Canonical discovery is unavailable in the public vendored distribution'); }\n`;
await writeFile(resolve(output, 'studio/backend/bootstrap/index.mjs'), publicBootstrap);

// Public tests omit only what a vendored distribution cannot observe: the
// Git-backed bootstrap and Manifest regressions and the build-reproducibility
// regression. The song-reference package regression needs no entry because the
// export does not carry it at all. Canonical IR merge behaviour is run here --
// it imports only exported modules and needs no source repository. All parser,
// canonical IR, arrangement, Final, web and browser behaviour remains covered
// by the exported suite.
const publicRunner = `import { readdirSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nconst excluded = new Set(['bootstrap-concurrency.test.mjs','bootstrap.test.mjs','canonical-manifest.test.mjs','canonical-v2-activation.test.mjs','canonical-v3-activation.test.mjs','web-build-reproducibility.test.mjs']);\nconst legacy = readdirSync('tests').filter(x => x.endsWith('.test.mjs')).map(x => 'tests/' + x);\nconst studio = readdirSync('studio/tests').filter(x => x.endsWith('.test.mjs') && !excluded.has(x)).map(x => 'studio/tests/' + x);\nconst onlyStudio = process.argv.includes('--studio');\nconst files = onlyStudio ? studio : [...legacy, ...studio];\nconst result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });\nprocess.exit(result.status ?? 1);\n`;
await writeFile(resolve(output, 'scripts/run-public-tests.mjs'), publicRunner);

const metadata = {
  format_version: 1,
  generated_at: new Date().toISOString(),
  source_repository: 'a91453/mml-tools',
  source_head: canonical.provenance.repository_head,
  published_main_head: canonical.provenance.published_main_head,
  manifest_commit: canonical.provenance.manifest_commit,
  canonical_version: canonical.metadata.canonical_version,
  manifest_version: canonical.metadata.manifest_version,
  rules_snapshot_sha: canonical.metadata.rules_snapshot_sha,
  distribution_mode: 'clean-public-export',
  private_git_history_included: false,
};
await writeFile(resolve(output, 'PUBLIC_EXPORT.json'), `${JSON.stringify(metadata, null, 2)}\n`);

// Fill public README provenance placeholders after the Canonical identity is
// known. Refuse silently stale placeholders by checking the final result.
const readmePath = resolve(output, 'README.md');
let readme = await readFile(readmePath, 'utf8');
readme = readme
  .replaceAll('{{CANONICAL_VERSION}}', metadata.canonical_version)
  .replaceAll('{{RULES_SNAPSHOT_SHA}}', metadata.rules_snapshot_sha)
  .replaceAll('{{SOURCE_HEAD}}', metadata.source_head)
  .replace('See `PUBLIC_EXPORT.json` and `docs/UPSTREAM_CANONICAL_PROVENANCE.json`.', 'See `PUBLIC_EXPORT.json`, `canonical/published.json`, and `docs/canonical/`.');
if (/\{\{[A-Z0-9_]+\}\}/.test(readme)) throw new Error('Unresolved public README placeholder');
await writeFile(readmePath, readme);

console.log(JSON.stringify({ output: relative(root, output), ...metadata }, null, 2));
