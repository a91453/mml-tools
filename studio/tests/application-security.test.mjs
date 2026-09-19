// Studio Agent Interface — security boundary regressions.
//
// The transport-level checks (authentication, status mapping, multipart
// framing, header reflection) live in `tests/api.test.mjs`. This file covers
// the properties that have to hold in the Application Service itself, whichever
// transport is in front of it — including the ones that are only observable on
// disk.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ERROR_CODES, LIMITS, createStudioApplication } from '../backend/application/index.mjs';
import { canonicalProjectBytes, keepEveryRole, sixRoleBaseline } from './fixtures/application-fixtures.mjs';

const ALICE = 'owner:alice';
const BOB = 'owner:bob';
const bytesOf = text => new TextEncoder().encode(text);

async function rejects(promise, code) {
  try {
    await promise;
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.equal(error.code, code, error.message);
    return error;
  }
}

// Strings that are a path, a URL or a device name rather than an identity.
// Every one must be refused by shape, and none may ever be resolved.
const HOSTILE = Object.freeze([
  '/etc/passwd',
  '../../foo',
  '../../../../../../etc/shadow',
  'C:\\windows\\system32\\config\\sam',
  '\\\\server\\share\\secret',
  'file:///etc/passwd',
  'https://example.com/evil',
  'prj_../../etc/passwd',
  './relative',
  '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
  '\u0000',
  'con',
]);

test('no identity parameter can be a path, a URL or a device name', async () => {
  const service = createStudioApplication({});
  const project = (await service.createProject(ALICE, { title: 'Hostile' })).project;

  for (const hostile of HOSTILE) {
    await rejects(service.getProject(ALICE, hostile), ERROR_CODES.PROJECT_NOT_FOUND);
    await rejects(service.getAsset(ALICE, project.project_id, hostile), ERROR_CODES.ASSET_NOT_FOUND);
    await rejects(service.getJob(ALICE, hostile), ERROR_CODES.JOB_NOT_FOUND);
    await rejects(service.getArtifact(ALICE, hostile), ERROR_CODES.ARTIFACT_NOT_FOUND);
    await rejects(service.reviewCandidate(ALICE, project.project_id, { candidateId: hostile }), ERROR_CODES.CANDIDATE_NOT_FOUND);
  }
});

test('there is no operation that accepts a source path at all', async () => {
  // The closest thing to a path a caller can supply is an upload filename, and
  // it selects nothing: the adapter is chosen by the asset kind. A file named
  // like a MIDI but declared as MML reaches the MML adapter and is refused
  // there, never opened as a path.
  const service = createStudioApplication({});
  const project = (await service.createProject(ALICE, { title: 'No paths' })).project;
  const asset = (await service.uploadAsset(ALICE, project.project_id, {
    kind: 'current_mml', filename: '/etc/passwd', mediaType: 'text/plain', bytes: bytesOf('root:x:0:0:'),
  })).asset;

  assert.equal(asset.filename, '/etc/passwd', 'the name is kept as inert metadata');
  await rejects(service.analyzeSources(ALICE, project.project_id, { assetIds: [asset.asset_id] }), ERROR_CODES.UNSUPPORTED_SOURCE);
});

