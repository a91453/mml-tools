// M6 — Canonical bootstrap under parallel test processes.
//
// Every test file is its own process and bootstraps the published Canonical
// from the shared checkout's discovery ref. These tests pin down what the
// loader must guarantee in that setting and reproduce, deterministically and
// in a private repository, the two failure messages that were observed
// intermittently across the full suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { chownSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPublishedCanonical } from '../backend/bootstrap/index.mjs';
import { PUBLISHED_CANONICAL } from '../backend/rules/index.mjs';
import { SUPPORTED_CANONICAL_VERSIONS } from '../backend/rules/supported-releases.mjs';
import { MANIFEST_PATH, PUBLISHED_REF, isolatedRepository, observePublishedRef, repositoryRoot } from './support/isolated-repository.mjs';

const SUPPORTED = SUPPORTED_CANONICAL_VERSIONS;
const notLoaded = pattern => error => error.code === 'CANONICAL_NOT_LOADED' && pattern.test(error.message);

// The two probe Manifests that web-build-reproducibility publishes to prove
// the build fails closed. Published on the *shared* checkout's discovery ref,
// even briefly, they were read by sibling test processes: that was M6.
const unsupportedVersion = text => text
  .replace(/^canonical_version: \S+$/m, 'canonical_version: 2999-01-01-v9')
  .replace(/^manifest_version: \S+$/m, 'manifest_version: 2999-01-01-v9-manifest1');
const unavailableSnapshot = text => text.replace(/rules_snapshot_sha: [0-9a-f]{40}/, `rules_snapshot_sha: ${'0'.repeat(40)}`);

test('M6 signature: both observed messages are the loader refusing a probe Manifest on the discovery ref', t => {
  const shared = observePublishedRef();
  const repo = isolatedRepository(t);
  const source = repo.git('show', `${repo.published}:${MANIFEST_PATH}`);

  repo.publish(repo.republishManifest(unsupportedVersion(source), 'probe: unsupported Canonical version'));
  assert.throws(() => loadPublishedCanonical({ root: repo.dir, supportedCanonicalVersion: SUPPORTED }),
    notLoaded(/^CANONICAL_NOT_LOADED: Implementation does not support the published Canonical version$/));

  repo.publish(repo.republishManifest(unavailableSnapshot(source), 'probe: unavailable rules snapshot'));
  assert.throws(() => loadPublishedCanonical({ root: repo.dir, supportedCanonicalVersion: SUPPORTED }),
    notLoaded(/^CANONICAL_NOT_LOADED: Unpinned snapshot locator: docs\/MASTER_RULES\.md$/));

  // The probes lived in the private repository only: the shared discovery ref
  // was never written, and a bootstrap from the checkout still loads the release.
  assert.deepEqual(observePublishedRef(), shared);
  const loaded = loadPublishedCanonical({ root: repositoryRoot, supportedCanonicalVersion: SUPPORTED });
  assert.deepEqual(loaded.metadata, PUBLISHED_CANONICAL.metadata);
  assert.equal(loaded.provenance.published_main_head, shared.value);
});

test('an isolated repository carries the checkout Git identity but owns its refs', t => {
  const repo = isolatedRepository(t);
  const loaded = loadPublishedCanonical({ root: repo.dir, supportedCanonicalVersion: SUPPORTED });
  assert.deepEqual(loaded.metadata, PUBLISHED_CANONICAL.metadata);
  assert.equal(loaded.provenance.repository_head, PUBLISHED_CANONICAL.provenance.repository_head);
  assert.equal(loaded.provenance.published_main_head, PUBLISHED_CANONICAL.provenance.published_main_head);
  assert.equal(loaded.provenance.manifest_commit, PUBLISHED_CANONICAL.provenance.manifest_commit);
  assert.deepEqual(loaded.documents.map(document => [document.path, document.blob_sha]), PUBLISHED_CANONICAL.documents.map(document => [document.path, document.blob_sha]));

  const shared = observePublishedRef();
  const twin = repo.twinCommit(repo.published, 'probe: advance published main');
  repo.publish(twin);
  assert.equal(repo.git('rev-parse', PUBLISHED_REF), twin);
  assert.deepEqual(observePublishedRef(), shared);
  const advanced = loadPublishedCanonical({ root: repo.dir, supportedCanonicalVersion: SUPPORTED });
  assert.equal(advanced.provenance.published_main_head, twin);
  assert.equal(advanced.provenance.manifest_commit, PUBLISHED_CANONICAL.provenance.manifest_commit);
  assert.deepEqual(advanced.metadata, PUBLISHED_CANONICAL.metadata);
});

