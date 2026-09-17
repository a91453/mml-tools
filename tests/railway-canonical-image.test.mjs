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
// So these run the real production condition. CI has no Docker daemon, so the
// image filesystem is materialised exactly as the `.dockerignore` allowlist and
// `COPY . ./` produce it — with `.git` withheld, which is what Railway does —
// and then the Dockerfile's own two steps are executed against it, in order. The
// published source is a local Git repository reached over `file://`, so this
// never depends on live GitHub.
//
// The credential-handling assertions below are structural for the same reason:
// they pin the two Dockerfile properties that were measured with a real build
// (see railway/README.md for the numbers), so that a later edit which would
// reintroduce the leak fails here rather than in a build log nobody reads.

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

  // Order matters: the history is established, then the result is proven, and
  // the proof runs in the stage that ships so that what is proven is the image
  // that deploys. A gate that ran first would pass on whatever the build context
  // happened to carry, which is the condition that shipped.
  const materializeAt = dockerfile.indexOf('RUN node scripts/materialize-canonical.mjs');
  const probeAt = dockerfile.indexOf('RUN sh railway/canonical-probe.sh');
  assert.ok(probeAt > dockerfile.lastIndexOf('FROM '), 'the gate must run in the stage that ships');
  assert.ok(materializeAt !== -1, 'the build must establish the published history');
  assert.ok(probeAt > materializeAt, 'the build must prove the Canonical load after establishing it');

  // The build must not name a published source of its own: the default is the
  // published GitHub repository, and an override belongs to regressions only.
  const instructions = dockerfile.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
  assert.ok(!instructions.includes('--published-source'), 'the image build must use the published repository');
});

test('the read credential is declared only in the stage that does not ship', () => {
  // Measured on BuildKit 29.3.1, on exactly this pattern: with the ARG in the
  // stage that produces the final image, the value lands in two `docker history`
  // entries and in the exported image's config blob, readable by anyone who can
  // pull it. With the ARG confined to an earlier stage, zero occurrences in the
  // exported image. Railway documents no `--mount=type=secret` and provides no
  // way to supply one, so the stage split is the mitigation available, and a
  // single added ARG line in the final stage silently undoes it.
  const dockerfile = read('railway/Dockerfile');
  const instructions = dockerfile.split('\n')
    .map((line, index) => [index + 1, line.trim()])
    .filter(([, line]) => line !== '' && !line.startsWith('#'));

  let stage = null;
  const declaredIn = [];
  const stages = [];
  for (const [, line] of instructions) {
    if (/^FROM /i.test(line)) {
      stage = / AS (\S+)/i.exec(line)?.[1] ?? null;
      stages.push(stage);
    }
    if (/^ARG\s+MML_CANONICAL_SOURCE_TOKEN\b/i.test(line)) declaredIn.push(stage);
  }

  assert.ok(stages.length >= 2, 'the credential needs a stage that does not ship');
  assert.equal(stages.at(-1), null, 'the last stage is the image that ships and must be unnamed');
  assert.deepEqual(declaredIn, ['canonical'], 'the credential ARG must be declared once, and only in the builder stage');
  assert.ok(
    instructions.some(([, line]) => /^COPY\s+--from=canonical\b/i.test(line)),
    'the shipping stage must take its filesystem from the builder stage',
  );

  // And it must never become an ENV, which would put it in the running
  // container's environment and in the image config for good.
  assert.ok(
    !instructions.some(([, line]) => /^ENV[^\n]*MML_CANONICAL_SOURCE_TOKEN/i.test(line)),
    'the credential must never be promoted to ENV',
  );

  // No RUN may name the credential either. BuildKit prints the *expanded* RUN
  // command as the step title, so `RUN FOO="$FOO" ...` publishes the value to
  // the build log on every build — measured, before this was changed. An ARG is
  // already exported into the command's environment, so the step needs to name
  // nothing.
  for (const [line, text] of instructions) {
    if (!/^RUN\b/i.test(text)) continue;
    assert.ok(
      !text.includes('MML_CANONICAL_SOURCE_TOKEN'),
      `Dockerfile line ${line} names the credential in a RUN; BuildKit would print its value into the build log`,
    );
  }
});

test('the build reads the platform source head without naming it in a RUN either', () => {
  // Same mechanism, same fix: the step reads MML_BUILD_SOURCE_HEAD and, failing
  // that, Railway's own RAILWAY_GIT_COMMIT_SHA, straight from the environment.
  const dockerfile = read('railway/Dockerfile');
  assert.match(dockerfile, /^ARG RAILWAY_GIT_COMMIT_SHA=$/m, 'the build must opt in to the platform source head');
  for (const line of dockerfile.split('\n')) {
    if (!/^RUN\b/.test(line.trim())) continue;
    assert.ok(!line.includes('RAILWAY_GIT_COMMIT_SHA'), 'no RUN may expand the platform source head inline');
  }
  const cli = read('scripts/materialize-canonical.mjs');
  assert.ok(cli.includes("'MML_BUILD_SOURCE_HEAD', 'RAILWAY_GIT_COMMIT_SHA'"), 'the step must read both names itself');
});

