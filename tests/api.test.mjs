// Application HTTP API — transport regressions.
//
// `/api/v1/*` is this repository's own interface, served by this process. These
// tests exercise the adapter: framing, routing, status mapping, upload handling
// and the authorization boundary. What the operations mean is covered by the
// Application Service suites; nothing here asserts a musical verdict.

import test from 'node:test';
import assert from 'node:assert/strict';

import { API_PREFIX, createApiRouter } from '../server/api.mjs';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { sixRoleBaseline, canonicalProjectBytes, keepEveryRole } from '../studio/tests/fixtures/application-fixtures.mjs';

const ORIGIN = 'https://mml.example';
const OWNER = 'owner:service';

function setup({ owner = OWNER, application = createStudioApplication({ transports: ['http'] }) } = {}) {
  const route = createApiRouter({ application, ownerOf: () => owner });
  const send = (method, path, { body, headers = {}, authenticated = true } = {}) =>
    route(new Request(`${ORIGIN}${API_PREFIX}${path}`, { method, headers, ...(body === undefined ? {} : { body }) }), { authenticated });
  const json = async (method, path, payload, options = {}) => {
    const response = await send(method, path, {
      ...options,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    });
    return { response, body: await response.json() };
  };
  return { application, send, json };
}

const multipart = (boundary, parts) => {
  const encoder = new TextEncoder();
  const chunks = [];
  for (const part of parts) {
    const disposition = part.filename === undefined
      ? `form-data; name="${part.name}"`
      : `form-data; name="${part.name}"; filename="${part.filename}"`;
    const type = part.contentType ? `\r\nContent-Type: ${part.contentType}` : '';
    chunks.push(encoder.encode(`--${boundary}\r\nContent-Disposition: ${disposition}${type}\r\n\r\n`));
    chunks.push(part.bytes ?? encoder.encode(part.value ?? ''));
    chunks.push(encoder.encode('\r\n'));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
};

// ─── routing and framing ────────────────────────────────────────────────────

test('the router only answers for its own prefix', async () => {
  const { application } = setup();
  const route = createApiRouter({ application, ownerOf: () => OWNER });
  assert.equal(await route(new Request(`${ORIGIN}/healthz`), { authenticated: true }), null);
  assert.equal(await route(new Request(`${ORIGIN}/mcp`, { method: 'POST' }), { authenticated: true }), null);
  assert.notEqual(await route(new Request(`${ORIGIN}${API_PREFIX}/capabilities`), { authenticated: true }), null);
});

test('capabilities are served and describe this build', async () => {
  const { json } = setup();
  const { response, body } = await json('GET', '/capabilities');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(body.interface, 'studio-application/v1');
  assert.equal(body.canonical.status, 'CANONICAL_LOADED');
  assert.equal(body.cost.additional_recurring_cost, 'NONE');
  assert.equal(body.cost.llm_api_dependency, 'NONE');
});

test('an unknown endpoint is 404 and a wrong method is 405 with Allow', async () => {
  const { send, json } = setup();
  assert.equal((await send('GET', '/nope')).status, 404);
  const response = await send('DELETE', '/projects');
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, POST');
  assert.equal((await json('DELETE', '/projects')).body.error.code, 'METHOD_NOT_ALLOWED');
});

test('a JSON endpoint refuses a non-JSON body and malformed JSON', async () => {
  const { send } = setup();
  assert.equal((await send('POST', '/projects', { body: 'title=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 400);
  assert.equal((await send('POST', '/projects', { body: '{', headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await send('POST', '/projects', { body: '[]', headers: { 'content-type': 'application/json' } })).status, 400);
});

// ─── authorization ──────────────────────────────────────────────────────────

test('every endpoint except none is behind the authentication check', async () => {
  const { send } = setup();
  for (const [method, path] of [
    ['GET', '/capabilities'],
    ['GET', '/projects'],
    ['POST', '/projects'],
    ['GET', '/projects/prj_00000000000000000000000000000000'],
    ['POST', '/projects/prj_00000000000000000000000000000000/assets'],
    ['POST', '/projects/prj_00000000000000000000000000000000/intake'],
    ['POST', '/projects/prj_00000000000000000000000000000000/finalize'],
    ['GET', '/jobs/job_00000000000000000000000000000000'],
    ['GET', '/artifacts/art_' + '0'.repeat(64)],
    ['POST', '/technical/validate'],
  ]) {
    const response = await send(method, path, { authenticated: false, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.equal(response.status, 401, `${method} ${path} must require authentication`);
    assert.equal((await response.json()).error.code, 'NOT_AUTHENTICATED');
  }
});

test('an unauthenticated request is refused before any owner subject is derived', async () => {
  const application = createStudioApplication({});
  let derived = 0;
  const route = createApiRouter({ application, ownerOf: () => { derived += 1; return OWNER; } });
  await route(new Request(`${ORIGIN}${API_PREFIX}/projects`), { authenticated: false });
  assert.equal(derived, 0);
});

// ─── projects and ownership ─────────────────────────────────────────────────

test('projects are created, listed and fetched', async () => {
  const { json } = setup();
  const created = await json('POST', '/projects', { title: 'HTTP project' });
  assert.equal(created.response.status, 201);
  assert.match(created.body.project.project_id, /^prj_[0-9a-f]{32}$/);
  assert.equal(created.body.canonical.status, 'CANONICAL_LOADED');

  const listed = await json('GET', '/projects');
  assert.equal(listed.body.projects.length, 1);

  const fetched = await json('GET', `/projects/${created.body.project.project_id}`);
  assert.equal(fetched.body.project.title, 'HTTP project');
});

test('a project belonging to another owner is 404, not 403', async () => {
  const application = createStudioApplication({});
  const mine = setup({ owner: 'owner:alice', application });
  const theirs = setup({ owner: 'owner:bob', application });

  const created = await mine.json('POST', '/projects', { title: 'Alice' });
  const projectId = created.body.project.project_id;

  const { response, body } = await theirs.json('GET', `/projects/${projectId}`);
  // 404 rather than 403 on purpose: distinguishing "exists but forbidden" from
  // "does not exist" is an existence oracle over another owner's identifiers.
  assert.equal(response.status, 404);
  assert.equal(body.error.code, 'PROJECT_NOT_FOUND');
  assert.deepEqual((await theirs.json('GET', '/projects')).body.projects, []);
});

test('a path-traversal or malformed identifier is refused, never resolved', async () => {
  const { send } = setup();
  for (const bad of ['..%2f..%2fetc%2fpasswd', '%2e%2e%2f%2e%2e%2fsecret', 'prj_notahex', 'C:%5Cwindows']) {
    const response = await send('GET', `/projects/${bad}`);
    assert.equal(response.status, 404, `${bad} must not resolve`);
    assert.equal((await response.json()).error.code, 'PROJECT_NOT_FOUND');
  }
});

// ─── the binary data plane ──────────────────────────────────────────────────

test('a multipart upload becomes an asset id and keeps its bytes exactly', async () => {
  const { json, send, application } = setup();
  const projectId = (await json('POST', '/projects', { title: 'Upload' })).body.project.project_id;

  // Bytes that are not valid UTF-8, so a text round trip would corrupt them.
  const bytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0x00, 0xff, 0xfe, 0x80, 0x01]);
  const boundary = '----teststudioboundary';
  const body = multipart(boundary, [
    { name: 'kind', value: 'official_midi' },
    { name: 'file', filename: 'official.mid', contentType: 'audio/midi', bytes },
  ]);

  const response = await send('POST', `/projects/${projectId}/assets`, {
    body,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  assert.equal(response.status, 201);
  const asset = (await response.json()).asset;
  assert.match(asset.asset_id, /^ast_[0-9a-f]{32}$/);
  assert.equal(asset.kind, 'official_midi');
  assert.equal(asset.filename, 'official.mid');
  assert.equal(asset.size, bytes.byteLength);

  const stored = application.readAssetBytes(OWNER, projectId, asset.asset_id);
  assert.deepEqual([...stored.bytes], [...bytes], 'upload bytes must survive the transport unchanged');
});

test('a raw-body upload is the same operation with different framing', async () => {
  const { json, send, application } = setup();
  const projectId = (await json('POST', '/projects', { title: 'Raw' })).body.project.project_id;
  const bytes = new Uint8Array([0x00, 0x01, 0xff, 0xfe]);

  const response = await send('POST', `/projects/${projectId}/assets`, {
    body: bytes,
    headers: { 'content-type': 'application/octet-stream', 'x-mml-asset-kind': 'original_audio', 'x-mml-asset-filename': 'song.m4a' },
  });
  assert.equal(response.status, 201);
  const asset = (await response.json()).asset;
  assert.equal(asset.kind, 'original_audio');
  assert.deepEqual([...application.readAssetBytes(OWNER, projectId, asset.asset_id).bytes], [...bytes]);
});

test('an upload filename is never reflected into a header a browser acts on', async () => {
  const { json, send } = setup();
  const projectId = (await json('POST', '/projects', { title: 'Header' })).body.project.project_id;
  const hostile = 'a"; filename="evil.html';
  const asset = (await (await send('POST', `/projects/${projectId}/assets`, {
    body: new Uint8Array([1, 2, 3]),
    headers: { 'content-type': 'application/octet-stream', 'x-mml-asset-kind': 'report', 'x-mml-asset-filename': hostile },
  })).json()).asset;

  const download = await send('GET', `/projects/${projectId}/assets/${asset.asset_id}/content`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-disposition'), 'attachment');
  assert.ok(!download.headers.get('content-disposition').includes('evil.html'));
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
});

test('an unknown asset kind and an oversized body are refused', async () => {
  const { json, send } = setup();
  const projectId = (await json('POST', '/projects', { title: 'Bounds' })).body.project.project_id;

  const bad = await send('POST', `/projects/${projectId}/assets`, {
    body: new Uint8Array([1]),
    headers: { 'content-type': 'application/octet-stream', 'x-mml-asset-kind': 'not_a_kind' },
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'INVALID_ASSET_KIND');

  const huge = await send('POST', `/projects/${projectId}/assets`, {
    body: new Uint8Array([1]),
    headers: { 'content-type': 'application/octet-stream', 'x-mml-asset-kind': 'original_audio', 'content-length': String(1024 ** 4) },
  });
  assert.equal(huge.status, 413);
});

test('a malformed multipart body is refused rather than partially read', async () => {
  const { json, send } = setup();
  const projectId = (await json('POST', '/projects', { title: 'Malformed' })).body.project.project_id;
  for (const [body, headers] of [
    ['not multipart at all', { 'content-type': 'multipart/form-data; boundary=xyz' }],
    ['--xyz\r\nno headers here', { 'content-type': 'multipart/form-data; boundary=xyz' }],
    ['--xyz--\r\n', { 'content-type': 'multipart/form-data' }],
  ]) {
    const response = await send('POST', `/projects/${projectId}/assets`, { body, headers });
    assert.equal(response.status, 400, `expected refusal for ${JSON.stringify(body).slice(0, 40)}`);
  }
});

// ─── pipeline over HTTP ─────────────────────────────────────────────────────

test('the whole pipeline is reachable over HTTP with the same status separation', async () => {
  const { json, send } = setup();
  const project = sixRoleBaseline();
  const projectId = (await json('POST', '/projects', { title: 'Pipeline' })).body.project.project_id;

  await send('POST', `/projects/${projectId}/assets`, {
    body: canonicalProjectBytes(project),
    headers: { 'content-type': 'application/json', 'x-mml-asset-kind': 'canonical_project', 'x-mml-asset-filename': 'baseline.json' },
  });

  const intake = await json('POST', `/projects/${projectId}/intake`, {});
  assert.equal(intake.response.status, 200);
  assert.match(intake.body.baseline.baseline_id, /^bas:[0-9a-f]{64}$/);
  assert.equal(intake.body.job.status, 'succeeded');

  const suggestion = await json('POST', `/projects/${projectId}/arrangement/suggest`, {});
  assert.equal(suggestion.response.status, 200);
  assert.ok(suggestion.body.suggestion.lane_count > 0);

  const decisions = await json('POST', `/projects/${projectId}/decisions`, { decisions: keepEveryRole(project) });
  assert.equal(decisions.response.status, 200);
  assert.equal(decisions.body.decisions.applied, true);
  const candidateId = decisions.body.decisions.candidate_id;

  const review = await json('POST', `/projects/${projectId}/review`, { candidate_id: candidateId });
  assert.equal(review.response.status, 200);
  assert.equal(review.body.review.integrity.ok, true);

  const blocked = await json('POST', `/projects/${projectId}/finalize`, { candidate_id: candidateId });
  // A blocked gate is a 200 with a blocked operation, not a transport failure:
  // the call worked, the song is not ready, and the two are different facts.
  assert.equal(blocked.response.status, 200);
  assert.equal(blocked.body.operation, 'blocked');
  assert.equal(blocked.body.mml, null);

  const finalized = await json('POST', `/projects/${projectId}/finalize`, {
    candidate_id: candidateId,
    confirmations: {
      source_complete: { value: true, reason: 'Complete.' },
      player_readback: { value: 'PASS', reason: 'Read back.' },
      mobile_adaptation_reviewed: { value: true, reason: 'Gate 8 reviewed.', evidence: ['HTTP fixture Gate 8 review'] },
      regression_reviewed: { value: true, reason: 'Gate 9 reviewed.', evidence: ['HTTP fixture Gate 9 review'] },
      original_audio_required: { value: false, reason: 'No recording.' },
    },
  });
  assert.equal(finalized.body.operation, 'succeeded');
  assert.match(finalized.body.mml, /^MML@.*;$/);
  assert.equal(finalized.body.gates.in_game, 'PENDING');

  const artifact = await json('GET', `/artifacts/${finalized.body.artifact_id}`);
  assert.equal(artifact.response.status, 200);
  assert.equal(artifact.body.artifact.mml, finalized.body.mml);

  const job = await json('GET', `/jobs/${finalized.body.job.job_id}`);
  assert.equal(job.body.job.status, 'succeeded');
  assert.equal(job.body.job.result_artifact_id, finalized.body.artifact_id);
});

test('structured Application errors map to their own status codes', async () => {
  const { json } = setup();
  const missing = await json('GET', '/projects/prj_00000000000000000000000000000000');
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error.code, 'PROJECT_NOT_FOUND');
  // A failure still says which rules snapshot answered it.
  assert.equal(missing.body.canonical.status, 'CANONICAL_LOADED');

  const projectId = (await json('POST', '/projects', { title: 'Errors' })).body.project.project_id;
  const noSource = await json('POST', `/projects/${projectId}/intake`, {});
  assert.equal(noSource.response.status, 422);
  assert.equal(noSource.body.error.code, 'SOURCE_INCOMPLETE');

  const badRepair = await json('POST', `/projects/${projectId}/finalize`, { candidate_id: `g11d:rev:${'0'.repeat(64)}`, technical_timing_repair: 'auto' });
  assert.equal(badRepair.response.status, 400);
  assert.equal(badRepair.body.error.code, 'INVALID_REQUEST');
});

test('Canonical unavailability is a 503 that still names the entry point', async () => {
  const { json } = setup({ application: createStudioApplication({ loadEngines: async () => { throw Error('no published history'); } }) });
  const projectId = (await json('POST', '/projects', { title: 'No canonical' })).body.project.project_id;
  const { response, body } = await json('POST', `/projects/${projectId}/intake`, {});
  assert.equal(response.status, 503);
  assert.equal(body.error.code, 'CANONICAL_NOT_LOADED');
  assert.equal(body.error.details.legacy_fallback_allowed, false);
  assert.equal(body.error.details.entry_point, 'docs/CANONICAL_MANIFEST.md');
});

// ─── legacy technical validation over HTTP ──────────────────────────────────

test('the legacy technical check is reachable over HTTP with the same report', async () => {
  const { json } = setup();
  const { response, body } = await json('POST', '/technical/validate', { mml: 'MML@t120o4c1,,,,,;', meter_text: '0 4/4' });
  assert.equal(response.status, 200);
  assert.equal(body.technical_ok, true);
  assert.equal(body.gates.strict_mobile_technical, 'PASS');
  assert.equal(body.gates.in_game_acceptance, 'PENDING');
  assert.equal(body.pair_count, 15);
});

test('a malformed source selection is a client error, not an internal failure', async () => {
  // The Application Service refuses a non-array `asset_ids`; what this pins is
  // the transport consequence. A 500 would say the service broke, when the
  // request was the thing that was wrong — and it is the one status an
  // operator's monitoring should be able to read as an incident.
  const { json } = setup();
  const project = (await json('POST', '/projects', { title: 'selection' })).body.project;
  for (const selection of ['ast_00000000000000000000000000000000', 7, true, { asset_id: 'x' }]) {
    const { response, body } = await json('POST', `/projects/${project.project_id}/intake`, { asset_ids: selection });
    assert.equal(response.status, 400, `asset_ids ${JSON.stringify(selection)} must be a client error`);
    assert.equal(body.error.code, 'INVALID_REQUEST');
  }
});
