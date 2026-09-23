import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMML } from '../backend/mml/parser.mjs';
import { READBACK_KIND, READBACK_SCOPE, TIMING_TOLERANCE_SEC, compareReadback, expectedEvents, normalizeCapture } from '../web/preview/readback.mjs';
import { analyzeWorkspace, applyFinalDelivery, clearPlayerReadback, importWorkspace, intake, invalidate, newWorkspace, recordPlayerReadback, recordReview, REVIEW_NAMES, generateFinalDelivery } from '../web/model.mjs';

const mml = 'MML@t120o4c1,t120o3e1,t120o2c1,,,;';
const song = text => { const result = validateMML(text, { meterText: '0 4/4' }); assert.equal(result.ok, true); return result.song; };

// What a faithful engine reports for `text`: every expected event, in order,
// processed a little after its time (render quanta), with the program loaded
// on each sounding channel before the start.
function engineCapture(text, { drift = 0.002, program = 0, edit = events => events } = {}) {
  const expected = expectedEvents(song(text));
  const events = [];
  for (const [channel, list] of expected) for (const event of list) events.push([event.time + drift, event.on ? 1 : 0, channel, event.pitch, event.on ? event.velocity : 0]);
  events.sort((a, b) => a[0] - b[0]);
  return {
    kind: READBACK_KIND, scope: READBACK_SCOPE, gameTimbreEquivalent: false, timeSource: 'engine',
    sessionId: 'session-1', capturedAt: '2026-09-23T00:00:00.000Z',
    bank: { name: 'fixture.sf2', sha256: 'a'.repeat(64) }, engine: { lib: 'spessasynth_lib@4.3.12', core: 'spessasynth_core@4.3.16' },
    program: { program, bankMSB: 0, name: 'Saw Wave' }, audioContextState: 'running',
    muted: [false, false, false, false, false, false], complete: true, incomplete: [], from: 0, duration: 2,
    events: edit(events), programs: [0, 1, 2, 3, 4, 5].map(channel => [-0.12, channel, program, 0]),
  };
}

test('expected events follow the exact tempo map, and a repeated pitch is released before it is struck again', () => {
  const channels = expectedEvents(song('MML@t120o4c4c4v15d2,,,,,;'));
  assert.deepEqual([...channels.keys()], [0]);
  assert.deepEqual(channels.get(0).map(e => [e.time, e.on, e.pitch, e.velocity ?? null]), [
    [0, true, 60, 68], [0.5, false, 60, null], [0.5, true, 60, 68], [1, false, 60, null], [1, true, 62, 127], [2, false, 62, null],
  ]);
});

test('a faithful engine capture matches, within the timing tolerance', () => {
  const result = compareReadback(song(mml), normalizeCapture(engineCapture(mml)));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.expectedNotes, 3);
  assert.equal(result.processedNotes, 3);
  assert.equal(result.maxDriftMs, 2);
});

test('every kind of difference is a mismatch, never a pass', () => {
  const check = (capture, pattern) => {
    const result = compareReadback(song(mml), normalizeCapture(capture));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => pattern.test(error)), `${pattern}: ${result.errors.join(' | ')}`);
  };
  check(engineCapture(mml, { edit: events => events.filter(e => e[2] !== 1) }), /CHANNEL_1_EVENT_COUNT: expected 2, processed 0/);
  check(engineCapture(mml, { edit: events => events.map(e => e[2] === 0 && e[1] === 1 ? [e[0], 1, 0, 61, e[4]] : e) }), /CHANNEL_0_EVENT_0: expected on 60 v68, processed on 61 v68/);
  check(engineCapture(mml, { edit: events => events.map(e => e[2] === 0 && e[1] === 1 ? [e[0], 1, 0, 60, 100] : e) }), /CHANNEL_0_EVENT_0: expected on 60 v68, processed on 60 v100/);
  check(engineCapture(mml, { drift: TIMING_TOLERANCE_SEC + 0.01 }), /_LATE: 35 ms/);
  check(engineCapture(mml, { edit: events => [...events, [0.5, 1, 7, 60, 64]] }), /CHANNEL_7_EVENT_COUNT: expected 0, processed 1/);
  check({ ...engineCapture(mml), programs: [...engineCapture(mml).programs, [0.4, 0, 5, 0]] }, /PROGRAM_CHANGED_DURING_CAPTURE/);
  check({ ...engineCapture(mml), programs: [] }, /CHANNEL_0_PROGRAM_NOT_LOADED/);
  check({ ...engineCapture(mml), programs: [[-0.1, 0, 3, 0], [-0.1, 1, 0, 0], [-0.1, 2, 0, 0]] }, /CHANNEL_0_PROGRAM_MISMATCH/);
  check({ ...engineCapture(mml), muted: [false, true, false, false, false, false] }, /ROLE_MUTED_DURING_CAPTURE/);
  check({ ...engineCapture(mml), complete: false, incomplete: ['PROGRAM_CHANGED'] }, /CAPTURE_INCOMPLETE: PROGRAM_CHANGED/);
  check({ ...engineCapture(mml), from: 1 }, /CAPTURE_NOT_FROM_START/);
});

