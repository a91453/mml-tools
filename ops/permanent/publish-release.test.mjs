// publish-release.mjs against a fake GitHub Releases API. Nothing here reaches
// the network: the script receives the fake through its `fetch` option, and the
// global fetch is replaced by one that fails the test if it is ever called.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publishRelease } from './publish-release.mjs';

const script = fileURLToPath(new URL('./publish-release.mjs', import.meta.url));
const lockBytes = await readFile(new URL('./release-lock.json', import.meta.url));
const lock = JSON.parse(lockBytes);
const env = { GITHUB_REPOSITORY: 'a91453/mml-tools', GITHUB_TOKEN: 'test-token' };
const otherSha = '0123456789abcdef0123456789abcdef01234567';

let realFetch;
const stagedRoots = [];
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async url => { throw Error(`Test tried to reach the network: ${url}`); };
});
after(async () => {
  globalThis.fetch = realFetch;
  await Promise.all(stagedRoots.map(root => rm(root, { recursive: true, force: true })));
});

// The four files the release workflow stages, with stand-in ZIP bytes.
async function stageAssets() {
  const root = await mkdtemp(resolve(tmpdir(), 'publish-release-test-'));
  stagedRoots.push(root);
  const dir = resolve(root, 'assets');
  await mkdir(dir);
  const files = {
    [lock.artifact.filename]: Buffer.from('runtime artifact bytes'),
    [lock.trust.filename]: Buffer.from('trust bundle bytes'),
    'release-lock.json': lockBytes,
    SHA256SUMS: Buffer.from('checksums'),
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(resolve(dir, name), bytes);
  return { root, dir, files, names: Object.keys(files).sort() };
}

const assetRecord = (id, name, bytes) => ({ id, name, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
const releaseRecord = ({ id, tag = lock.tag, target = lock.sourceSha, draft, assets = [] }) => ({
  id, tag_name: tag, target_commitish: target, draft, immutable: false,
  html_url: `https://github.com/a91453/mml-tools/releases/${draft ? `untagged-${id}` : `tag/${tag}`}`,
  upload_url: `https://uploads.github.com/repos/a91453/mml-tools/releases/${id}/assets{?name,label}`,
  assets,
});

// Behaves like the GitHub endpoints the script uses. In particular
// GET /releases/tags/{tag} returns only a published release (404 for a draft),
// and GET /releases lists drafts too, `per_page` at a time.
function fakeGitHub({ releases = [], failUpload = () => false } = {}) {
  const gh = { releases: structuredClone(releases), calls: [], nextId: 1000, uploadCount: 0 };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const find = id => gh.releases.find(release => release.id === Number(id));
  gh.fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    gh.calls.push({ method, host: url.host, path: url.pathname, query: Object.fromEntries(url.searchParams), body: init.body });
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    const base = '/repos/a91453/mml-tools/releases';
    let match;
    if (url.host === 'api.github.com') {
      if (method === 'GET' && (match = url.pathname.match(/^\/repos\/a91453\/mml-tools\/releases\/tags\/(.+)$/))) {
        const published = gh.releases.find(release => release.tag_name === decodeURIComponent(match[1]) && !release.draft);
        return published ? json(published) : json({ message: 'Not Found' }, 404);
      }
      if (method === 'GET' && url.pathname === base) {
        const perPage = Number(url.searchParams.get('per_page') ?? 30);
        const page = Number(url.searchParams.get('page') ?? 1);
        return json(gh.releases.slice((page - 1) * perPage, page * perPage));
      }
      if (method === 'POST' && url.pathname === base) {
        const body = JSON.parse(init.body);
        const created = releaseRecord({ id: gh.nextId++, tag: body.tag_name, target: body.target_commitish, draft: body.draft });
        gh.releases.push(created);
        return json(created, 201);
      }
      if ((match = url.pathname.match(/^\/repos\/a91453\/mml-tools\/releases\/(\d+)$/)) && find(match[1])) {
        const release = find(match[1]);
        if (method === 'PATCH') release.draft = JSON.parse(init.body).draft;
        if (method === 'GET' || method === 'PATCH') return json(release);
      }
    }
    if (url.host === 'uploads.github.com' && method === 'POST' && (match = url.pathname.match(/^\/repos\/a91453\/mml-tools\/releases\/(\d+)\/assets$/))) {
      const release = find(match[1]);
      const name = url.searchParams.get('name');
      gh.uploadCount++;
      if (failUpload(gh.uploadCount, name)) return json({ message: 'Bad Gateway' }, 502);
      const asset = assetRecord(gh.nextId++, name, Buffer.from(init.body));
      release.assets.push(asset);
      return json(asset, 201);
    }
    throw Error(`Fake GitHub has no route for ${method} ${url}`);
  };
  gh.count = (method, predicate = () => true) => gh.calls.filter(call => call.method === method && predicate(call)).length;
  gh.uploads = () => gh.calls.filter(call => call.host === 'uploads.github.com').map(call => ({ release: Number(call.path.split('/')[5]), name: call.query.name }));
  gh.listed = () => gh.count('GET', call => call.path === '/repos/a91453/mml-tools/releases');
  gh.created = () => gh.count('POST', call => call.path === '/repos/a91453/mml-tools/releases');
  gh.patched = () => gh.count('PATCH');
  return gh;
}

test('a first run creates exactly one draft, uploads every asset and publishes it', async () => {
  const { dir, names } = await stageAssets();
  const gh = fakeGitHub();
  const result = await publishRelease(dir, { fetch: gh.fetch, env });
  // With no published release for the tag, the release list is checked for an
  // interrupted draft before a new one is created.
  const steps = gh.calls.filter(call => call.host === 'api.github.com').map(call => `${call.method} ${call.path}`);
  assert.deepEqual(steps.slice(0, 3), [
    `GET /repos/a91453/mml-tools/releases/tags/${lock.tag}`,
    'GET /repos/a91453/mml-tools/releases',
    'POST /repos/a91453/mml-tools/releases',
  ]);
  assert.equal(gh.listed(), 1);
  assert.equal(gh.created(), 1);
  assert.equal(gh.releases.length, 1);
  const [release] = gh.releases;
  const body = JSON.parse(gh.calls.find(call => call.method === 'POST' && call.host === 'api.github.com').body);
  assert.equal(body.tag_name, lock.tag);
  assert.equal(body.target_commitish, lock.sourceSha);
  assert.equal(body.draft, true);
  assert.deepEqual(gh.uploads(), names.map(name => ({ release: release.id, name })));
  assert.equal(release.draft, false);
  assert.equal(gh.patched(), 1);
  assert.equal(result.status, 'DURABLE_RELEASE_PUBLISHED');
  assert.equal(result.id, release.id);
  assert.deepEqual(result.assets.map(asset => asset.name).sort(), names);
});

test('a re-run after a partial upload resumes that draft and uploads only the missing asset', async () => {
  const { dir, names, files } = await stageAssets();
  const missing = names.at(-1);
  const gh = fakeGitHub({ failUpload: (count, name) => name === missing && count === names.length });
  await assert.rejects(publishRelease(dir, { fetch: gh.fetch, env }), new RegExp(`Asset upload failed: ${missing.replaceAll('.', '\\.')}: 502`));
  assert.equal(gh.releases.length, 1);
  const [draft] = gh.releases;
  assert.equal(draft.draft, true);
  assert.deepEqual(draft.assets.map(asset => asset.name), names.slice(0, -1));

  gh.calls.length = 0;
  const result = await publishRelease(dir, { fetch: gh.fetch, env });
  assert.equal(gh.created(), 0, 'the re-run must not create a second draft');
  assert.equal(gh.releases.length, 1);
  assert.deepEqual(gh.uploads(), [{ release: draft.id, name: missing }]);
  assert.equal(result.id, draft.id);
  assert.equal(draft.draft, false);
  assert.deepEqual(draft.assets.map(asset => asset.name).sort(), names);
  for (const asset of draft.assets) assert.equal(asset.digest, assetRecord(0, asset.name, files[asset.name]).digest);
});

test('the draft is found beyond the first page, and drafts for another tag or target are not candidates', async () => {
  const { dir, names, files } = await stageAssets();
  const others = Array.from({ length: 100 }, (_, index) => releaseRecord({ id: index + 1, tag: `other-${index}`, draft: index % 2 === 0 }));
  const partial = releaseRecord({ id: 500, draft: true, assets: [assetRecord(501, names[0], files[names[0]])] });
  const gh = fakeGitHub({
    releases: [
      ...others,
      releaseRecord({ id: 400, tag: `${lock.tag}-other`, draft: true }),
      releaseRecord({ id: 401, target: otherSha, draft: true }),
      partial,
    ],
  });
  const result = await publishRelease(dir, { fetch: gh.fetch, env });
  assert.equal(gh.created(), 0);
  assert.ok(gh.listed() >= 2, 'the listing must continue past a full first page');
  assert.deepEqual(gh.uploads(), names.slice(1).map(name => ({ release: 500, name })));
  assert.equal(result.id, 500);
  assert.equal(gh.releases.find(release => release.id === 401).assets.length, 0);
});

test('a resumed draft whose existing asset differs is refused, not overwritten', async () => {
  const { dir, names } = await stageAssets();
  const gh = fakeGitHub({ releases: [releaseRecord({ id: 7, draft: true, assets: [assetRecord(8, names[0], Buffer.from('different bytes'))] })] });
  await assert.rejects(publishRelease(dir, { fetch: gh.fetch, env }), new RegExp(`Refusing to overwrite existing asset ${names[0]}`));
  assert.equal(gh.created(), 0);
  assert.deepEqual(gh.uploads(), []);
  assert.equal(gh.patched(), 0);
});

test('two matching drafts are refused instead of guessing which one to resume', async () => {
  const { dir, names, files } = await stageAssets();
  const gh = fakeGitHub({
    releases: [
      releaseRecord({ id: 11, draft: true, assets: [assetRecord(12, names[0], files[names[0]])] }),
      releaseRecord({ id: 13, draft: true }),
    ],
  });
  await assert.rejects(publishRelease(dir, { fetch: gh.fetch, env }), /Refusing to choose between 2 draft releases for tag .* \(ids 11, 13\)/);
  assert.equal(gh.created(), 0);
  assert.deepEqual(gh.uploads(), []);
  assert.equal(gh.patched(), 0);
  assert.equal(gh.releases.length, 2);
});

test('a published release still follows the existing path', async () => {
  const { dir, names, files } = await stageAssets();
  const complete = releaseRecord({ id: 21, draft: false, assets: names.map((name, index) => assetRecord(30 + index, name, files[name])) });
  // A matching draft next to the published release must not be consulted.
  const gh = fakeGitHub({ releases: [releaseRecord({ id: 20, draft: true }), complete] });
  const result = await publishRelease(dir, { fetch: gh.fetch, env });
  assert.deepEqual(gh.calls.map(call => `${call.method} ${call.path}`), [
    `GET /repos/a91453/mml-tools/releases/tags/${lock.tag}`,
    'GET /repos/a91453/mml-tools/releases/21',
  ]);
  assert.equal(result.id, 21);
  assert.equal(result.status, 'DURABLE_RELEASE_PUBLISHED');

  const incomplete = fakeGitHub({ releases: [releaseRecord({ id: 22, draft: false, assets: [assetRecord(40, names[0], files[names[0]])] })] });
  await assert.rejects(publishRelease(dir, { fetch: incomplete.fetch, env }), /Published release is incomplete; refusing to modify it/);
  assert.equal(incomplete.listed(), 0);
  assert.equal(incomplete.created(), 0);
  assert.deepEqual(incomplete.uploads(), []);

  const retargeted = fakeGitHub({ releases: [releaseRecord({ id: 23, target: otherSha, draft: false })] });
  await assert.rejects(publishRelease(dir, { fetch: retargeted.fetch, env }), /Existing release target is different/);
  assert.equal(retargeted.listed(), 0);
});

test('the command line still publishes through the global fetch and prints the summary', async () => {
  const { root, dir, names, files } = await stageAssets();
  const published = releaseRecord({ id: 51, draft: false, assets: names.map((name, index) => assetRecord(60 + index, name, files[name])) });
  const preload = resolve(root, 'fake-fetch.mjs');
  await writeFile(preload, `const release = ${JSON.stringify(published)};
globalThis.fetch = async url => {
  const path = new URL(url).pathname;
  if (path === '/repos/a91453/mml-tools/releases/tags/${lock.tag}' || path === '/repos/a91453/mml-tools/releases/51') return new Response(JSON.stringify(release));
  throw Error('unexpected request ' + url);
};\n`);
  const run = extraEnv => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script, dir], { encoding: 'utf8', env: { PATH: process.env.PATH, ...extraEnv } });
  const ok = run(env);
  assert.equal(ok.status, 0, ok.stderr);
  const summary = JSON.parse(ok.stdout);
  assert.equal(summary.status, 'DURABLE_RELEASE_PUBLISHED');
  assert.equal(summary.id, 51);
  const refused = run({});
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Release publishing context missing/);
});
