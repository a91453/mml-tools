// Deployment adapter only. All Studio schema/SW verification stays in the
// unchanged repository verifier from the independently pinned trust bundle.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile, rename, lstat, rm, open } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (condition, message) => { if (!condition) throw Error(`DURABLE_BOOTSTRAP_REJECTED: ${message}`); };
const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const logDefault = (event, details = {}) => console.log(JSON.stringify({ event, time: new Date().toISOString(), ...details }));

// The release packager emits this deliberately small, deterministic ZIP subset.
// Authenticate the complete archive BEFORE examining or extracting any member.
async function extractPinnedZip(bytes, pin, destination) {
  need(bytes.length === pin.bytes && hash(bytes) === pin.sha256, 'Archive length or SHA256 mismatch');
  need(bytes.length >= 22, 'Truncated ZIP');
  const end = bytes.length - 22;
  need(bytes.readUInt32LE(end) === 0x06054b50 && bytes.readUInt16LE(end + 20) === 0, 'Unsupported ZIP trailer');
  const count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16), size = bytes.readUInt32LE(end + 12);
  need(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0 && bytes.readUInt16LE(end + 8) === count, 'Multi-disk ZIP rejected');
  need(count > 0 && count < 1000 && offset + size === end, 'Invalid ZIP directory');
  let cursor = offset;
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    need(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50, 'Invalid ZIP entry');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20), length = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16, local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    need(flags === 0 && method === 0 && compressed === length, 'ZIP must use unencrypted stored entries');
    need((mode & 0o170000) === 0o100000, 'Non-regular ZIP member rejected');
    need(/^[a-zA-Z0-9_./-]+$/.test(name) && !name.startsWith('/') && !name.split('/').some(x => !x || x === '.' || x === '..') && !seen.has(name), 'Unsafe or duplicate ZIP path');
    seen.add(name);
    need(local + 30 <= offset && bytes.readUInt32LE(local) === 0x04034b50, 'Invalid ZIP local header');
    need(bytes.readUInt16LE(local + 6) === flags && bytes.readUInt16LE(local + 8) === method && bytes.readUInt32LE(local + 18) === length && bytes.readUInt32LE(local + 22) === length, 'ZIP headers disagree');
    const ln = bytes.readUInt16LE(local + 26), le = bytes.readUInt16LE(local + 28);
    need(bytes.subarray(local + 30, local + 30 + ln).toString('utf8') === name, 'ZIP path headers disagree');
    const start = local + 30 + ln + le;
    need(start + length <= offset, 'ZIP member exceeds data area');
    const path = resolve(destination, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes.subarray(start, start + length), { flag: 'wx', mode: 0o644 });
    cursor += 46 + nameLength + extra + comment;
  }
  need(cursor === end, 'ZIP directory length mismatch');
}

async function regularFiles(dir, base = '') {
  const files = [];
  for (const item of await readdir(resolve(dir, base), { withFileTypes: true })) {
    const name = base ? `${base}/${item.name}` : item.name;
    if (item.isDirectory()) files.push(...await regularFiles(dir, name));
    else { need(item.isFile(), `Non-regular cached path: ${name}`); files.push(name); }
  }
  return files.sort();
}