test('only an engine-clocked capture of the declared shape is read at all', () => {
  const good = engineCapture(mml);
  assert.throws(() => normalizeCapture({ ...good, kind: 'website-playback' }), /not a player readback/);
  assert.throws(() => normalizeCapture({ ...good, timeSource: 'main-thread' }), /engine clock/);
  assert.throws(() => normalizeCapture({ ...good, gameTimbreEquivalent: true }), /scope/);
  assert.throws(() => normalizeCapture({ ...good, bank: { name: 'x', sha256: 'nope' } }), /bank identity/);
  assert.throws(() => normalizeCapture({ ...good, events: [[0, 2, 0, 60, 1]] }), /event malformed/);
  assert.throws(() => normalizeCapture({ ...good, events: Array.from({ length: 100001 }, () => [0, 1, 0, 60, 1]) }), /too many/);
  const clean = normalizeCapture({ ...good, extra: 'dropped' });
  assert.equal('extra' in clean, false);
});

function workspace(preview = 'used') {
  const w = newWorkspace();
  w.title = 'Readback fixture';
  w.settings = { meterText: '0 4/4', recording: 'synthetic version 1', offset: '0', end: '2', audioRequired: 'no', preview };
  for (const slot of ['candidate', 'baseline', 'previous']) w.assets[slot] = intake({ name: `${slot}.mml`, content: mml, id: slot, meterText: w.settings.meterText });
  return w;
}
const reviewAll = w => REVIEW_NAMES.reduce((next, name) => recordReview(next, name, 'Reviewed synthetic fixture', 'fixture:whole-piece'), w);
const binding = (w, exactMml = mml) => ({ workspaceId: w.id, revision: w.revision, exactMml });

