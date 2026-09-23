// The audio prescreen through the Application Service: project candidates
// against the Source-Faithful Baseline, the original recording, refusals, the
// sound-bank refusal codes and shadow-mode calibration.
//
// Renders with the synthetic in-memory bank (support/synthetic-render-bank.mjs);
// no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { REASON, VERDICT } from '../backend/audio/prescreen/decision.mjs';
import { encodeWav16 } from '../backend/audio/prescreen/wav.mjs';
import { createStudioApplication } from '../backend/application/index.mjs';
import { applyKeepOnlyCandidate, audioAlignmentReport } from './fixtures/application-fixtures.mjs';
import { syntheticSoundBank } from './support/synthetic-render-bank.mjs';

const OWNER = 'owner:prescreen';
const { bytes: BANK_BYTES, descriptor: BANK } = syntheticSoundBank();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const SIX = id => Array(6).fill(id);

const chordWav = () => {
  const rate = 22050;
  const samples = new Float32Array(rate * 2);
  for (const pitch of [72, 67, 64, 60, 55, 48]) {
    const hz = 440 * 2 ** ((pitch - 69) / 12);
    for (let i = 0; i < samples.length; i++) samples[i] += 0.1 * Math.sin((2 * Math.PI * hz * i) / rate) * Math.exp(-i / rate);
  }
  return encodeWav16(samples, rate);
};