// --- Git subprocess fan-out and repository binding -----------------------------

import { BOOTSTRAP_CONTRACT, gitEnvironment, gitSubprocess } from '../backend/bootstrap/index.mjs';

// A counting adapter around the production adapter: the same child processes
// run, and every call is recorded.
function countingGit() {
  const calls = [];
  const git = request => {
    calls.push({ root: request.root, args: request.args, input: request.input ?? null });
    return gitSubprocess(request);
  };
  return { git, calls };
}
const subcommand = args => args.find(arg => !arg.startsWith('-'));

test('one bootstrap is exactly nine bound Git subprocesses, and every read after discovery names a SHA', () => {
  const { git, calls } = countingGit();
  const loaded = loadPublishedCanonical({ root: repositoryRoot, supportedCanonicalVersion: SUPPORTED, git });
  assert.deepEqual(loaded.metadata, PUBLISHED_CANONICAL.metadata);
  assert.deepEqual(loaded.documents, PUBLISHED_CANONICAL.documents);
  assert.equal(calls.length, 9);
  // The `for-each-ref` reads the checkout attestation — provenance labelling,
  // never authority — and is deliberately placed before discovery so that the
  // property below still holds over everything that follows it.
  assert.deepEqual(calls.map(call => subcommand(call.args)), ['rev-parse', 'rev-parse', 'for-each-ref', 'rev-parse', 'cat-file', 'rev-parse', 'log', 'merge-base', 'cat-file']);
  assert.ok(calls.every(call => call.root === repositoryRoot), 'every call is bound to the requested root');
  // The discovery ref is named exactly once; after that, only SHAs are read.
  const named = calls.map(call => `${call.args.join(' ')}\n${call.input ?? ''}`);
  assert.equal(named.filter(text => text.includes(BOOTSTRAP_CONTRACT.publishedRef)).length, 1);
  assert.equal(named.findIndex(text => text.includes(BOOTSTRAP_CONTRACT.publishedRef)), 3);
  for (const text of named.slice(4)) assert.doesNotMatch(text, /refs\/|HEAD/, text);
  // The batch reads name the pinned snapshot for every indexed resource.
  const batch = calls[8];
  assert.equal(subcommand(batch.args), 'cat-file');
  assert.deepEqual(batch.input.trim().split('\n'), loaded.authority.map.map(entry => `${loaded.metadata.rules_snapshot_sha}:${entry.path.replace(/\/$/, '')}`));
});