test('the running service drops the build credential and never hands it to a child', async () => {
  // Railway has no build-only variable scope: its docs say a service variable is
  // provided to the build AND to the running deployment, and sealing one changes
  // who can read it back, not where it is injected. So the credential arrives in
  // the container at runtime, where nothing needs it. The exports are named for
  // what they hold — credentials the build consumes — rather than for a platform
  // scope that does not exist.
  const bootstrap = await import('../studio/backend/bootstrap/index.mjs');
  const { scrubBuildCredentialVariables, BUILD_CREDENTIAL_VARIABLES, gitSubprocess } = bootstrap;
  assert.deepEqual([...BUILD_CREDENTIAL_VARIABLES], ['MML_CANONICAL_SOURCE_TOKEN']);
  // The old names claimed a scope Railway does not provide, so they must not
  // linger as aliases that keep the misleading term reachable.
  for (const retired of ['BUILD_ONLY_VARIABLES', 'scrubBuildOnlyVariables']) {
    assert.equal(bootstrap[retired], undefined, `${retired} names a scope Railway has no such thing as`);
  }

  const environment = { MML_CANONICAL_SOURCE_TOKEN: 'ghp_SYNTHETIC_TEST_TOKEN_NEVER_REAL', PATH: process.env.PATH };
  assert.deepEqual(scrubBuildCredentialVariables(environment), ['MML_CANONICAL_SOURCE_TOKEN']);
  assert.ok(!Object.hasOwn(environment, 'MML_CANONICAL_SOURCE_TOKEN'));
  assert.equal(environment.PATH, process.env.PATH, 'nothing else may be removed');
  assert.deepEqual(scrubBuildCredentialVariables({}), [], 'absent is not an error');

  // The runtime Git adapter is the second, independent removal: even an entry
  // point that skipped the scrub cannot leak the credential into a Git child.
  //
  // Observed rather than asserted on the adapter's shape: a Git credential
  // helper is an ordinary child process that inherits Git's environment, so
  // asking one to echo the variable reports what the child actually received.
  // No identity, config, network or repository state is involved, so this says
  // the same thing on a bare CI runner as it does on a developer machine.
  const token = 'ghp_SYNTHETIC_TEST_TOKEN_NEVER_REAL_0123456789';
  const helper = 'credential.helper=!f() { printf \'%s\\n\' "username=probe" "password=${MML_CANONICAL_SOURCE_TOKEN:-ABSENT}"; }; f';
  const askHelper = run => String(run({ root, args: ['-c', helper, 'credential', 'fill'], input: 'protocol=https\nhost=probe.invalid\n\n' }));

  const previous = process.env.MML_CANONICAL_SOURCE_TOKEN;
  process.env.MML_CANONICAL_SOURCE_TOKEN = token;
  try {
    const throughRuntime = askHelper(gitSubprocess);
    assert.match(throughRuntime, /password=ABSENT/, 'the runtime Git adapter must not hand the credential to a child');
    assert.ok(!throughRuntime.includes(token), 'the credential reached a Git child of the runtime adapter');

    // Control: the same probe, run with the environment left alone, must see the
    // credential. Without it the assertion above could pass for the wrong reason
    // — a helper that never ran, or one that always prints ABSENT.
    const throughUnscrubbed = askHelper(({ root: cwd, args, input }) => execFileSync('git', args, {
      cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
    }));
    assert.match(throughUnscrubbed, new RegExp(`password=${token}`), 'the probe must be able to observe the credential when it is present');

    // (That the build-time adapter still supplies it is covered end to end by
    // studio/tests/bootstrap-materialize.test.mjs, which materializes through it
    // with a token and asserts which calls carry the credential.)
  } finally {
    if (previous === undefined) delete process.env.MML_CANONICAL_SOURCE_TOKEN;
    else process.env.MML_CANONICAL_SOURCE_TOKEN = previous;
  }

  // The entry point performs the removal before it serves anything.
  const server = read('railway/server.mjs');
  assert.match(server, /scrubBuildCredentialVariables\(\)/, 'the service must drop the build credential at startup');
  const body = server.slice(server.lastIndexOf('import '));
  assert.ok(
    body.indexOf('scrubBuildCredentialVariables()') < body.indexOf('export function createApplication'),
    'the removal must precede anything that reads the environment',
  );
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
  // And no runtime module reaches the build-time one. The property is reaching
  // it — importing it or calling into it — not naming it: the public failure
  // notice tells an operator which build step did not complete, and has to be
  // able to say so in words.
  for (const path of ['railway/server.mjs', 'server/api.mjs', 'server/mcp-studio.mjs', 'studio/backend/rules/index.mjs']) {
    const source = read(path);
    assert.doesNotMatch(source, /(?:^|\n)\s*import[^\n]*bootstrap\/materialize/, `${path} imports the build-time materialization`);
    assert.doesNotMatch(source, /import\s*\(\s*['"][^'"]*materialize/, `${path} dynamically imports the build-time materialization`);
    assert.doesNotMatch(source, /materializePublishedCanonical|materializeSubprocess/, `${path} calls into the build-time materialization`);
  }
});