test('APS-1 in a project: candidates against the Source-Faithful Baseline, the original recording when aligned, nothing written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prescreen-'));
  const service = createStudioApplication({ dataDirectory: dir, audioPrescreen: { bank: BANK, bytes: BANK_BYTES, poolSize: 2 } });
  try {
    const run = await applyKeepOnlyCandidate(service, OWNER);
    const sameAsBaseline = 'MML@t120o5c4c4c2,t120o4g4g4g2,t120o4e4e4e2,t120o4c4c4c2,t120o3g4g4g2,t120o3c4c4c2;';
    const rough = 'MML@t120o5c4c4c2,t120o4g4g4g2,t120o4e4e4e2,t120o4c4c4c2,t120o3g4g4g2,t120o3c+4c+4c+2;';
    const before = (await service.getProject(OWNER, run.projectId)).project;

    // The candidate and an MML equal to it: nothing to decide.
    const same = (await service.audioPrescreen(OWNER, run.projectId, { alternatives: [{ candidate_id: run.candidateId }, { mml: sameAsBaseline }], meter_text: '0 4/4' })).prescreen;
    assert.equal(same.reference.kind, 'source_faithful_baseline');
    assert.equal(same.bars[0].verdict, VERDICT.NO_DIFFERENCE);
    assert.equal(same.alternatives[0].mml_sha256, null, 'a candidate has no MML yet; its performance digest names it');
    assert.equal(same.alternatives[0].performance_sha256, same.alternatives[1].performance_sha256);
    assert.equal(same.original_audio.status, 'NOT_APPLICABLE');

    // A recording aligned to the candidate is compared when it is WAVE PCM.
    const wav = chordWav();
    await service.uploadAsset(OWNER, run.projectId, { kind: 'original_audio', filename: 'take.wav', mediaType: 'audio/wav', bytes: wav });
    await service.attachAudioAlignment(OWNER, run.projectId, { candidateId: run.candidateId, report: audioAlignmentReport({ id: `${run.project.id}#g11d-r1` }, { sha256: sha256(wav) }) });
    const compared = (await service.audioPrescreen(OWNER, run.projectId, { alternatives: [{ candidate_id: run.candidateId }, { mml: rough }], meter_text: '0 4/4' })).prescreen;
    assert.equal(compared.original_audio.status, 'USED');
    assert.equal(compared.original_audio.bars_covered, 1);
    assert.equal(typeof compared.bars[0].metrics.original_similarity.A, 'number');
    assert.ok(compared.bars[0].metrics.original_similarity.A < compared.bars[0].metrics.original_similarity.B, 'the faithful candidate is closer to the recording');
    assert.equal(compared.bars[0].verdict, VERDICT.OBVIOUS);
    assert.equal(compared.bars[0].winner, 'A');

    // The prescreen never moves a gate: Gate 7 stays where review left it.
    const review = (await service.reviewCandidate(OWNER, run.projectId, { candidateId: run.candidateId })).review;
    assert.equal(review.gates.audio, 'PENDING');
    assert.equal(review.gates.in_game, 'PENDING');
    assert.notEqual(review.gates.player_readback, 'PASS');
    // Nothing was written: the project lists the same candidates and artifacts.
    const after = (await service.getProject(OWNER, run.projectId)).project;
    assert.deepEqual(after.candidates, before.candidates);
    assert.deepEqual(after.artifacts, before.artifacts);
  } finally {
    await service.releaseAudioWorkers();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('APS-2 a compressed recording makes original-audio similarity unavailable, and differing bars go to the owner', async () => {
  const service = createStudioApplication({ audioPrescreen: { bank: BANK, bytes: BANK_BYTES, poolSize: 1 } });
  try {
    const run = await applyKeepOnlyCandidate(service, OWNER);
    const mp3 = new TextEncoder().encode(`ID3${'\u0000'.repeat(64)}not really audio`);
    await service.uploadAsset(OWNER, run.projectId, { kind: 'original_audio', filename: 'take.mp3', mediaType: 'audio/mpeg', bytes: mp3 });
    await service.attachAudioAlignment(OWNER, run.projectId, { candidateId: run.candidateId, report: audioAlignmentReport({ id: `${run.project.id}#g11d-r1` }, { sha256: sha256(mp3) }) });
    const rough = 'MML@t120o5c4c4c2,t120o4g4g4g2,t120o4e4e4e2,t120o4c4c4c2,t120o3g4g4g2,t120o3c+4c+4c+2;';
    const report = (await service.audioPrescreen(OWNER, run.projectId, { alternatives: [{ candidate_id: run.candidateId }, { mml: rough }], meter_text: '0 4/4' })).prescreen;
    assert.equal(report.original_audio.status, 'ORIGINAL_AUDIO_METRIC_UNAVAILABLE');
    assert.equal(report.original_audio.reason, 'UNSUPPORTED_AUDIO_ENCODING');
    assert.equal(report.bars[0].verdict, VERDICT.NEEDS_HUMAN);
    assert.ok(report.bars[0].reasons.includes(REASON.METRIC_UNAVAILABLE));
    assert.deepEqual(report.bars[0].metrics.original_similarity, { unavailable: 'UNSUPPORTED_AUDIO_ENCODING' });
  } finally {
    await service.releaseAudioWorkers();
  }
});

test('APS-3 a bank that cannot be verified refuses the prescreen with its code', async () => {
  const service = createStudioApplication({ audioPrescreen: { bank: { ...BANK, sha256: '0'.repeat(64) }, bytes: BANK_BYTES } });
  try {
    await assert.rejects(service.audioPrescreen(OWNER, null, { alternatives: [{ mml: 'MML@t120o4c1,,,,,;' }, { mml: 'MML@t120o4d1,,,,,;' }], meter_text: '0 4/4' }),
      error => error.code === 'AUDIO_BANK_HASH_MISMATCH' && error.details.reason === 'SHA256_MISMATCH');
    const offline = createStudioApplication({ audioPrescreen: { allowDownload: false, cacheDirectory: join(tmpdir(), `no-bank-${process.pid}`) } });
    await assert.rejects(offline.audioPrescreen(OWNER, null, { alternatives: [{ mml: 'MML@t120o4c1,,,,,;' }, { mml: 'MML@t120o4d1,,,,,;' }], meter_text: '0 4/4' }),
      error => error.code === 'AUDIO_BANK_UNAVAILABLE' && error.details.reason === 'DOWNLOAD_DISABLED');
  } finally {
    await service.releaseAudioWorkers();
  }
});

test('APS-4 malformed prescreen requests are refused before anything renders', async () => {
  const service = createStudioApplication({ audioPrescreen: { bank: BANK, bytes: BANK_BYTES } });
  const refused = async (projectId, input, pattern) => {
    await assert.rejects(service.audioPrescreen(OWNER, projectId, input), error => error.code === 'INVALID_REQUEST' && pattern.test(error.message), JSON.stringify(input).slice(0, 120));
  };
  const two = [{ mml: 'MML@t120o4c1,,,,,;' }, { mml: 'MML@t120o4d1,,,,,;' }];
  await refused(null, { alternatives: [two[0]], meter_text: '0 4/4' }, /two to four/);
  await refused(null, { alternatives: two }, /meter_text is required/);
  await refused(null, { alternatives: two, meter_text: '0 4/4', instruments: SIX('kazoo') }, /six instruments/);
  await refused(null, { alternatives: [{ candidate_id: `g11d:rev:${'a'.repeat(64)}` }, two[1]], meter_text: '0 4/4' }, /needs a project_id/);
  await refused(null, { alternatives: [{ mml: 'MML@t120o4c1,,,,,;', artifact_id: 'x' }, two[1]], meter_text: '0 4/4' }, /exactly one/);
  await refused(null, { alternatives: [{ mml: 'MML@t120o4c1,,,,,;', label: 'A' }, { mml: 'MML@t120o4d1,,,,,;', label: 'A' }], meter_text: '0 4/4' }, /unique/);
  await refused(null, { alternatives: two, meter_text: '0 4/4', extra: true }, /unknown field/);
  await refused(null, { alternatives: two, meter_text: '0 4/4', thresholds: { roughness: { margin_abs: -1 } } }, /non-negative/);
  await refused(null, { alternatives: [{ mml: 'MML@t120o4c1q,,,,,;' }, two[1]], meter_text: '0 4/4' }, /does not parse/);
  await refused(null, { alternatives: two, meter_text: '0 4/4', bar_range: { from: 5 } }, /bar_range/);
  await refused(null, { alternatives: two, meter_text: '0 4/4', render: { sample_rate: 8000 } }, /sample_rate/);
});

test('APS-5 shadow mode records predictions and the owner\'s choices, and reports agreement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-'));
  const service = createStudioApplication({ dataDirectory: dir, audioPrescreen: { bank: BANK, bytes: BANK_BYTES, poolSize: 2 } });
  try {
    const run = await applyKeepOnlyCandidate(service, OWNER);
    const rough = 'MML@t120o5c4c4c2,t120o4g4g4g2,t120o4e4e4e2,t120o4c4c4c2,t120o3g4g4g2,t120o3c+4c+4c+2;';
    const request = { alternatives: [{ candidate_id: run.candidateId }, { mml: rough }], meter_text: '0 4/4' };
    const empty = (await service.prescreenShadowStatus(OWNER, run.projectId)).shadow;
    assert.deepEqual([empty.predictions.length, empty.choices.length], [0, 0]);

    const recorded = (await service.recordPrescreenShadow(OWNER, run.projectId, { entry: 'prediction', ...request })).shadow;
    assert.equal(recorded.recorded, true);
    assert.match(recorded.prediction.prediction_id, /^psp_[0-9a-f]{32}$/);
    assert.equal(recorded.prediction.report_id, recorded.report.report_id);
    const [region] = recorded.prediction.regions;
    assert.equal(region.verdict, VERDICT.OBVIOUS);
    assert.equal(region.metric_winners.roughness, 'A');
    const again = (await service.recordPrescreenShadow(OWNER, run.projectId, { entry: 'prediction', ...request })).shadow;
    assert.equal(again.recorded, false, 'the same report is recorded once');

    const choice = { entry: 'owner_choice', prediction_id: recorded.prediction.prediction_id, region_id: region.region_id, chosen: 'A' };
    await assert.rejects(service.recordPrescreenShadow(OWNER, run.projectId, choice), /accepted_by/);
    await assert.rejects(service.recordPrescreenShadow(OWNER, run.projectId, { ...choice, accepted_by: 'owner', chosen: 'Z' }), /chosen must be one of/);
    await assert.rejects(service.recordPrescreenShadow(OWNER, run.projectId, { ...choice, accepted_by: 'owner', region_id: 'bars-9-9' }), /Unknown region_id/);
    const agreed = (await service.recordPrescreenShadow(OWNER, run.projectId, { ...choice, accepted_by: 'owner', reason: 'Listened; the clean bass is right.' })).shadow;
    assert.equal(agreed.agreement.obvious.agreement_rate, 1);
    assert.deepEqual(agreed.agreement.per_category.roughness, { choices: 1, agreed: 1, agreement_rate: 1 });
    // A later choice for the same region supersedes, and both are kept.
    const changed = (await service.recordPrescreenShadow(OWNER, run.projectId, { ...choice, chosen: 'B', accepted_by: 'owner' })).shadow;
    assert.equal(changed.choice.supersedes_choice_id, agreed.choice.choice_id);
    assert.equal(changed.agreement.obvious.agreement_rate, 0);
    assert.equal(changed.agreement.per_metric.roughness.choices, 1);

    // Persistent in the service data directory, read back by a new process.
    const reopened = createStudioApplication({ dataDirectory: dir, audioPrescreen: { bank: BANK, bytes: BANK_BYTES } });
    const status = (await reopened.prescreenShadowStatus(OWNER, run.projectId)).shadow;
    assert.equal(status.predictions.length, 1);
    assert.equal(status.choices.length, 2);
    assert.deepEqual(status.agreement.draft_publication_bar.categories_meeting_bar, []);
    assert.equal(status.agreement.draft_publication_bar.min_sample, 30);
    // Another owner cannot read or write it.
    await assert.rejects(reopened.prescreenShadowStatus('owner:other', run.projectId), error => ['PROJECT_NOT_FOUND', 'FORBIDDEN'].includes(error.code));
    // Recording never touched the project's candidates, gates or confirmations.
    const review = (await service.reviewCandidate(OWNER, run.projectId, { candidateId: run.candidateId })).review;
    assert.equal(review.gates.in_game, 'PENDING');
  } finally {
    await service.releaseAudioWorkers();
    rmSync(dir, { recursive: true, force: true });
  }
});
