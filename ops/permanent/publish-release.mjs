// Run only in the authorised release workflow. Never replace an existing asset.
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const dir = resolve(process.argv[2]);
const lock = JSON.parse(await readFile(resolve(dir, 'release-lock.json'), 'utf8'));
const repo = 'a91453/mml-tools';
if (process.env.GITHUB_REPOSITORY !== repo || !process.env.GITHUB_TOKEN) throw Error('Release publishing context missing');
const headers = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
async function api(path, method = 'GET', data = null) {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method, headers: { ...headers, 'Content-Type': 'application/json' }, body: data === null ? null : JSON.stringify(data),
  });
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) throw Error(`GitHub ${method} ${path}: ${response.status}`);
  return response.json();
}
let release = await api(`/releases/tags/${lock.tag}`);
const notes = `Reviewed Studio v1 artifact rebuilt from merged main ${lock.sourceSha}.\n\nCanonical: ${lock.canonical.canonical_version} / PUBLISHED\nRules snapshot: ${lock.canonical.rules_snapshot_sha}\nManifest commit: ${lock.manifestCommit}\n\nbuildId: ${lock.buildId}\ncacheId: ${lock.cacheId}\nArtifact ZIP SHA256: ${lock.artifact.sha256}\nTrusted verifier/template source: ${lock.trust.sourceSha}\nTrusted ZIP SHA256: ${lock.trust.sha256}\n\nRuntime artifact and trust bundle are separate. Deployment pins the checksums independently. No temporary preview is a release source. No historical release identity is overwritten.\n`;
if (!release) release = await api('/releases', 'POST', { tag_name: lock.tag, target_commitish: lock.sourceSha, name: 'Studio v1 durable release — 5769e76849e5', body: notes, draft: true, prerelease: false, make_latest: 'false' });
if (release.target_commitish !== lock.sourceSha) throw Error('Existing release target is different');
const names = (await readdir(dir)).sort();
if (names.join(',') !== [lock.artifact.filename, lock.trust.filename, 'release-lock.json', 'SHA256SUMS'].sort().join(',')) throw Error('Unexpected release contents');
for (const name of names) {
  const bytes = await readFile(resolve(dir, name));
  const sha = createHash('sha256').update(bytes).digest('hex');
  const existing = release.assets.find(asset => asset.name === name);
  if (existing) {
    if (existing.digest !== `sha256:${sha}` || existing.size !== bytes.length) throw Error(`Refusing to overwrite existing asset ${name}`);
    continue;
  }
  if (!release.draft) throw Error('Published release is incomplete; refusing to modify it');
  const url = `${release.upload_url.split('{')[0]}?name=${encodeURIComponent(name)}`;
  if (!url.startsWith('https://uploads.github.com/repos/a91453/mml-tools/releases/')) throw Error('Unexpected upload destination');
  const response = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: bytes });
  if (!response.ok) throw Error(`Asset upload failed: ${name}: ${response.status}`);
  const asset = await response.json();
  if (asset.digest !== `sha256:${sha}` || asset.size !== bytes.length) throw Error(`Uploaded asset digest mismatch: ${name}`);
}
release = await api(`/releases/${release.id}`);
if (release.assets.length !== names.length) throw Error('Release asset count mismatch');
if (release.draft) release = await api(`/releases/${release.id}`, 'PATCH', { draft: false, make_latest: 'false' });
console.log(JSON.stringify({ status: 'DURABLE_RELEASE_PUBLISHED', id: release.id, url: release.html_url, tag: release.tag_name, immutable: release.immutable, target: release.target_commitish, assets: release.assets.map(({ id, name, size, digest }) => ({ id, name, size, digest })) }));
