// Deployment topology — structural regressions.
//
// Two Railway planes exist and must stay separate:
//
//   Permanent Studio Web   mml-tools-studio-permanent / studio-web-permanent
//                          pinned SHA256-verified release artifact, trust
//                          bundle, durable verified cache at /studio-cache.
//                          Built and verified separately; not built from the
//                          Agent backend Dockerfile.
//
//   Agent Control Plane    mml-tools-allen / mml-tools
//                          OAuth, /mcp, /api/v1/*, Application Service, /data.
//
// The Application Service belongs to the second. These tests are structural
// rather than textual: they assert properties of the code and the deployment
// descriptors, because a wording test can be satisfied by editing a sentence
// while the architecture drifts underneath it.
//
// This file is deliberately NOT part of the clean public export: it reads
// `ops/permanent/`, which the export does not carry.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

async function* walk(directory) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

const sourcesUnder = async (directory, extensions = ['.mjs']) => {
  const files = [];
  for await (const path of walk(directory)) {
    if (extensions.some(extension => path.endsWith(extension))) {
      files.push([path, await readFile(join(root, path), 'utf8')]);
    }
  }
  return files;
};

// Comments are stripped before the cross-plane scan. The property under test is
// that no code path reaches the other plane, and a comment explaining that this
// layer deliberately does NOT touch the Permanent Studio release mechanism is
// exactly the documentation that should exist — flagging it would punish the
// codebase for being explicit, and would make the test pass again the moment
// somebody deleted the explanation.
const withoutComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map(line => line.replace(/(^|\s)\/\/.*$/, '$1'))
  .join('\n');

// ─── the two planes do not reach into each other ────────────────────────────

