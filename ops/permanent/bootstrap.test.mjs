import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, appendFile, access, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { bootstrapStudio } from './bootstrap.mjs';

const lock = JSON.parse(await readFile(new URL('./release-lock.json', import.meta.url), 'utf8'));
const assets = resolve(process.env.RELEASE_TEST_ASSETS);
const trustZip = await readFile(resolve(assets, lock.trust.filename));
const archive = await readFile(resolve(assets, lock.artifact.filename));
const close = server => new Promise(resolve => {
  if (!server.listening) { resolve(); return; }
  server.close(resolve);
  // A fetch keeps its connection alive; without this a close waits on it.
  server.closeAllConnections?.();
});

test('empty volume, verified cached start, fail-closed corruption, durable recovery and legacy preservation', async () => {
  const cacheRoot = await mkdtemp(resolve(tmpdir(), 'studio-migration-test-'));
  const events = [];
  let downloads = 0;
  const config = { lock, trustZip, cacheRoot, port: 0, host: '127.0.0.1', log: (event, data) => events.push({ event, ...data }), fetchArchive: async () => { downloads++; return archive; } };
  // Every server this test starts is closed in `finally`: one left listening
  // after a failed assertion keeps the test process alive, and the CI step
  // then hangs instead of reporting the failure.
  const started = [];
  const boot = async options => { const booted = await bootstrapStudio(options); started.push(booted.server); return booted; };
  try {
    // A historical cache must remain usable by rollback code.
    await mkdir(resolve(cacheRoot, 'artifact'));
    await writeFile(resolve(cacheRoot, 'artifact/legacy.txt'), 'historical');
    await writeFile(resolve(cacheRoot, '.ready'), 'ready');
    const first = await boot(config);
    assert.equal(downloads, 1);
    assert.equal(first.mode, 'durable-source');
    const base = `http://127.0.0.1:${first.server.address().port}`;
    for (const path of ['/health', '/', '/build.json', '/sw.js', '/studio/web/app.mjs', '/studio/web/worker.mjs']) assert.equal((await fetch(base + path)).status, 200, path);
    for (const path of ['/', '/index.html', '/sw.js']) {
      const response = await fetch(base + path);
      assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'", `${path} may not be framed`);
      assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
    }
    const health = await (await fetch(base + '/health')).json();
    assert.equal(health.buildId, lock.buildId); assert.equal(health.cacheId, lock.cacheId);
    assert.deepEqual(health.canonical, lock.canonical);
    const positions = ['ARTIFACT_VERIFIED', 'ARTIFACT_ATOMICALLY_COMMITTED', 'READY_MARKER_WRITTEN_AFTER_VERIFICATION', 'SERVER_STARTED'].map(name => events.findIndex(x => x.event === name));
    assert.ok(positions.every((pos, index) => pos >= 0 && (index === 0 || pos > positions[index - 1])));
    await close(first.server);
    const second = await boot({ ...config, fetchArchive: async () => { throw Error('Network must not be used'); } });
    assert.equal(second.mode, 'cache'); assert.equal(downloads, 1);
    await close(second.server);
    await appendFile(resolve(first.artifact, 'studio/web/app.mjs'), '\n// corruption probe\n');
    events.length = 0;
    await assert.rejects(bootstrapStudio(config), /Asset hash mismatch/);
    assert.equal(downloads, 1); assert.ok(events.some(x => x.event === 'CORRUPT_CACHE_REJECTED' && x.readyMarkerPresent));
    assert.ok(!events.some(x => x.event === 'SERVER_STARTED'));
    const recovered = await boot({ ...config, recoverCorrupt: true });
    assert.equal(downloads, 2); assert.equal(recovered.mode, 'durable-source');
    assert.ok(events.some(x => x.event === 'CORRUPT_CACHE_QUARANTINED'));
    assert.equal(await readFile(resolve(cacheRoot, '.ready'), 'utf8'), 'ready');
    assert.equal(await readFile(resolve(cacheRoot, 'artifact/legacy.txt'), 'utf8'), 'historical');
    await close(recovered.server);
  } finally {
    await Promise.all(started.map(close));
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('bad transport bytes and bad trust bytes never commit ready or start a server', async () => {
  for (const corruptTrust of [false, true]) {
    const cacheRoot = await mkdtemp(resolve(tmpdir(), 'studio-rejected-test-'));
    const events = [];
    const bad = Buffer.from(corruptTrust ? trustZip : archive); bad[100] ^= 1;
    try {
      await assert.rejects(bootstrapStudio({ lock, cacheRoot, trustZip: corruptTrust ? bad : trustZip, port: 0, log: event => events.push(event), fetchArchive: async () => bad }), /SHA256 mismatch/);
      await assert.rejects(access(resolve(cacheRoot, 'durable-v1', lock.buildId, '.ready')));
      assert.ok(!events.includes('SERVER_STARTED'));
    } finally { await rm(cacheRoot, { recursive: true, force: true }); }
  }
});
