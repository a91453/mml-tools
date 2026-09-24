// Run only in the authorised release workflow. Never replace an existing asset.
import { readFile, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = 'a91453/mml-tools';
const releasesPerPage = 100;
const maxReleasePages = 100;

// GET /releases/tags/{tag} answers only for a published release: a draft does
// not own its tag yet. A draft left behind by a run that failed during the
// uploads is therefore found by listing every release, so a re-run resumes it
// instead of creating a second draft with the same tag.
async function findResumableDraft(api, lock) {
  const drafts = [];
  for (let page = 1; ; page++) {
    if (page > maxReleasePages) throw Error(`More than ${maxReleasePages * releasesPerPage} releases; refusing to guess whether a draft exists`);
    const releases = await api(`/releases?per_page=${releasesPerPage}&page=${page}`);
    if (!Array.isArray(releases)) throw Error(`GitHub GET /releases page ${page}: expected a list of releases`);
    drafts.push(...releases.filter(release => release.draft === true && release.tag_name === lock.tag
      && (!lock.sourceSha || release.target_commitish === lock.sourceSha)));
    if (releases.length < releasesPerPage) break;
  }
  if (drafts.length > 1) throw Error(`Refusing to choose between ${drafts.length} draft releases for tag ${lock.tag} (ids ${drafts.map(release => release.id).join(', ')}); delete the extra drafts, then re-run`);
  return drafts[0] ?? null;
}

// `fetch` and `env` are injectable so the publishing logic can be tested
// against a fake GitHub API; the command line below passes neither.
export async function publishRelease(directory, { fetch: fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const dir = resolve(directory);
  const lock = JSON.parse(await readFile(resolve(dir, 'release-lock.json'), 'utf8'));
  if (env.GITHUB_REPOSITORY !== repo || !env.GITHUB_TOKEN) throw Error('Release publishing context missing');
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  async function api(path, method = 'GET', data = null) {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      method, headers: { ...headers, 'Content-Type': 'application/json' }, body: data === null ? null : JSON.stringify(data),
    });
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) throw Error(`GitHub ${method} ${path}: ${response.status}`);
    return response.json();
  }
  let release = await api(`/releases/tags/${lock.tag}`);
  const notes = `Reviewed Studio v1 artifact rebuilt from merged main ${lock.sourceSha}.\n\nCanonical: ${lock.canonical.canonical_version} / PUBLISHED\nRules snapshot: ${lock.canonical.rules_snapshot_sha}\nManifest commit: ${lock.manifestCommit}\n\nbuildId: ${lock.buildId}\ncacheId: ${lock.cacheId}\nArtifact ZIP SHA256: ${lock.artifact.sha256}\nTrusted verifier/template source: ${lock.trust.sourceSha}\nTrusted ZIP SHA256: ${lock.trust.sha256}\n\nRuntime artifact and trust bundle are separate. Deployment pins the checksums independently. No temporary preview is a release source. No historical release identity is overwritten.\n`;
  if (!release) release = await findResumableDraft(api, lock);
  if (!release) release = await api('/releases', 'POST', { tag_name: lock.tag, target_commitish: lock.sourceSha, name: `Studio v1 durable release — ${lock.sourceSha.slice(0, 12)}`, body: notes, draft: true, prerelease: false, make_latest: 'false' });
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
    const response = await fetchImpl(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: bytes });
    if (!response.ok) throw Error(`Asset upload failed: ${name}: ${response.status}`);
    const asset = await response.json();
    if (asset.digest !== `sha256:${sha}` || asset.size !== bytes.length) throw Error(`Uploaded asset digest mismatch: ${name}`);
  }
  release = await api(`/releases/${release.id}`);
  if (release.assets.length !== names.length) throw Error('Release asset count mismatch');
  if (release.draft) release = await api(`/releases/${release.id}`, 'PATCH', { draft: false, make_latest: 'false' });
  return { status: 'DURABLE_RELEASE_PUBLISHED', id: release.id, url: release.html_url, tag: release.tag_name, immutable: release.immutable, target: release.target_commitish, assets: release.assets.map(({ id, name, size, digest }) => ({ id, name, size, digest })) };
}

const invokedAsScript = (() => {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (invokedAsScript) console.log(JSON.stringify(await publishRelease(process.argv[2])));
