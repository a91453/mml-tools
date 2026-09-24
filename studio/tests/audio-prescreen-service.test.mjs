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
import { createRenderPool } from '../backend/audio/prescreen/render-pool.mjs';
import { createStudioApplication } from '../backend/application/index.mjs';
import { PRESCREEN_LIMITS } from '../backend/application/prescreen-service.mjs';
import { applyKeepOnlyCandidate, audioAlignmentReport } from './fixtures/application-fixtures.mjs';
import { syntheticSoundBank } from './support/synthetic-render-bank.mjs';
import { syntheticSongMml, SYNTHETIC_METER } from './support/prescreen-fixtures.mjs';

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

test('APS-6 Final alternatives share one bar grid: differing declared pickups, or a stated pickup that contradicts one, are refused', async () => {
  const service = createStudioApplication({ audioPrescreen: { bank: BANK, bytes: BANK_BYTES, poolSize: 1 } });
  const confirmations = {
    source_complete: { value: true, reason: 'fixture source complete' },
    player_readback: { value: 'N/A', reason: 'no player readback in this fixture' },
    mobile_adaptation_reviewed: { value: true, reason: 'g8', evidence: ['g8'] },
    regression_reviewed: { value: true, reason: 'g9', evidence: ['g9'] },
    original_audio_required: { value: false, reason: 'no original recording' },
  };
  try {
    const run = await applyKeepOnlyCandidate(service, OWNER);
    const finalize = bar => service.finalize(OWNER, run.projectId, { candidateId: run.candidateId, ...bar });
    // Two bar-aligned Finals (pickup recorded as null), and two whose one-beat
    // pickup is written differently but is the same beat length.
    const aligned = await finalize({ confirmations });
    const alignedAgain = await finalize({});
    const pickedUp = await finalize({ pickup: '1', finalPartial: '3' });
    const pickedUpDecimal = await finalize({ pickup: '1.0', finalPartial: '3' });
    for (const final of [aligned, alignedAgain, pickedUp, pickedUpDecimal]) assert.equal(final.operation, 'succeeded');
    assert.equal(new Set([aligned, alignedAgain, pickedUp, pickedUpDecimal].map(final => final.artifact_id)).size, 4);
    assert.deepEqual([aligned.final_bar.pickup, pickedUp.final_bar.pickup, pickedUpDecimal.final_bar.pickup], [null, '1', '1.0']);
    const byId = final => ({ artifact_id: final.artifact_id });
    const prescreen = async input => (await service.audioPrescreen(OWNER, run.projectId, input)).prescreen;
    const refused = (input, pattern) => assert.rejects(service.audioPrescreen(OWNER, run.projectId, input), error => {
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.match(error.message, pattern);
      return true;
    }, JSON.stringify(input).slice(0, 160));

    // In either order, the first declared pickup is not imposed on the other
    // Final: a bar-aligned Final declares zero beats of pickup.
    for (const [first, second] of [[aligned, pickedUp], [pickedUp, aligned]]) {
      await assert.rejects(prescreen({ alternatives: [byId(first), byId(second)] }), error => {
        assert.equal(error.code, 'INVALID_REQUEST');
        assert.match(error.message, /the alternatives declare different pickups, so their bars would not line up; compare Finals that share one pickup/);
        assert.deepEqual(error.details.declared, [first, second].map((final, index) => ({ label: ['A', 'B'][index], pickup: final === aligned ? '0' : '1' })));
        return true;
      });
    }
    // A stated pickup must agree with every Final that declares one, in
    // either order: agreeing with the first declared pickup is not enough.
    await refused({ alternatives: [byId(pickedUp), byId(pickedUpDecimal)], pickup: '2' }, /pickup differs from the pickup an alternative declares/);
    for (const [first, second] of [[aligned, pickedUp], [pickedUp, aligned]]) {
      for (const pickup of ['1', '0']) await refused({ alternatives: [byId(first), byId(second)], pickup }, /pickup differs from the pickup an alternative declares/);
    }
    await refused({ alternatives: [byId(aligned), { candidate_id: run.candidateId }], pickup: '1' }, /pickup differs from the pickup an alternative declares/);

    // Consistent pickups still work, compared as beat lengths however written.
    const agreed = await prescreen({ alternatives: [byId(pickedUp), byId(pickedUpDecimal)] });
    assert.equal(agreed.inputs.pickup, '1');
    assert.equal(agreed.bars.length, 2, 'a one-beat pickup bar, then the three-beat final partial bar');
    const stated = await prescreen({ alternatives: [byId(pickedUpDecimal), { candidate_id: run.candidateId }], pickup: '1' });
    assert.equal(stated.inputs.pickup, '1');
    assert.equal(stated.bars.length, 2);
    const onBarLines = await prescreen({ alternatives: [byId(aligned), byId(alignedAgain)] });
    assert.equal(onBarLines.inputs.pickup, null);
    assert.equal(onBarLines.bars.length, 1);
  } finally {
    await service.releaseAudioWorkers();
  }
});
// ─── the render-length limit ────────────────────────────────────────────────