async function writeSynced(path, bytes) {
  const file = await open(path, 'wx', 0o644);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

async function syncDirectory(path) {
  const dir = await open(path, 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}

export async function bootstrapStudio({ lock, trustZip, fetchArchive, soundBanks = null, cacheRoot = '/studio-cache', recoverCorrupt = false, port = 8080, host = '0.0.0.0', log = logDefault }) {
  need(lock.schema === 'studio-durable-release-v1', 'Release lock schema missing');
  need(/^[a-f0-9]{64}$/.test(lock.buildId) && lock.trust.sourceSha === lock.sourceSha, 'Release/trust pins missing');
  const parent = resolve(cacheRoot, 'durable-v1');
  const releaseRoot = resolve(parent, lock.buildId);
  const artifact = resolve(releaseRoot, 'artifact');
  const ready = resolve(releaseRoot, '.ready');
  const trustRoot = await mkdtemp(resolve(tmpdir(), 'studio-trusted-'));
  let stage = null;
  let mode = 'cache';
  const expected = { buildId: lock.buildId, sourceSha: lock.sourceSha, ...lock.canonical };
  try {
    await extractPinnedZip(Buffer.from(trustZip), lock.trust, trustRoot);
    need((await regularFiles(trustRoot)).join('\n') === Object.keys(lock.trust.files).sort().join('\n'), 'Trust bundle file set mismatch');
    for (const [path, sha] of Object.entries(lock.trust.files)) need(hash(await readFile(resolve(trustRoot, path))) === sha, `Trusted source mismatch: ${path}`);
    log('TRUSTED_SOURCE_VERIFIED', { sourceSha: lock.trust.sourceSha, sha256: lock.trust.sha256 });
    // A separate resolved URL prevents Railway Function dependency discovery
    // from misreading the local trusted path as an npm package named scripts.
    const trustedEntryUrl = pathToFileURL(resolve(trustRoot, 'scripts', 'verify-studio-artifact.mjs')).href;
    const { verifyStudioArtifact } = await import(trustedEntryUrl);
    async function verify(dir) {
      need((await lstat(dir)).isDirectory(), 'Artifact root is not a real directory');
      await regularFiles(dir); // Reject symlinks before repository traversal.
      need(hash(await readFile(resolve(dir, 'build.json'))) === lock.buildJsonSha256, 'build.json differs from the authorised ZIP');
      const result = await verifyStudioArtifact(dir, expected);
      need(result.release.cacheId === lock.cacheId, 'cacheId pin mismatch');
      need(result.release.runtimeBundleDigest === lock.runtimeBundleDigest, 'runtimeBundleDigest pin mismatch');
      need(result.audit.repository_head === lock.sourceSha && result.audit.manifest_commit === lock.manifestCommit, 'Audit source/Manifest mismatch');
      need(result.assetCount === lock.assetCount, 'Asset count pin mismatch');
      log('ARTIFACT_VERIFIED', { buildId: result.buildId, cacheId: result.release.cacheId, sourceSha: result.audit.source_sha, assetCount: result.assetCount, canonical: result.release.canonical });
      return result;
    }
    await mkdir(parent, { recursive: true });
    let cached = false;
    if (await exists(releaseRoot)) {
      need((await lstat(releaseRoot)).isDirectory(), 'Release root is not a real directory');
      try { await verify(artifact); cached = true; }
      catch (error) {
        log('CORRUPT_CACHE_REJECTED', { reason: error.message, readyMarkerPresent: await exists(ready) });
        if (!recoverCorrupt) throw error;
        const quarantine = `${releaseRoot}.quarantine-${randomUUID()}`;
        await rename(releaseRoot, quarantine);
        await syncDirectory(parent);
        log('CORRUPT_CACHE_QUARANTINED', { quarantine });
      }
    }
    if (!cached) {
      mode = 'durable-source';
      stage = await mkdtemp(resolve(parent, '.staging-'));
      const target = resolve(stage, 'artifact');
      await mkdir(target);
      log('DURABLE_DOWNLOAD_STARTED', { objectKey: lock.artifact.objectKey, sha256: lock.artifact.sha256 });
      const bytes = Buffer.from(await fetchArchive(lock.artifact));
      await extractPinnedZip(bytes, lock.artifact, target);
      log('DURABLE_ZIP_VERIFIED', { sha256: hash(bytes), bytes: bytes.length });
      await verify(target);
      // Ensure the complete verified bytes are flushed before atomic publication.
      for (const path of await regularFiles(target)) { const file = await open(resolve(target, path), 'r'); try { await file.sync(); } finally { await file.close(); } }
      await syncDirectory(target);
      await rename(stage, releaseRoot); stage = null;
      await syncDirectory(parent);
      log('ARTIFACT_ATOMICALLY_COMMITTED', { releaseRoot });
    } else log('VALIDATED_CACHE_STARTUP', { buildId: lock.buildId, refetch: false });
    // Serve an immutable in-memory snapshot of verified bytes. A later disk
    // mutation cannot be served by an already running instance.
    const manifestBytes = await readFile(resolve(artifact, 'build.json'));
    need(hash(manifestBytes) === lock.buildJsonSha256, 'build.json changed after verification');
    const manifest = JSON.parse(manifestBytes);
    const files = new Map([['build.json', manifestBytes]]);
    for (const [name, sha] of manifest.files) {
      const bytes = await readFile(resolve(artifact, name));
      need(hash(bytes) === sha, `Cached asset changed after verification: ${name}`);
      files.set(name, bytes);
    }
    const receipt = { buildId: lock.buildId, cacheId: lock.cacheId, sourceSha: lock.sourceSha, canonical: lock.canonical, zipSha256: lock.artifact.sha256, trustSourceSha: lock.trust.sourceSha };
    const markerTemp = `${ready}.${randomUUID()}.tmp`;
    await writeSynced(markerTemp, JSON.stringify(receipt) + '\n');
    await rename(markerTemp, ready); await syncDirectory(releaseRoot);
    log('READY_MARKER_WRITTEN_AFTER_VERIFICATION', receipt);
    const health = Buffer.from(JSON.stringify({ status: 'ready', bootstrap: mode, ...receipt }));
    // Sound banks are never part of the reviewed artifact (its verifier
    // rejects them). They are pinned separately, read from the private bucket
    // on first request, checked against their pins and kept in memory; a
    // failed read answers 503 and is retried by the next request.
    const banks = new Map();
    if (soundBanks) {
      need(soundBanks.schema === 'studio-sound-banks-v1' && Array.isArray(soundBanks.banks), 'Sound bank pin schema missing');
      for (const bank of soundBanks.banks) for (const pin of bank.files) {
        need(/^banks\/[a-z0-9-]+\/[a-f0-9]{64}\.[a-z0-9]+$/.test(pin.path) && pin.path.includes(pin.sha256) && Number.isSafeInteger(pin.bytes) && pin.bytes > 0 && typeof pin.objectKey === 'string' && pin.objectKey, `Invalid sound bank pin: ${pin.path}`);
        need(!files.has(pin.path) && !banks.has(pin.path), `Sound bank path collides: ${pin.path}`);
        banks.set(pin.path, { pin, bytes: null, pending: null });
      }
    }
    const bankBytes = entry => {
      if (entry.bytes) return Promise.resolve(entry.bytes);
      if (!entry.pending) {
        entry.pending = (async () => {
          const bytes = Buffer.from(await fetchArchive(entry.pin));
          need(bytes.length === entry.pin.bytes && hash(bytes) === entry.pin.sha256, `Sound bank SHA256 mismatch: ${entry.pin.path}`);
          log('SOUND_BANK_VERIFIED', { path: entry.pin.path, sha256: entry.pin.sha256, bytes: bytes.length });
          return (entry.bytes = bytes);
        })();
        entry.pending.catch(error => log('SOUND_BANK_UNAVAILABLE', { path: entry.pin.path, reason: error.message }))
          .then(() => { entry.pending = null; });
      }
      return entry.pending;
    };
    const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
    // Studio Web keeps the user's projects in same-origin IndexedDB and has
    // state-changing UI, and it never frames itself, so no page may frame
    // it (clickjacking). X-Frame-Options covers engines without CSP 3.
    const secure = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' };
    const server = createServer(async (req, res) => {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
      let path;
      try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
      catch { res.writeHead(400); res.end('Bad request'); return; }
      const name = path === '/' ? 'index.html' : path.slice(1);
      const bank = banks.get(name);
      if (bank) {
        let bytes;
        try { bytes = await bankBytes(bank); }
        catch { res.writeHead(503, { 'Cache-Control': 'no-store', 'Retry-After': '30', ...secure }); res.end('Sound bank unavailable'); return; }
        // The path carries the SHA-256, so the bytes behind it never change.
        res.writeHead(200, { 'Content-Type': bank.pin.contentType ?? 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'public, max-age=31536000, immutable', ...secure });
        res.end(req.method === 'HEAD' ? undefined : bytes);
        return;
      }
      const bytes = path === '/health' ? health : files.get(name);
      if (!bytes) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': path === '/health' ? 'application/json' : (types[extname(name)] ?? 'application/octet-stream'), 'Content-Length': bytes.length, 'Cache-Control': 'no-store', ...secure });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    log('SERVER_STARTED', { port: server.address().port, bootstrap: mode, buildId: lock.buildId, cacheId: lock.cacheId });
    return { server, releaseRoot, artifact, ready, mode };
  } catch (error) {
    log('BOOTSTRAP_FAILED_CLOSED', { reason: error.message, serverStarted: false });
    if (stage) await rm(stage, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(trustRoot, { recursive: true, force: true });
  }
}
