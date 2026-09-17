// Agent Control Plane image — the Published Canonical build contract.
//
// Scope: Railway project `mml-tools-allen`, service `mml-tools`, built from
// `railway/Dockerfile`. Not the Permanent Studio Web plane: nothing here reads
// or affects `studio-web-permanent`, its pinned artifact, its trust bundle or
// `/studio-cache`.
//
// What went wrong, and what these pin
// -----------------------------------
// The merged deployment was operationally green — /healthz PASS, container start
// PASS, Railway status SUCCESS — and its own build log said:
//
//   [canonical-bootstrap] git-metadata: MISSING
//   [canonical-bootstrap] refs/remotes/origin/main: MISSING
//   [canonical-bootstrap] rules snapshot 0a172900...: MISSING
//   status=CANONICAL_NOT_LOADED
//
// Railway's GitHub source snapshot carries no `.git`, so the runtime bootstrap —
// which reads the Manifest and every rule document out of Git objects — had
// nothing to read, and the probe that noticed exited 0 anyway. Two defects: the
// image had no way to obtain the published history, and the build shipped
// regardless.
//
// So these run the real production condition. No Docker daemon is available
// here, so the image filesystem is materialised exactly as the `.dockerignore`
// allowlist and `COPY . ./` produce it — with `.git` withheld, which is what
// Railway does — and then the Dockerfile's own two steps are executed against
// it, in order. The published source is a local Git repository reached over
// `file://`, so this never depends on live GitHub.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(resolve(root, path), 'utf8');
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'Image probe', GIT_AUTHOR_EMAIL: 'probe@example.invalid',
    GIT_COMMITTER_NAME: 'Image probe', GIT_COMMITTER_EMAIL: 'probe@example.invalid',
  },
}).trim();