// One role of `count` whole notes at T32: under a 4/4 meter each is one 7.5 s
// bar, so the song lasts count × 7.5 s.
const wholeNotes = (count, pitch = 'c') => `MML@t32o4l1${pitch.repeat(count)},,,,,;`;

// A bank and a render pool that record being touched and refuse to work: a
// request refused for its render length must load nothing and dispatch nothing.
const untouched = () => {
  const touched = [];
  return {
    touched,
    audioPrescreen: {
      bankProvider: { descriptor: BANK, load: async () => { touched.push('bank'); throw Error('the sound bank was loaded'); } },
      renderPool: { size: 1, run: async type => { touched.push(type); throw Error(`a ${type} job was dispatched`); }, close: async () => {} },
    },
  };
};

// A real render pool that records every job it is given.
const recordingPool = () => {
  const pool = createRenderPool({ size: 2, idleMs: 2000 });
  const jobs = [];
  return {
    jobs,
    pool: { size: pool.size, close: () => pool.close(), run: (type, payload, options) => { jobs.push({ type, window: payload.window ?? null }); return pool.run(type, payload, options); } },
  };
};

const renderTooLong = expected => error => {
  assert.equal(error.code, 'INVALID_REQUEST', error.message);
  assert.equal(error.details.reason, 'RENDER_TOO_LONG');
  assert.equal(error.details.max_render_seconds, 1200);
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(error.details[key], value, key);
  assert.match(error.message, /at most 1200 s/);
  const { from, to } = expected.suggested_bar_range;
  assert.ok(error.message.includes(`bar_range, for example {"from": ${from}, "to": ${to}}`), error.message);
  return true;
};

test('APS-7 a render longer than the limit is refused before the bank is loaded or any worker dispatched', async () => {
  const { touched, audioPrescreen } = untouched();
  const service = createStudioApplication({ audioPrescreen });
  try {
    // 161 whole notes: 1,207.5 s, inside every other limit.
    await assert.rejects(service.audioPrescreen(OWNER, null, { alternatives: [{ mml: wholeNotes(161) }, { mml: wholeNotes(161, 'd') }], meter_text: '0 4/4' }), renderTooLong({
      render_seconds: { A: 1207.5, B: 1207.5 }, over_limit: ['A', 'B'], bars_total: 161, bar_range: null, suggested_bar_range: { from: 1, to: 160 },
    }));
    // Only the alternative over the limit is named.
    await assert.rejects(service.audioPrescreen(OWNER, null, { alternatives: [{ mml: wholeNotes(20) }, { mml: wholeNotes(161, 'd'), label: 'long' }], meter_text: '0 4/4' }), renderTooLong({
      render_seconds: { A: 150, long: 1207.5 }, over_limit: ['long'], suggested_bar_range: { from: 1, to: 160 },
    }));
    // A 16/4 meter keeps 39,983 whole notes at T32 inside the bar limit, but
    // they last 83 hours: the render length, not the bar count, refuses it.
    const hours = `MML@t32o4l1${'c'.repeat(39983)},,,,,;`;
    assert.ok(hours.length <= PRESCREEN_LIMITS.maxMmlCharacters);
    await assert.rejects(service.audioPrescreen(OWNER, null, { alternatives: [{ mml: hours }, { mml: hours.replace('t32', 't33') }], meter_text: '0 16/4', render: { sample_rate: 44100, channels: 2 } }), renderTooLong({
      over_limit: ['A', 'B'], bars_total: 9996, suggested_bar_range: { from: 1, to: 40 },
    }));
    // The suggestion fits every alternative, not only the first: with the
    // slower T32 alternative second, {1, 41} would still be 1,230 s long.
    await assert.rejects(service.audioPrescreen(OWNER, null, { alternatives: [{ mml: hours.replace('t32', 't33') }, { mml: hours }], meter_text: '0 16/4', render: { sample_rate: 44100, channels: 2 } }), renderTooLong({
      over_limit: ['A', 'B'], bars_total: 9996, suggested_bar_range: { from: 1, to: 40 },
    }));
    // A first bar longer than the limit on its own (255/1 at T32 is
    // 1,912.5 s): the refusal names the first later section that fits, or
    // says that none does, instead of advising a range that cannot work.
    const firstBarTooLong = (expected, pattern) => error => {
      assert.equal(error.code, 'INVALID_REQUEST', error.message);
      assert.equal(error.details.reason, 'RENDER_TOO_LONG');
      assert.equal(error.details.suggested_bar_range, null);
      assert.deepEqual(error.details.later_bar_range, expected);
      assert.match(error.message, pattern);
      return true;
    };
    const oneLongBar = `MML@t32o4l1${'c'.repeat(259)},,,,,;`;
    await assert.rejects(service.audioPrescreen(OWNER, null, { alternatives: [{ mml: oneLongBar }, { mml: oneLongBar.replace('o4', 'o5') }], meter_text: '0 255/1\n1020 4/4' }),
      firstBarTooLong({ from: 2, to: 5 }, /Even bar 1 alone is longer than that; the first section after it that fits is bar_range \{"from": 2, "to": 5\}/));
    const onlyLongBars = `MML@t32o4l1${'c'.repeat(510)},,,,,;`;
    await assert.rejects(service.audioPrescreen(OWNER, null, { alternatives: [{ mml: onlyLongBars }, { mml: onlyLongBars.replace('o4', 'o5') }], meter_text: '0 255/1' }),
      firstBarTooLong(null, /and so is every bar after it, so no section from bar 1 on can be prescreened/));
    assert.deepEqual(touched, [], 'nothing was loaded or dispatched');
    // Exactly at the limit is admitted: it goes on to load the bank.
    await assert.rejects(service.audioPrescreen(OWNER, null, { alternatives: [{ mml: wholeNotes(160) }, { mml: wholeNotes(160, 'd') }], meter_text: '0 4/4' }), /the sound bank was loaded/);
    assert.deepEqual(touched, ['bank']);
    assert.equal(PRESCREEN_LIMITS.maxRenderSeconds, 1200, 'twenty minutes of audio per alternative');
  } finally {
    await service.releaseAudioWorkers();
  }
});

