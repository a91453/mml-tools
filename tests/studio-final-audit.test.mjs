import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { projectWithSymbolicAsset, runDecisionsFor, FIXTURE_CONFIRMATIONS } from '../studio/tests/fixtures/run-fixtures.mjs';
import { auditStoredRun } from '../scripts/studio-final-audit.mjs';
import { LOCAL_AGENT_OWNER as owner } from '../scripts/studio-agent.mjs';

async function fixtureFor(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mml-final-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const dataDirectory = join(directory, 'song');
  const app = createStudioApplication({ dataDirectory: join(dataDirectory, 'store'), durability: 'persistent' });
  const fixture = await projectWithSymbolicAsset(app, owner);
  const started = await app.startRun(owner, fixture.projectId, { asset_ids: [fixture.assetId], decisions: runDecisionsFor(fixture.project), accepted_by: 'fixture-reviewer' });
  return { directory, dataDirectory, app, projectId: fixture.projectId, runId: started.run.run_id };
}

test('Final audit reports real blockers, creates no MML, and preserves source project/run bytes', async t => {
  const f = await fixtureFor(t), outputDirectory = join(f.directory, 'audit');
  const recordDirectory = join(f.dataDirectory, 'store', 'records');
  const records = await Promise.all((await readdir(recordDirectory)).map(async name => [name, await readFile(join(recordDirectory, name))]));
  const report = await auditStoredRun({ ...f, outputDirectory });
  assert.equal(report.status, 'FINAL_NOT_VERIFIED');
  assert.equal(report.finalization_code, 'FINALIZATION_BLOCKED');
  assert.equal(report.gates.mobile_adaptation, 'PENDING');
  assert.equal(report.final_artifact_id, null);
  assert.equal(report.mml_written, false);
  assert.equal(report.source_store_unchanged, true);
  await assert.rejects(stat(join(outputDirectory, 'candidate-final.mml')), { code: 'ENOENT' });
  for (const [name, bytes] of records) assert.deepEqual(await readFile(join(recordDirectory, name)), bytes);
  const reviewed = JSON.parse(await readFile(join(outputDirectory, 'review.json')));
  assert.deepEqual(reviewed.review.confirmations, {});
  await assert.rejects(auditStoredRun({ ...f, outputDirectory }), { code: 'EEXIST' });
  await assert.rejects(stat(join(f.dataDirectory, '.agent.lock')), { code: 'ENOENT' });
});

test('Final audit independently checks delivered MML using only previously recorded fixture reviews', async t => {
  const f = await fixtureFor(t), outputDirectory = join(f.directory, 'audit');
  const finished = await f.app.resumeRun(owner, f.projectId, f.runId, { confirmations: FIXTURE_CONFIRMATIONS });
  assert.equal(finished.run.state, 'completed');
  const report = await auditStoredRun({ ...f, outputDirectory });
  assert.equal(report.status, 'FINAL_ARTIFACT_VERIFIED');
  assert.equal(report.source_store_unchanged, true);
  assert.equal(report.gates.in_game, 'PENDING');
  const artifact = JSON.parse(await readFile(join(outputDirectory, 'artifact.json')));
  assert.equal(await readFile(join(outputDirectory, 'candidate-final.mml'), 'utf8'), artifact.mml);
  assert.equal(artifact.candidate_id, finished.run.candidate_id);
  assert.equal(artifact.round_trip.status, 'PASS');
});

test('Final audit refuses source-directory overlap and an active agent lock', async t => {
  const f = await fixtureFor(t);
  await assert.rejects(auditStoredRun({ ...f, outputDirectory: join(f.dataDirectory, 'audit') }), /separate/);
  await assert.rejects(auditStoredRun({ ...f, outputDirectory: join(f.dataDirectory, '..audit') }), /separate/);
  const lock = join(f.dataDirectory, '.agent.lock');
  await writeFile(lock, 'existing agent lock');
  await assert.rejects(auditStoredRun({ ...f, outputDirectory: join(f.directory, 'audit') }), { code: 'EEXIST' });
  assert.equal(await readFile(lock, 'utf8'), 'existing agent lock');
});