test('the Agent Control Plane never references the Permanent Studio release mechanism', async () => {
  // Release bytes, the trust bundle, the durable cache and the artifact bucket
  // belong to the Web plane. The Agent backend must not read them, write them,
  // or take a dependency on them — its storage is /data and nothing else.
  const forbidden = [
    '/studio-cache',
    'studio-release-artifacts',
    'studio-web-permanent',
    'mml-tools-studio-permanent',
    'ops/permanent',
    'durable-v1',
  ];
  const files = [
    ...await sourcesUnder('server'),
    ...await sourcesUnder('studio/backend/application'),
    ...await sourcesUnder('railway', ['.mjs']),
  ];
  assert.ok(files.length >= 15, 'expected to be scanning the real agent-plane sources');

  for (const [path, source] of files) {
    const code = withoutComments(source);
    for (const needle of forbidden) {
      assert.ok(!code.includes(needle), `${path} has a code path reaching the Permanent Studio plane (${needle})`);
    }
    assert.ok(!/from\s+['"][^'"]*ops\/permanent/.test(code), `${path} imports the Permanent Studio release tooling`);
  }
});

test('the Agent backend stores nothing in the Permanent Studio cache', async () => {
  const dockerfile = await readFile(join(root, 'railway/Dockerfile'), 'utf8');
  const settings = JSON.parse(await readFile(join(root, 'railway/service-settings.json'), 'utf8'));

  // The volume this plane mounts, and the directory it writes records to, are
  // both under /data. A default pointing anywhere near /studio-cache would make
  // user song data land in the Web plane's verified release cache.
  assert.equal(settings.volume.mountPath, '/data');
  const dataDir = /MML_STUDIO_DATA_DIR=(\S+)/.exec(dockerfile)?.[1];
  assert.ok(dataDir, 'the image must declare where Studio records are written');
  assert.ok(dataDir.startsWith('/data'), `agent records must live under /data, got ${dataDir}`);

  // Instructions only: a comment naming /studio-cache to say this image has
  // nothing to do with it is correct, and must not fail the check.
  const instructions = dockerfile.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
  assert.ok(!instructions.includes('/studio-cache'), 'no image instruction may touch the Web plane cache');
});

test('the Permanent Studio release mechanism is not built by the Agent backend image', async () => {
  const dockerignore = await readFile(join(root, '.dockerignore'), 'utf8');
  // `ops/` carries the release tooling, pinned artifacts and trust bundle. None
  // of it belongs in the agent image, and the allowlist must not admit it.
  assert.ok(!/^!ops\//m.test(dockerignore), 'the agent image must not ship the release tooling');
  assert.ok(!/^!studio\/web\/(app|worker|storage)\.mjs/m.test(dockerignore), 'the agent image must not ship the local PWA engine or IndexedDB workspace');
  assert.match(dockerignore, /^studio\/web\/\*$/m, 'web files remain excluded except the explicit service workspace');
  assert.match(dockerignore, /^!studio\/web\/service\/index\.html$/m, 'the service workspace is explicitly admitted');
});

// ─── Studio Web does not use the Application Service ────────────────────────

test('nothing the Studio Web app loads imports the Application Service', async () => {
  // This is the structural form of the claim the documentation makes. If Studio
  // Web ever did import it, the browser bundle would pull node:fs and the
  // offline build would break — but the intent is pinned here so the reason is
  // explicit rather than incidental.
  for (const [path, source] of await sourcesUnder('studio/web')) {
    assert.ok(
      !/from\s+['"][^'"]*backend\/application/.test(source),
      `${path} imports the Application Service; Studio Web is a separate plane`,
    );
  }
});

test('the Studio Web build excludes the server-only Application Service', async () => {
  // The Permanent Studio Web release is a pinned, SHA256-verified artifact. If
  // the Application Service entered that bundle, its buildId would change and
  // the release identity would move — so the exclusion is what keeps this PR
  // from touching the Web plane's release at all.
  const build = await readFile(join(root, 'scripts/build-studio-web.mjs'), 'utf8');
  assert.match(build, /SERVER_ONLY_MODULES/);
  assert.ok(build.includes("'studio/backend/application'"), 'the application layer must stay out of the web bundle');
});

// ─── the deployment descriptor matches the image ────────────────────────────

test('every file the Agent backend image ships is covered by a watch pattern', async () => {
  // A path in the image but not in the watch patterns is a path that can change
  // without redeploying, which is how a service silently runs stale code.
  const dockerignore = await readFile(join(root, '.dockerignore'), 'utf8');
  const settings = JSON.parse(await readFile(join(root, 'railway/service-settings.json'), 'utf8'));
  const patterns = settings.build.watchPatterns;

  const shipped = dockerignore
    .split('\n')
    .filter(line => line.startsWith('!'))
    .map(line => line.slice(1).trim())
    // Directory re-includes are covered by their own file entries or a glob;
    // `.git` cannot be watched as a path and is handled by the Manifest entry.
    .filter(path => !path.endsWith('/'));

  assert.ok(shipped.length >= 8, 'expected the real allowlist');
  for (const path of shipped) {
    const covered = patterns.some(pattern => pattern === `/${path}`
      || (pattern.endsWith('/**') && `/${path}`.startsWith(pattern.slice(0, -2))));
    assert.ok(covered, `${path} is in the image but not watched for redeploy`);
  }

  // Directory re-includes still need a glob covering them.
  for (const directory of ['studio/backend/']) {
    assert.ok(
      patterns.some(pattern => pattern.startsWith(`/${directory}`)),
      `${directory} is shipped but no watch pattern covers it`,
    );
  }
});

test('a Canonical release rebuilds the Agent backend', async () => {
  // The Agent backend's Canonical view is pinned at image build: the published
  // history is materialized during the build and nothing fetches at runtime, so
  // refs/remotes/origin/main resolves to the published main head captured when
  // the image was built. Without this watch pattern a Canonical publication
  // would leave the service serving an obsolete Manifest view with no signal
  // that it had.
  const settings = JSON.parse(await readFile(join(root, 'railway/service-settings.json'), 'utf8'));
  assert.ok(
    settings.build.watchPatterns.includes('/docs/CANONICAL_MANIFEST.md'),
    'a Canonical release must trigger an Agent backend rebuild',
  );

  // The rule documents are deliberately absent: they are read from the
  // immutable snapshot the Manifest pins, never from main, so watching them
  // would force rebuilds that cannot change what is loaded.
  for (const ruleSource of ['/docs/MASTER_RULES.md', '/docs/MOBILE_SYNTAX.md']) {
    assert.ok(
      !settings.build.watchPatterns.includes(ruleSource),
      `${ruleSource} is read from the pinned snapshot; watching it rebuilds for nothing`,
    );
  }
});

test('the runtime confirms nothing fetches Git at request time', async () => {
  // The pinned-at-build property above is only true while the runtime loader
  // stays read-only against local objects. A fetch, clone or remote update
  // appearing in it would silently change the Agent backend's Canonical view
  // mid-life.
  //
  // Obtaining the published history is a build-time concern and lives in a
  // separate module, `backend/bootstrap/materialize.mjs`, which the runtime
  // never imports. The split is the point: one module may reach the network and
  // runs once while the image is built; the other is what a request touches and
  // may not. Both properties are asserted, so merging them back together fails
  // here rather than in production.
  const bootstrap = await readFile(join(root, 'studio/backend/bootstrap/index.mjs'), 'utf8');
  for (const networkOperation of ['fetch', 'clone', 'remote', 'pull', 'ls-remote']) {
    assert.ok(
      !new RegExp(`['"]${networkOperation}['"]`).test(bootstrap),
      `the bootstrap runs git ${networkOperation}; the Canonical view would stop being pinned`,
    );
  }
  assert.ok(
    !/^\s*import[^\n]*materialize/m.test(bootstrap),
    'the runtime loader imports the build-time materialization; the Canonical view would stop being pinned',
  );
  for (const [path, source] of await sourcesUnder('railway', ['.mjs'])) {
    assert.ok(!withoutComments(source).includes('materialize'), `${path} reaches the build-time materialization at runtime`);
  }
});

// ─── the permanent plane's own record stays intact ──────────────────────────

test('the Permanent Studio migration record is present and is not a Canonical authority', async () => {
  const migration = await readFile(join(root, 'ops/permanent/MIGRATION_RESULT.md'), 'utf8');
  // Identity this PR must not disturb.
  assert.match(migration, /mml-tools-studio-permanent/);
  assert.match(migration, /studio-web-permanent/);
  assert.match(migration, /\/studio-cache/);

  // It records the same Published Canonical both planes obey, and says plainly
  // that it is deployment material rather than policy.
  assert.ok(migration.includes('0a172900a01fdf39c2e9e84cf176961320b779ea'));
  const readme = await readFile(join(root, 'ops/permanent/README.md'), 'utf8');
  assert.match(readme, /not Canonical policy/);
});

test('the agent plane and the web plane load the same Published Canonical, or the catch-up is recorded', async () => {
  // Two deployments, one authority. If these ever diverged silently, one plane
  // would be applying rules the other had not published.
  const { PUBLISHED_CANONICAL } = await import('../studio/backend/rules/index.mjs');
  const { parseCanonicalManifest } = await import('../studio/backend/bootstrap/index.mjs');
  assert.equal(PUBLISHED_CANONICAL.status, 'CANONICAL_LOADED');
  // The release this tree's Manifest publishes. On published main it is the
  // loaded one; on a publication PR it is the one about to be loaded.
  const loaded = parseCanonicalManifest(await readFile(join(root, 'docs/CANONICAL_MANIFEST.md'), 'utf8')).metadata;
  const served = JSON.parse(await readFile(join(root, 'ops/permanent/release-lock.json'), 'utf8')).canonical;
  const pendingPath = join(root, 'ops/permanent/PENDING_CANONICAL_RELEASE.md');
  const pending = await readFile(pendingPath, 'utf8').catch(() => null);
  if (served.rules_snapshot_sha === loaded.rules_snapshot_sha) {
    assert.equal(served.canonical_version, loaded.canonical_version);
    assert.equal(pending, null, 'a caught-up permanent plane carries no pending catch-up record');
    return;
  }
  // A newer publication reaches the permanent plane only through a durable
  // release packaged from the published main that carries it. Until then the
  // lag is recorded, naming both identities, never silent.
  assert.ok(pending, 'the permanent deployment serves a different rules snapshot than this build loads, and no catch-up is recorded');
  for (const value of [loaded.canonical_version, loaded.rules_snapshot_sha, served.canonical_version, served.rules_snapshot_sha]) {
    assert.ok(pending.includes(value), `the catch-up record must name ${value}`);
  }
});