const temporary = (t, prefix) => {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// The allowlist is read rather than restated, so a path added to the image
// without a corresponding entry here cannot make this pass by omission.
const allowlisted = () => read('.dockerignore')
  .split('\n')
  .filter(line => line.startsWith('!'))
  .map(line => line.slice(1).trim())
  .filter(path => path !== '' && !path.endsWith('/'));

/**
 * The image filesystem as Railway delivers it: every allowlisted path, and no
 * `.git`. Dependencies are linked rather than reinstalled; the Dockerfile's
 * `npm install --omit=dev` resolves the single pinned runtime dependency and
 * that is not what is under test here.
 */
function imageWithoutGitMetadata(t) {
  const dir = temporary(t, 'mml-image-');
  for (const path of allowlisted()) {
    const source = resolve(root, path);
    if (!existsSync(source)) continue;
    mkdirSync(dirname(resolve(dir, path)), { recursive: true });
    cpSync(source, resolve(dir, path), { recursive: true });
  }
  // Directory re-includes the allowlist admits wholesale.
  cpSync(resolve(root, 'studio/backend'), resolve(dir, 'studio/backend'), { recursive: true });
  symlinkSync(resolve(root, 'node_modules'), resolve(dir, 'node_modules'), 'dir');
  assert.equal(existsSync(resolve(dir, '.git')), false, 'the fixture must reproduce the no-.git production condition');
  assert.equal(existsSync(resolve(dir, 'docs')), false, 'documents are read from Git objects, never from the image working tree');
  return dir;
}

/** A local stand-in for the published GitHub repository. */
function publishedSource(t) {
  const dir = temporary(t, 'mml-image-published-');
  const bare = resolve(dir, 'published.git');
  git(root, 'clone', '--quiet', '--bare', '--no-local', root, bare);
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(bare, 'update-ref', 'refs/heads/main', git(root, 'rev-parse', 'refs/remotes/origin/main'));
  return { url: `file://${bare}`, head: git(bare, 'rev-parse', 'refs/heads/main') };
}

const runIn = (cwd, command, args, env = {}) => spawnSync(command, args, {
  cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024,
});
const probeLines = output => Object.fromEntries(
  output.split('\n')
    .map(line => line.match(/^\[canonical-bootstrap\] ([a-z_]+)=(.*)$/))
    .filter(Boolean)
    .map(match => [match[1], match[2]]),
);

// ─── the production condition, end to end ───────────────────────────────────

test('the image build reaches CANONICAL_LOADED from a source tree that carries no .git', t => {
  const image = imageWithoutGitMetadata(t);
  const published = publishedSource(t);

  // Step 1 of the Dockerfile's Canonical pair, with the published source
  // redirected to the local fixture. The build passes no such argument.
  const materialize = runIn(image, process.execPath, [
    'scripts/materialize-canonical.mjs', '--root', image, '--published-source', published.url,
  ], { MML_BUILD_SOURCE_HEAD: 'e'.repeat(40) });
  assert.equal(materialize.status, 0, materialize.stderr);
  assert.equal(JSON.parse(materialize.stdout).status, 'CANONICAL_LOADED');

  // Step 2: the gate, unmodified, on the same capability path the runtime serves.
  const probe = runIn(image, 'sh', ['railway/canonical-probe.sh', image]);
  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
  assert.match(probe.stdout, /\[canonical-bootstrap\] gate: PASS/);

  const reported = probeLines(probe.stdout);
  assert.equal(reported.status, 'CANONICAL_LOADED');
  assert.equal(reported.canonical_version, '2026-09-13-v1');
  assert.equal(reported.canonical_status, 'PUBLISHED');
  assert.equal(reported.manifest_version, '2026-09-13-v1-manifest1');
  assert.equal(reported.rules_snapshot_sha, '0a172900a01fdf39c2e9e84cf176961320b779ea');
  assert.match(reported.manifest_commit, /^[0-9a-f]{40}$/);
  assert.equal(reported.published_main_head, published.head);
  assert.equal(reported.repository_head, published.head);
  assert.equal(reported.checkout_identity, 'materialized-published-main');
  assert.equal(reported.build_source_head, 'e'.repeat(40));

  // Six distinct identities, none standing in for another.
  assert.notEqual(reported.rules_snapshot_sha, reported.manifest_commit);
  assert.notEqual(reported.rules_snapshot_sha, reported.published_main_head);
  assert.notEqual(reported.manifest_commit, reported.published_main_head);
  assert.notEqual(reported.build_source_head, reported.published_main_head);
});

test('the build gate refuses an image whose Canonical-aware service would be unusable', t => {
  // Exactly the merged deployment's image: source tree present, no `.git`, no
  // materialization. It used to pass the probe and deploy.
  const image = imageWithoutGitMetadata(t);
  const probe = runIn(image, 'sh', ['railway/canonical-probe.sh', image]);

  assert.notEqual(probe.status, 0, 'a build that cannot load the Published Canonical must not become a deployment');
  assert.match(probe.stdout, /git-metadata: MISSING/);
  assert.match(probe.stdout, /status=CANONICAL_NOT_LOADED/);
  assert.match(probe.stdout, /build refused/);
  assert.doesNotMatch(probe.stdout, /gate: PASS/);
});

test('the build gate refuses an image whose published source cannot be reached', t => {
  const image = imageWithoutGitMetadata(t);
  const absent = `file://${resolve(temporary(t, 'mml-image-absent-'), 'nothing.git')}`;

  const materialize = runIn(image, process.execPath, [
    'scripts/materialize-canonical.mjs', '--root', image, '--published-source', absent,
  ]);
  assert.equal(materialize.status, 1);
  assert.equal(JSON.parse(materialize.stderr).status, 'CANONICAL_NOT_LOADED');
  assert.equal(JSON.parse(materialize.stderr).legacyFallbackAllowed, false);

  // No fallback was taken on the way out: the image is still unloadable, and the
  // gate still refuses it.
  assert.notEqual(runIn(image, 'sh', ['railway/canonical-probe.sh', image]).status, 0);
});

// ─── the image contract ─────────────────────────────────────────────────────

test('the deployment image contract keeps what the bootstrap needs', () => {
  const dockerfile = read('railway/Dockerfile');
  const dockerignore = read('.dockerignore');

  assert.match(dockerfile, /install[^\n]*\bgit\b/, 'the image must install git');
  for (const entry of ['!.git/', '!studio/backend/', '!railway/canonical-probe.sh', '!scripts/materialize-canonical.mjs']) {
    assert.ok(dockerignore.includes(entry), `.dockerignore must admit ${entry}`);
  }

  // Order matters: the history is established, then the result is proven. A
  // gate that ran first would pass on whatever the build context happened to
  // carry, which is the condition that shipped.
  const materializeAt = dockerfile.indexOf('scripts/materialize-canonical.mjs');
  const probeAt = dockerfile.indexOf('canonical-probe.sh');
  assert.ok(materializeAt !== -1, 'the build must establish the published history');
  assert.ok(probeAt > materializeAt, 'the build must prove the Canonical load after establishing it');

  // The build must not name a published source of its own: the default is the
  // published GitHub repository, and an override belongs to regressions only.
  const instructions = dockerfile.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
  assert.ok(!instructions.includes('--published-source'), 'the image build must use the published repository');
});

test('the build probe is a gate, not a warning', () => {
  const probe = read('railway/canonical-probe.sh');
  assert.ok(probe.includes('0a172900a01fdf39c2e9e84cf176961320b779ea'), 'the probe must check the pinned rules snapshot');
  assert.match(probe, /exit 1/, 'the probe must be able to fail the build');
  // The two failures stay distinct: published rules unavailable is not the same
  // defect as an engine module that will not import.
  assert.match(probe, /CANONICAL_LOADED/);
  assert.match(probe, /engine_status/);
});

test('every path the materialization step adds to the image is watched for redeploy', () => {
  const settings = JSON.parse(read('railway/service-settings.json'));
  assert.ok(
    settings.build.watchPatterns.includes('/scripts/materialize-canonical.mjs'),
    'the build-time materialization ships in the image and must trigger a rebuild when it changes',
  );
});

test('the runtime still fetches nothing; only the build does', () => {
  // The Canonical view stays pinned at image build. A fetch appearing in the
  // runtime loader would silently change what a running container loads.
  const loader = read('studio/backend/bootstrap/index.mjs');
  for (const networkOperation of ['fetch', 'clone', 'pull', 'ls-remote']) {
    assert.ok(
      !new RegExp(`['"]${networkOperation}['"]`).test(loader),
      `the runtime loader runs git ${networkOperation}; the Canonical view would stop being pinned`,
    );
  }
  // And the server never reaches the build-time module.
  for (const path of ['railway/server.mjs', 'server/api.mjs', 'server/mcp-studio.mjs', 'studio/backend/rules/index.mjs']) {
    assert.ok(!read(path).includes('materialize'), `${path} must not reach the build-time materialization`);
  }
});