test('APS-8 a bar_range over a long song is judged by its window, and a real-length song renders whole', async () => {
  const { jobs, pool } = recordingPool();
  const service = createStudioApplication({ audioPrescreen: { bank: BANK, bytes: BANK_BYTES, renderPool: pool } });
  try {
    // A 3,000 s song. A window over the limit is refused, before any job,
    // with the longest range from its first bar that fits: bars 10-168 run
    // from 64.5 s (the pre-roll before bar 10) to 1,260 s.
    const long = [{ mml: wholeNotes(400) }, { mml: wholeNotes(400, 'd') }];
    await assert.rejects(service.audioPrescreen(OWNER, null, { alternatives: long, meter_text: '0 4/4', bar_range: { from: 10, to: 250 } }), renderTooLong({
      render_seconds: { A: 1810.5, B: 1810.5 }, bar_range: { from: 10, to: 250 }, bars_total: 400, suggested_bar_range: { from: 10, to: 168 },
    }));
    assert.deepEqual(jobs, []);

    // Three of its bars render, and only their window.
    const section = (await service.audioPrescreen(OWNER, null, { alternatives: long, meter_text: '0 4/4', bar_range: { from: 150, to: 152 } })).prescreen;
    assert.deepEqual(section.bars.map(bar => bar.bar), [150, 151, 152]);
    assert.equal(section.inputs.bars_total, 400);
    assert.deepEqual(jobs.filter(job => job.type === 'analyze').map(job => job.window), [{ startSec: 1114.5, endSec: 1140 }, { startSec: 1114.5, endSec: 1140 }]);
    assert.equal(section.alternatives[0].render.start_seconds, 1114.5);

    // 160 bars at T120: 320 s, longer than any real song this repository has
    // carried (311 s) and well inside the limit. It renders whole.
    jobs.length = 0;
    const base = syntheticSongMml({ bars: 160 });
    const song = (await service.audioPrescreen(OWNER, null, { alternatives: [{ mml: base }, { mml: syntheticSongMml({ bars: 160, variant: 'crunch' }) }], meter_text: SYNTHETIC_METER, reference: { mml: base } })).prescreen;
    assert.equal(song.summary.bars, 160);
    assert.deepEqual(song.alternatives.map(entry => entry.duration_seconds), [320, 320]);
    assert.deepEqual(jobs.filter(job => job.type === 'analyze').map(job => job.window), [null, null], 'both alternatives rendered whole');
  } finally {
    await service.releaseAudioWorkers();
    await pool.close();
  }
});