test('an upload filename never appears on disk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-sec-'));
  try {
    const service = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const project = (await service.createProject(ALICE, { title: 'On disk' })).project;
    await service.uploadAsset(ALICE, project.project_id, {
      kind: 'current_mml', filename: '../../../../escaped.mml', mediaType: 'text/plain', bytes: bytesOf('MML@t120o4c1,,,,,;'),
    });

    // Nothing escaped the store directory, and every stored name is generated.
    assert.deepEqual((await readdir(directory)).sort(), ['blobs', 'records']);
    for (const name of await readdir(join(directory, 'blobs'))) assert.match(name, /^[0-9a-f]{64}\.bin$/);
    for (const name of await readdir(join(directory, 'records'))) assert.match(name, /^[0-9a-f]{32}\.json$/);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('an asset id does not expose another owner\u2019s project', async () => {
  const service = createStudioApplication({});
  const alice = (await service.createProject(ALICE, { title: 'Alice' })).project;
  const bob = (await service.createProject(BOB, { title: 'Bob' })).project;
  const asset = (await service.uploadAsset(ALICE, alice.project_id, {
    kind: 'current_mml', filename: 'a.mml', mediaType: 'text/plain', bytes: bytesOf('MML@t120o4c1,,,,,;'),
  })).asset;

  // Bob holding Alice's exact asset id learns nothing: not through his own
  // project, and not by naming hers.
  await rejects(service.getAsset(BOB, bob.project_id, asset.asset_id), ERROR_CODES.ASSET_NOT_FOUND);
  await rejects(service.getAsset(BOB, alice.project_id, asset.asset_id), ERROR_CODES.PROJECT_NOT_FOUND);
  assert.throws(() => service.readAssetBytes(BOB, alice.project_id, asset.asset_id), error => error.code === ERROR_CODES.PROJECT_NOT_FOUND);
});

test('a candidate, job and artifact are all scoped to their owner', async () => {
  const service = createStudioApplication({});
  const project = sixRoleBaseline();
  const created = (await service.createProject(ALICE, { title: 'Scoped' })).project;
  await service.uploadAsset(ALICE, created.project_id, {
    kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: canonicalProjectBytes(project),
  });
  const intake = await service.analyzeSources(ALICE, created.project_id);
  const applied = await service.applyDecisions(ALICE, created.project_id, { decisions: keepEveryRole(project) });
  const finalized = await service.finalize(ALICE, created.project_id, {
    candidateId: applied.decisions.candidate_id,
    confirmations: {
      source_complete: { value: true, reason: 'Complete.' },
      player_readback: { value: 'PASS', reason: 'Read back.' },
      mobile_adaptation_reviewed: { value: true, reason: 'Gate 8 reviewed.', evidence: ['security fixture Gate 8 review'] },
      regression_reviewed: { value: true, reason: 'Gate 9 reviewed.', evidence: ['security fixture Gate 9 review'] },
      original_audio_required: { value: false, reason: 'No recording.' },
    },
  });
  assert.equal(finalized.operation, 'succeeded');

  await rejects(service.getJob(BOB, intake.job.job_id), ERROR_CODES.JOB_NOT_FOUND);
  await rejects(service.getArtifact(BOB, finalized.artifact_id), ERROR_CODES.ARTIFACT_NOT_FOUND);
  await rejects(service.reviewCandidate(BOB, created.project_id, { candidateId: applied.decisions.candidate_id }), ERROR_CODES.PROJECT_NOT_FOUND);

  // Alice still has all three, so the refusals above are isolation and not an
  // outage.
  assert.equal((await service.getJob(ALICE, intake.job.job_id)).job.job_id, intake.job.job_id);
  assert.equal((await service.getArtifact(ALICE, finalized.artifact_id)).artifact.artifact_id, finalized.artifact_id);
});

test('a project record cannot be written through a caller-supplied field', async () => {
  const service = createStudioApplication({});
  // `createProject` reads only `title`; an owner, id or asset list supplied by a
  // caller must not be honoured.
  const created = (await service.createProject(ALICE, {
    title: 'Injected',
    owner: BOB,
    project_id: 'prj_' + 'f'.repeat(32),
    assets: [{ asset_id: 'ast_' + '0'.repeat(32) }],
    artifacts: [{ artifact_id: 'art_' + '0'.repeat(64) }],
  })).project;

  assert.notEqual(created.project_id, 'prj_' + 'f'.repeat(32));
  assert.deepEqual(created.assets, []);
  assert.deepEqual(created.artifacts, []);
  await rejects(service.getProject(BOB, created.project_id), ERROR_CODES.PROJECT_NOT_FOUND);
});

test('input is bounded so one request cannot exhaust the process', async () => {
  const service = createStudioApplication({});
  const project = (await service.createProject(ALICE, { title: 'Bounds' })).project;

  await rejects(service.uploadAsset(ALICE, project.project_id, {
    kind: 'original_audio', filename: 'big', mediaType: 'audio/mp4', bytes: new Uint8Array(LIMITS.maxAssetBytes + 1),
  }), ERROR_CODES.PAYLOAD_TOO_LARGE);

  await rejects(service.createProject(ALICE, { title: 'x'.repeat(LIMITS.maxTitleLength + 1) }), ERROR_CODES.INVALID_REQUEST);

  await rejects(service.uploadAsset(ALICE, project.project_id, {
    kind: 'current_mml', filename: 'x'.repeat(LIMITS.maxFilenameLength + 1), mediaType: 'text/plain', bytes: bytesOf('MML@;'),
  }), ERROR_CODES.INVALID_REQUEST);

  await rejects(service.applyDecisions(ALICE, project.project_id, {
    decisions: Array.from({ length: LIMITS.maxDecisionsPerRequest + 1 }, (_, index) => ({ id: `d${index}`, type: 'KEEP' })),
  }), ERROR_CODES.INVALID_REQUEST);
});

test('a per-project asset ceiling holds', async () => {
  const service = createStudioApplication({});
  const project = (await service.createProject(ALICE, { title: 'Ceiling' })).project;
  for (let index = 0; index < LIMITS.maxAssetsPerProject; index += 1) {
    await service.uploadAsset(ALICE, project.project_id, {
      kind: 'report', filename: `r${index}.json`, mediaType: 'application/json', bytes: bytesOf(`{"n":${index}}`),
    });
  }
  await rejects(service.uploadAsset(ALICE, project.project_id, {
    kind: 'report', filename: 'one-too-many.json', mediaType: 'application/json', bytes: bytesOf('{}'),
  }), ERROR_CODES.STORAGE_FULL);
});

test('stored asset bytes are refused if they no longer match their recorded identity', async () => {
  // Defence in depth against a corrupted or swapped blob: an intake that
  // silently consumed different bytes than the ones its report names would make
  // every downstream provenance claim false.
  const directory = await mkdtemp(join(tmpdir(), 'studio-sec-'));
  try {
    const service = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const project = (await service.createProject(ALICE, { title: 'Swapped' })).project;
    const asset = (await service.uploadAsset(ALICE, project.project_id, {
      kind: 'current_mml', filename: 'a.mml', mediaType: 'text/plain', bytes: bytesOf('MML@t120o4c1,,,,,;'),
    })).asset;

    const { writeFileSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const blobName = createHash('sha256').update(`asset:${project.project_id}:${asset.asset_id}`).digest('hex');
    writeFileSync(join(directory, 'blobs', `${blobName}.bin`), 'MML@t120o4d1,,,,,;');

    assert.throws(() => service.readAssetBytes(ALICE, project.project_id, asset.asset_id), error => error.code === ERROR_CODES.ASSET_NOT_FOUND);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('no module in the interface imports a model provider SDK', async () => {
  // A structural check, not a stylistic one: this service must never acquire a
  // model dependency, and a stray import is the way that happens.
  const { readdirSync, readFileSync } = await import('node:fs');
  const root = new URL('../backend/application/', import.meta.url);
  const forbidden = /(from|require\()\s*['"](openai|@anthropic-ai\/|@google\/gener|anthropic|gemini|cohere|mistralai|ollama|langchain)/i;
  for (const name of readdirSync(root)) {
    const source = readFileSync(new URL(name, root), 'utf8');
    assert.doesNotMatch(source, forbidden, `${name} imports a model provider SDK`);
    assert.doesNotMatch(source, /process\.env\.(OPENAI|ANTHROPIC|GOOGLE|GEMINI)_API_KEY/, `${name} reads a model provider credential`);
  }
});

test('a source selection that is not a list of asset ids is refused as a bad request', async () => {
  // `asset_ids` reaches a per-entry lookup. Anything that is not an array used
  // to reach it unchecked and raise a TypeError, which a transport can only
  // render as an internal failure — telling a caller the server broke when the
  // request was malformed. The refusal belongs to the Application Service so
  // every transport and every direct caller inherits it, and it happens before
  // the Canonical engines are loaded.
  const service = createStudioApplication({});
  const project = (await service.createProject(ALICE, { title: 'selection' })).project;

  for (const selection of ['ast_' + 'a'.repeat(32), 7, true, { asset_id: 'x' }]) {
    const error = await rejects(
      service.analyzeSources(ALICE, project.project_id, { assetIds: selection }),
      ERROR_CODES.INVALID_REQUEST,
    );
    assert.match(error.message, /asset_ids must be an array/);
  }

  // A project cannot hold more assets than the per-project ceiling, so a longer
  // selection can never resolve and is refused before it drives a lookup each.
  await rejects(
    service.analyzeSources(ALICE, project.project_id, { assetIds: new Array(LIMITS.maxAssetsPerProject + 1).fill('ast_' + 'a'.repeat(32)) }),
    ERROR_CODES.INVALID_REQUEST,
  );

  // An array is still refused on its contents, not on its shape alone.
  await rejects(
    service.analyzeSources(ALICE, project.project_id, { assetIds: ['/etc/passwd'] }),
    ERROR_CODES.ASSET_NOT_FOUND,
  );
});