test('Gate 6: with a player declared, only a matching recorded readback plus the Tempo review passes', () => {
  let w = reviewAll(workspace('used'));
  let report = analyzeWorkspace(w);
  assert.equal(report.gates.playerReadback.status, 'PENDING');
  assert.equal(report.gates.playerReadback.reason, 'PLAYER_READBACK_NOT_RECORDED');
  assert.equal(report.state, 'CANDIDATE');
  assert.ok(generateFinalDelivery(w).blockedGates.some(gate => gate.name === 'playerReadback'), 'Gate 6 still blocks Final generation');

  w = recordPlayerReadback(w, engineCapture(mml), binding(w));
  report = analyzeWorkspace(w);
  assert.equal(report.gates.playerReadback.status, 'PASS');
  assert.equal(report.gates.playerReadback.reason, 'ENGINE_EVENTS_MATCH_EXACT_MML');
  assert.equal(report.playerReadback.comparison.ok, true);
  assert.equal(report.playerReadback.gameTimbreEquivalent, false);
  assert.equal(report.state, 'VALIDATED');

  // The stored verdict is never read: editing the stored events is re-checked.
  const tampered = structuredClone(w);
  tampered.playerReadback.capture.events[0][3] = 61;
  assert.match(analyzeWorkspace(tampered).gates.playerReadback.reason, /^PLAYER_READBACK_MISMATCH/);
  const claimed = structuredClone(w);
  claimed.playerReadback.capture.timeSource = 'main-thread';
  assert.match(analyzeWorkspace(claimed).gates.playerReadback.reason, /^PLAYER_READBACK_INVALID/);

  // Without a current Tempo review the same readback does not pass.
  const noTempo = structuredClone(w);
  delete noTempo.reviews.tempo;
  assert.equal(analyzeWorkspace(noTempo).gates.playerReadback.reason, 'TEMPO_REVIEW_REQUIRED');
  assert.equal(analyzeWorkspace(noTempo).gates.playerReadback.status, 'PENDING');

  // A new revision drops it; an import keeps it as history only; clearing removes it.
  assert.equal(invalidate(w).playerReadback, undefined);
  const imported = importWorkspace(JSON.stringify(w));
  assert.equal(imported.playerReadback, undefined);
  assert.ok(imported.importedHistory.playerReadback);
  assert.equal(analyzeWorkspace(imported).gates.playerReadback.status, 'PENDING');
  assert.equal(clearPlayerReadback(w).playerReadback, undefined);
});

test('Gate 6: a mismatching capture is stored as what the engine did, and stays PENDING', () => {
  let w = reviewAll(workspace('used'));
  w = recordPlayerReadback(w, engineCapture(mml, { edit: events => events.filter(e => e[2] !== 2) }), binding(w));
  const gate = analyzeWorkspace(w).gates.playerReadback;
  assert.equal(gate.status, 'PENDING');
  assert.match(gate.reason, /CHANNEL_2_EVENT_COUNT/);
});

test('Gate 6: a capture of anything but the loaded project, revision and exact string is refused', () => {
  const w = reviewAll(workspace('used'));
  assert.throws(() => recordPlayerReadback(w, engineCapture(mml), { ...binding(w), revision: w.revision - 1 }), /STALE_PLAYER_READBACK/);
  assert.throws(() => recordPlayerReadback(w, engineCapture(mml), { ...binding(w), workspaceId: 'other' }), /STALE_PLAYER_READBACK/);
  assert.throws(() => recordPlayerReadback(w, engineCapture(mml), binding(w, `${mml} `)), /STALE_PLAYER_READBACK/);
  assert.throws(() => recordPlayerReadback(w, { ...engineCapture(mml), complete: false, incomplete: ['ROLE_MUTED'] }, binding(w)), /整首/);
  assert.throws(() => recordPlayerReadback(reviewAll(workspace('none')), engineCapture(mml), binding(w)), /有使用/);
  assert.throws(() => recordPlayerReadback(reviewAll(workspace('unknown')), engineCapture(mml), binding(w)), /有使用/);
});

test('Gate 6: the N/A path is unchanged, and an undeclared preview stays PENDING', () => {
  const none = analyzeWorkspace(reviewAll(workspace('none'))).gates.playerReadback;
  assert.deepEqual([none.status, none.reason], ['N/A', 'USER_DECLARED_NO_PREVIEW']);
  const noTempo = analyzeWorkspace(workspace('none')).gates.playerReadback;
  assert.deepEqual([noTempo.status, noTempo.reason], ['PENDING', 'TEMPO_REVIEW_REQUIRED']);
  const unknown = analyzeWorkspace(reviewAll(workspace('unknown'))).gates.playerReadback;
  assert.deepEqual([unknown.status, unknown.reason], ['PENDING', 'PREVIEW_USE_NOT_DECLARED']);
});

test('Gate 6: a newly applied delivery string drops the readback recorded for the old one', () => {
  let w = reviewAll(workspace('used'));
  w = recordPlayerReadback(w, engineCapture(mml), binding(w));
  const next = applyFinalDelivery(w, { projectId: w.id, revision: w.revision, status: 'PASS', combinedMml: mml, blockedGates: [], diagnostics: [], at: 'now' });
  assert.equal(next.playerReadback, undefined);
});