test('ambient Git redirection cannot move discovery away from the requested root', t => {
  // A second repository whose published Manifest is a probe. Pointing GIT_DIR,
  // GIT_WORK_TREE or injected config at it must not change what `root` loads.
  const other = isolatedRepository(t);
  const source = other.git('show', `${other.published}:${MANIFEST_PATH}`);
  other.publish(other.republishManifest(unsupportedVersion(source), 'probe: unsupported Canonical version'));
  assert.throws(() => loadPublishedCanonical({ root: other.dir, supportedCanonicalVersion: SUPPORTED }), notLoaded(/does not support/));

  const redirected = {
    GIT_DIR: `${other.dir}/.git`, GIT_WORK_TREE: other.dir, GIT_COMMON_DIR: `${other.dir}/.git`,
    GIT_OBJECT_DIRECTORY: `${other.dir}/.git/objects`, GIT_CEILING_DIRECTORIES: repositoryRoot,
    GIT_NAMESPACE: 'probe', GIT_INDEX_FILE: `${other.dir}/.probe-index`,
  };
  const previous = {};
  for (const [key, value] of Object.entries(redirected)) { previous[key] = process.env[key]; process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

  for (const key of Object.keys(redirected)) assert.ok(!(key in gitEnvironment()), `${key} must not reach Git`);
  assert.equal(gitEnvironment().GIT_OPTIONAL_LOCKS, '0');
  const gitPath = Object.entries(gitEnvironment()).find(([key]) => key.toUpperCase() === 'PATH')?.[1];
  assert.equal(gitPath, process.env.PATH);
  const loaded = loadPublishedCanonical({ root: repositoryRoot, supportedCanonicalVersion: SUPPORTED });
  assert.deepEqual(loaded.metadata, PUBLISHED_CANONICAL.metadata);
  assert.deepEqual(loaded.provenance, PUBLISHED_CANONICAL.provenance);
  assert.deepEqual(loaded.documents, PUBLISHED_CANONICAL.documents);
  // And the probe repository still loads as itself: binding is per call, not global.
  assert.throws(() => loadPublishedCanonical({ root: other.dir, supportedCanonicalVersion: SUPPORTED }), notLoaded(/does not support/));
});

test('a root inside a checkout, or a root that is not a checkout, does not bind to the enclosing repository', t => {
  assert.throws(() => loadPublishedCanonical({ root: `${repositoryRoot}studio`, supportedCanonicalVersion: SUPPORTED }), notLoaded(/does not bind to the requested checkout/));
  const empty = isolatedRepository(t, { sources: [] });
  assert.doesNotThrow(() => loadPublishedCanonical({ root: empty.dir, supportedCanonicalVersion: SUPPORTED }));
  assert.throws(() => loadPublishedCanonical({ root: `${empty.dir}/.git/objects`, supportedCanonicalVersion: SUPPORTED }), notLoaded(/./));
  for (const root of ['', 42, null]) assert.throws(() => loadPublishedCanonical({ root, supportedCanonicalVersion: SUPPORTED }), notLoaded(/./));
});

// --- Failure, retry and partial-read semantics ----------------------------------

test('a discovery ref that moves during a load cannot mix two Manifests: the load is the commit it resolved first', t => {
  const repo = isolatedRepository(t);
  const source = repo.git('show', `${repo.published}:${MANIFEST_PATH}`);
  const probe = repo.republishManifest(unsupportedVersion(source), 'probe: unsupported Canonical version');
  const { git, calls } = countingGit();
  // Move the ref the moment the loader has resolved it, before any other read.
  // Discovery is the fourth call: --show-toplevel, HEAD, the checkout
  // attestation, then the published ref.
  const moving = request => {
    const output = git(request);
    if (calls.length === 4) repo.publish(probe);
    return output;
  };
  const loaded = loadPublishedCanonical({ root: repo.dir, supportedCanonicalVersion: SUPPORTED, git: moving });
  assert.equal(repo.git('rev-parse', PUBLISHED_REF), probe, 'the ref did move during the load');
  assert.equal(loaded.provenance.published_main_head, repo.published);
  assert.equal(loaded.provenance.manifest_commit, PUBLISHED_CANONICAL.provenance.manifest_commit);
  assert.equal(loaded.manifest, PUBLISHED_CANONICAL.manifest);
  assert.deepEqual(loaded.metadata, PUBLISHED_CANONICAL.metadata);
  assert.deepEqual(loaded.documents, PUBLISHED_CANONICAL.documents);
  // An independent later call sees the moved ref as itself, completely: refused.
  assert.throws(() => loadPublishedCanonical({ root: repo.dir, supportedCanonicalVersion: SUPPORTED }), notLoaded(/does not support the published Canonical version/));
});

test('a failing Git call fails that load closed without any retry; a later independent call starts from scratch', () => {
  const { git, calls } = countingGit();
  let failures = 0;
  const flaky = request => {
    if (subcommand(request.args) === 'merge-base' && failures === 0) {
      failures += 1;
      throw Object.assign(new Error('spawn git EAGAIN'), { code: 'EAGAIN' });
    }
    return git(request);
  };
  assert.throws(() => loadPublishedCanonical({ root: repositoryRoot, supportedCanonicalVersion: SUPPORTED, git: flaky }),
    error => error.code === 'CANONICAL_NOT_LOADED' && error.cause?.code === 'EAGAIN');
  assert.equal(calls.length, 7, 'the failed call was not retried and nothing ran after it');
  const loaded = loadPublishedCanonical({ root: repositoryRoot, supportedCanonicalVersion: SUPPORTED, git: flaky });
  assert.equal(calls.length, 7 + 9, 'the later call is a complete, independent load');
  assert.deepEqual(loaded.documents, PUBLISHED_CANONICAL.documents);
  assert.deepEqual(loaded.provenance, PUBLISHED_CANONICAL.provenance);
});

test('a module-level failure fails every importer in that process, and stays failed', t => {
  const repo = isolatedRepository(t);
  repo.git('update-ref', '-d', PUBLISHED_REF);
  const code = `
    const results = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { await import('./studio/backend/rules/index.mjs'); results.push('loaded'); }
      catch (error) { results.push(error.code); }
    }
    console.log(JSON.stringify(results));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: repo.dir, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), ['CANONICAL_NOT_LOADED', 'CANONICAL_NOT_LOADED']);
});

test('a short, missing, mistyped, resized or over-long snapshot read fails closed instead of loading part of a release', () => {
  const { git } = countingGit();
  const withBatch = transform => request => {
    const output = git(request);
    return subcommand(request.args) === 'cat-file' && request.input.trim().split('\n').length > 1 ? transform(output, request) : output;
  };
  const firstHeaderEnd = output => output.indexOf(0x0a);
  const cases = {
    'final newline missing': output => output.subarray(0, output.length - 1),
    'last hundred bytes missing': output => output.subarray(0, output.length - 100),
    'one record missing': (output, request) => { const names = request.input.trim().split('\n'); return git({ ...request, input: `${names.slice(0, -1).join('\n')}\n` }); },
    'trailing data': output => Buffer.concat([output, Buffer.from('\n')]),
    'first object reported missing': (output, request) => Buffer.concat([Buffer.from(`${request.input.split('\n')[0]} missing\n`), output.subarray(output.indexOf(0x0a, firstHeaderEnd(output) + 1 + Number(output.subarray(0, firstHeaderEnd(output)).toString().split(' ')[2])) + 1)]),
    'first object mistyped': output => Buffer.concat([Buffer.from(output.subarray(0, firstHeaderEnd(output)).toString().replace(' blob ', ' tree ')), output.subarray(firstHeaderEnd(output))]),
    'first size understated': output => Buffer.concat([Buffer.from(output.subarray(0, firstHeaderEnd(output)).toString().replace(/ (\d+)$/, (_, size) => ` ${Number(size) - 1}`)), output.subarray(firstHeaderEnd(output))]),
    'first content altered': output => { const copy = Buffer.from(output); const at = copy.indexOf('Status: PUBLISHED CANONICAL'); copy.write('Status: DRAFT____ CANONICAL', at); return copy; },
  };
  for (const [name, transform] of Object.entries(cases)) {
    assert.throws(() => loadPublishedCanonical({ root: repositoryRoot, supportedCanonicalVersion: SUPPORTED, git: withBatch(transform) }), notLoaded(/./), name);
  }
  assert.deepEqual(loadPublishedCanonical({ root: repositoryRoot, supportedCanonicalVersion: SUPPORTED, git: withBatch(output => output) }).documents, PUBLISHED_CANONICAL.documents);
});

test('a successful result is deeply immutable, so no consumer can alter what another consumer loaded', () => {
  const loaded = loadPublishedCanonical({ root: repositoryRoot, supportedCanonicalVersion: SUPPORTED });
  for (const target of [loaded, loaded.metadata, loaded.provenance, loaded.authority, loaded.authority.map, loaded.authority.map[0], loaded.documents, loaded.documents[0]]) assert.ok(Object.isFrozen(target));
  assert.throws(() => { loaded.documents[0].content = 'edited'; }, TypeError);
  assert.throws(() => { loaded.authority.map[0].path = 'skills/legacy.md'; }, TypeError);
  assert.throws(() => { loaded.provenance.published_main_head = loaded.provenance.repository_head; }, TypeError);
  assert.throws(() => loaded.documents.pop(), TypeError);
  assert.deepEqual(loaded.documents, PUBLISHED_CANONICAL.documents);
});

// --- Cross-process concurrency and repository identity ---------------------------

const fingerprint = canonical => ({
  metadata: canonical.metadata,
  provenance: canonical.provenance,
  manifest: createHash('sha256').update(canonical.manifest).digest('hex'),
  documents: canonical.documents.map(document => [document.path, document.blob_sha, createHash('sha256').update(document.content).digest('hex')]),
});

test('concurrent processes bootstrapping from the same checkout agree on every identity and document', async () => {
  const count = Math.max(8, availableParallelism() * 2);
  const code = `import('./studio/backend/rules/index.mjs').then(m => {
    const c = m.PUBLISHED_CANONICAL; const h = t => require('node:crypto').createHash('sha256').update(t).digest('hex');
    process.stdout.write(JSON.stringify({ metadata: c.metadata, provenance: c.provenance, manifest: h(c.manifest), documents: c.documents.map(d => [d.path, d.blob_sha, h(d.content)]) }));
  })`;
  const children = Array.from({ length: count }, () => new Promise(resolvePromise => {
    const child = spawn(process.execPath, ['-e', code], { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolvePromise({ status, stdout, stderr }));
  }));
  const results = await Promise.all(children);
  const expected = fingerprint(PUBLISHED_CANONICAL);
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
});

test('results are per repository root: nothing loaded for one root is reused for another', t => {
  const advanced = isolatedRepository(t);
  advanced.publish(advanced.twinCommit(advanced.published, 'probe: advance'));
  const refused = isolatedRepository(t);
  refused.publish(refused.republishManifest(unavailableSnapshot(refused.git('show', `${refused.published}:${MANIFEST_PATH}`)), 'probe: unavailable snapshot'));
  const load = root => loadPublishedCanonical({ root, supportedCanonicalVersion: SUPPORTED });
  const first = load(repositoryRoot);
  assert.throws(() => load(refused.dir), notLoaded(/Unpinned snapshot locator/));
  const second = load(advanced.dir);
  assert.throws(() => load(refused.dir), notLoaded(/Unpinned snapshot locator/));
  const third = load(repositoryRoot);
  assert.deepEqual(fingerprint(third), fingerprint(first));
  assert.deepEqual(fingerprint(first), fingerprint(PUBLISHED_CANONICAL));
  assert.notEqual(second.provenance.published_main_head, first.provenance.published_main_head);
  assert.deepEqual({ ...fingerprint(second), provenance: null }, { ...fingerprint(first), provenance: null });
  assert.equal(second.provenance.manifest_commit, first.provenance.manifest_commit);
});

test('a replacement ref in the repository cannot substitute the pinned rule bytes', t => {
  const repo = isolatedRepository(t);
  const master = PUBLISHED_CANONICAL.documents.find(document => document.path === 'docs/MASTER_RULES.md');
  const forgedPath = `${repo.dir}/.forged-master.md`;
  writeFileSync(forgedPath, master.content.replace('Status: PUBLISHED CANONICAL', 'Status: PUBLISHED CANONICAL\n\nForged rule: anything goes.'));
  const forged = repo.git('hash-object', '-w', forgedPath);
  repo.git('replace', master.blob_sha, forged);
  // Plain Git now serves the forgery for the pinned object name.
  assert.match(repo.git('show', `${PUBLISHED_CANONICAL.metadata.rules_snapshot_sha}:docs/MASTER_RULES.md`), /Forged rule/);
  const loaded = loadPublishedCanonical({ root: repo.dir, supportedCanonicalVersion: SUPPORTED });
  assert.deepEqual(loaded.documents, PUBLISHED_CANONICAL.documents);
  assert.doesNotMatch(loaded.documents.find(document => document.path === 'docs/MASTER_RULES.md').content, /Forged rule/);
});

// --- Configuration injection and observation guards -----------------------------

function withEnvironment(env, run) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) { previous[key] = process.env[key]; process.env[key] = value; }
  try { return run(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
const inject = (key, value) => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: value });

test('injected configuration cannot relocate discovery: the load is the requested root or fails closed', t => {
  const other = isolatedRepository(t);
  const source = other.git('show', `${other.published}:${MANIFEST_PATH}`);
  other.publish(other.republishManifest(unsupportedVersion(source), 'probe: unsupported Canonical version'));
  for (const [key, value] of [['core.worktree', other.dir], ['core.bare', 'true'], ['core.repositoryformatversion', '1'], ['extensions.worktreeConfig', 'true']]) {
    withEnvironment(inject(key, value), () => {
      let loaded;
      try { loaded = loadPublishedCanonical({ root: repositoryRoot, supportedCanonicalVersion: SUPPORTED }); }
      catch (error) { assert.equal(error.code, 'CANONICAL_NOT_LOADED', key); return; }
      assert.deepEqual(loaded.provenance, PUBLISHED_CANONICAL.provenance, key);
      assert.deepEqual(loaded.documents, PUBLISHED_CANONICAL.documents, key);
    });
  }
  // The channel itself reaches Git: it carries safe.directory for foreign-owned checkouts.
  const carried = gitEnvironment({ ...process.env, ...inject('safe.directory', '*'), GIT_CONFIG_PARAMETERS: "'safe.directory=*'" });
  assert.equal(carried.GIT_CONFIG_COUNT, '1');
  assert.equal(carried.GIT_CONFIG_KEY_0, 'safe.directory');
  assert.equal(carried.GIT_CONFIG_PARAMETERS, "'safe.directory=*'");
  assert.deepEqual(loadPublishedCanonical({ root: repositoryRoot, supportedCanonicalVersion: SUPPORTED }).metadata, PUBLISHED_CANONICAL.metadata);
});

test('a foreign-owned checkout is refused by Git unless safe.directory arrives through the injection channel',
  { skip: process.getuid?.() !== 0 && 'creating a foreign-owned checkout needs root' }, t => {
  const foreign = isolatedRepository(t);
  const chownTree = path => { chownSync(path, 65534, 65534); for (const entry of readdirSync(path, { withFileTypes: true })) { const child = join(path, entry.name); if (entry.isDirectory()) chownTree(child); else if (!entry.isSymbolicLink()) chownSync(child, 65534, 65534); } };
  chownTree(foreign.dir);
  assert.throws(() => loadPublishedCanonical({ root: foreign.dir, supportedCanonicalVersion: SUPPORTED }), error => error.code === 'CANONICAL_NOT_LOADED' && /dubious ownership/.test(String(error.cause?.stderr ?? error.cause?.message ?? '')));
  withEnvironment(inject('safe.directory', '*'), () => {
    assert.deepEqual(loadPublishedCanonical({ root: foreign.dir, supportedCanonicalVersion: SUPPORTED }).metadata, PUBLISHED_CANONICAL.metadata);
  });
});

test('the published-ref observation sees a delete-and-recreate, not only a rewrite-and-restore', t => {
  const repo = isolatedRepository(t);
  const before = observePublishedRef(repo.dir);
  assert.deepEqual(observePublishedRef(repo.dir), before, 'observing is read-only and stable');
  repo.git('update-ref', '-d', PUBLISHED_REF);
  repo.publish(repo.published);
  const recreated = observePublishedRef(repo.dir);
  assert.equal(recreated.value, before.value);
  assert.notDeepEqual(recreated, before);
  const twin = repo.twinCommit(repo.published, 'probe');
  const settled = observePublishedRef(repo.dir);
  repo.publish(twin);
  repo.publish(repo.published);
  assert.notDeepEqual(observePublishedRef(repo.dir), settled);
});
