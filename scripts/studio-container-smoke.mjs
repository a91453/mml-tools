// Runs the actual production image, never a staged source-tree substitute.
// Only a disposable local container, random test password and tmpfs are used.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

export const WORKSPACE_ASSETS = Object.freeze([
  ['/studio/', 'index.html', 'text/html'],
  ['/studio/app.mjs', 'app.mjs', 'text/javascript'],
  ['/studio/client.mjs', 'client.mjs', 'text/javascript'],
  ['/studio/style.css', 'style.css', 'text/css'],
]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Dependency injection tests the assertions, not Docker or the real service.
// A PASS from those tests must never be described as an image smoke PASS.
export async function verifyService({ baseURL, expectedOrigin, expectedAssets, fetchImpl = fetch }) {
  const checked = [];
  const request = (path, method = 'GET') => fetchImpl(baseURL + path, {
    method, redirect: 'manual', signal: AbortSignal.timeout(10000),
  });
  const health = await request('/healthz');
  assert.equal(health.status, 200, 'health HTTP status');
  assert.equal((await health.json()).status, 'ok', 'health payload');
  checked.push('health');
  const root = await request('/');
  assert.equal(root.status, 200, 'public provenance HTTP status');
  const { canonical } = await root.json();
  assert.equal(canonical?.status, 'CANONICAL_LOADED', 'published Canonical must load');
  assert.equal(canonical.canonical_status, 'PUBLISHED', 'published release status');
  for (const field of ['rules_snapshot_sha', 'manifest_commit', 'published_main_head']) {
    assert.match(canonical[field] ?? '', /^[0-9a-f]{40}$/, `separate provenance: ${field}`);
  }
  assert.ok(!canonical.engine_status, 'Canonical engine must be available');
  checked.push('published-provenance');
  const assets = [];
  for (const [path, file, type] of WORKSPACE_ASSETS) {
    assert.ok(expectedAssets.has(file), `expected source asset: ${file}`);
    const response = await request(path);
    assert.equal(response.status, 200, `asset HTTP status: ${path}`);
    assert.equal(response.headers.get('content-type')?.split(';')[0], type, `asset MIME: ${path}`);
    assert.equal(response.headers.get('cache-control'), 'no-store', `asset cache policy: ${path}`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', `asset nosniff: ${path}`);
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/, `asset CSP: ${path}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(sha256(bytes), sha256(expectedAssets.get(file)), `image/source asset identity: ${path}`);
    const head = await request(path, 'HEAD');
    assert.equal(head.status, 200, `HEAD status: ${path}`);
    assert.equal((await head.arrayBuffer()).byteLength, 0, `HEAD body: ${path}`);
    assert.equal((await request(path, 'POST')).status, 405, `read-only asset: ${path}`);
    assets.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  checked.push('all-workspace-assets-byte-identical', 'asset-headers-and-methods');
  for (const path of ['/studio', '/studio/index.html']) {
    const response = await request(path);
    assert.equal(response.status, 302, `workspace redirect status: ${path}`);
    assert.equal(response.headers.get('location'), '/studio/', `workspace redirect target: ${path}`);
  }
  assert.equal((await request('/studio/not-an-asset')).status, 404, 'unknown assets fail closed');
  checked.push('fixed-asset-routes');
  const discovery = await request('/.well-known/oauth-authorization-server');
  assert.equal(discovery.status, 200, 'OAuth discovery status');
  const metadata = await discovery.json();
  assert.equal(metadata.issuer, expectedOrigin, 'OAuth issuer');
  for (const [field, path] of [['authorization_endpoint', '/oauth/authorize'], ['token_endpoint', '/oauth/token'], ['registration_endpoint', '/oauth/register']]) {
    assert.equal(metadata[field], expectedOrigin + path, `OAuth endpoint: ${field}`);
  }
  checked.push('oauth-origin-binding');
  for (const [path, method] of [['/api/v1/projects', 'GET'], ['/api/v1/capabilities', 'GET'], ['/mcp', 'POST']]) {
    const response = await request(path, method);
    assert.equal(response.status, 401, `unauthenticated access denied: ${path}`);
    assert.match(response.headers.get('www-authenticate') ?? '', /Bearer/i, `OAuth challenge: ${path}`);
  }
  checked.push('unauthenticated-api-and-mcp-denied');
  return { checked, canonical, assets };
}

function docker(args, { env = process.env, optional = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', env, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  if (!optional && (result.error || result.status !== 0)) {
    // Do not echo environment, inspect payloads, or command output on failure.
    throw Error(`Docker ${args[0]} failed (${result.error?.code ?? result.status})`);
  }
  return result.stdout?.trim() ?? '';
}

export async function runContainerSmoke({ image, out }) {
  assert.match(image, /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/, 'valid local image reference');
  const name = 'mml-studio-smoke-' + randomUUID();
  const origin = 'https://studio-smoke.invalid';
  const report = { scope: 'Local production-image smoke only; not Railway deployment or song acceptance',
    status: 'FAIL', tested_checkout: process.env.GITHUB_SHA ?? null, pr_head: process.env.MML_CI_PR_HEAD ?? null };
  await mkdir(dirname(resolve(out)), { recursive: true });
  try {
    const imageInfo = JSON.parse(docker(['image', 'inspect', image]))[0];
    assert.ok(!(imageInfo.Config.Env ?? []).some(value => /^MML_CANONICAL_SOURCE_TOKEN=/.test(value)), 'build credential must not be a runtime image variable');
    report.image_id = imageInfo.Id;
    const expectedAssets = new Map(await Promise.all(WORKSPACE_ASSETS.map(async ([, file]) => [file, await readFile(new URL('../studio/web/service/' + file, import.meta.url))])));
    docker(['run', '--detach', '--name', name, '--publish', '127.0.0.1::3000',
      '--tmpfs', '/data:rw,nosuid,nodev', '--env', 'MML_OWNER_PASSWORD',
      '--env', 'MML_PUBLIC_ORIGIN=' + origin, '--env', 'MML_STUDIO_DURABILITY=unknown', image],
      { env: { ...process.env, MML_OWNER_PASSWORD: randomBytes(48).toString('hex') } });
    const inspect = JSON.parse(docker(['inspect', name]))[0];
    const port = inspect.NetworkSettings.Ports['3000/tcp'][0];
    assert.equal(port.HostIp, '127.0.0.1', 'test container must bind only to loopback');
    const baseURL = 'http://127.0.0.1:' + port.HostPort;
    let ready = false;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      try { if ((await fetch(baseURL + '/healthz', { signal: AbortSignal.timeout(2000) })).status === 200) { ready = true; break; } } catch {}
      if (docker(['inspect', '--format', '{{.State.Running}}', name]) !== 'true') throw Error('test container exited before readiness');
      await delay(500);
    }
    assert.ok(ready, 'real container must become ready within 90 seconds');
    // Exercise the image's own capability/engine gate, not just /healthz.
    docker(['exec', name, 'sh', 'railway/canonical-probe.sh', '/app']);
    Object.assign(report, await verifyService({ baseURL, expectedOrigin: origin, expectedAssets }));
    report.checked.push('runtime-capability-probe', 'loopback-and-ephemeral-data');
    report.status = 'PASS';
    return report;
  } finally {
    docker(['rm', '--force', name], { optional: true });
    await writeFile(resolve(out), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { image: { type: 'string' }, out: { type: 'string' } } });
  if (!values.image || !values.out) throw Error('Usage: node scripts/studio-container-smoke.mjs --image IMAGE --out REPORT.json');
  const report = await runContainerSmoke(values);
  console.log(JSON.stringify({ status: report.status, image_id: report.image_id, checked: report.checked }));
}
