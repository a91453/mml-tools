// Web Studio Final delivery integration regressions.
//
// These cover the join between the Web workspace and the Canonical Final
// emitter: which gates must hold before anything is emitted, that the emitted
// string reaches the workspace unchanged, and that nothing derived can promote
// itself into a verdict.
//
// The failure modes they exist to make impossible:
//
//   * emitting past a Web-level review the backend readiness report cannot see;
//   * grading the candidate's own source text while an explicit delivery exists;
//   * a delivery outliving the candidate it was generated for;
//   * a stored or imported `finalDelivery.status === 'PASS'` standing in for the
//     analysis that decides whether a delivery is currently valid;
//   * any normalization, repair or trimming between emitter PASS and the string
//     the workspace carries.
//
// Emitter-internal behaviour (the duration-search taxonomy, G10 classification,
// round-trip comparison) is covered by final-mml-emitter.test.mjs,
// micro-gap-enforcement.test.mjs and final-duration-plan.test.mjs. What is
// asserted here is that this integration reports those outcomes without
// rewording them and without keeping any output.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newWorkspace, intake, analyzeWorkspace, invalidate, recordReview, recordAcceptance, importWorkspace,
  generateFinalDelivery, applyFinalDelivery, PRE_EMISSION_EXEMPT_GATES, STALE_FINAL_DELIVERY, REVIEW_NAMES,
} from '../web/model.mjs';
import {
  createSource, createCanonicalNoteEvent, createCanonicalTempoEvent, createCanonicalMeterEvent, createCanonicalProject,
} from '../backend/canonical/index.mjs';
import { evaluateProjectReadiness } from '../backend/final/index.mjs';

const OFFICIAL = createSource({ id: 'official', label: 'Official MusicXML', kind: 'official-musicxml', authority: 'primary-symbolic' });
const note = ({ id, pitch = 60, start, end, role = 'Melody', volume = 8 }) => createCanonicalNoteEvent({
  id, pitch, start: String(start), end: String(end), role, voice: role, volume, sourceIds: ['official'],
});

// A bar-complete fixture. The Web technical validation requires the final bar to
// be filled against the confirmed meter, which the emitter does not check, so a
// fixture whose music stops mid-bar fails the delivery check rather than the
// property under test.
function candidateProject(events, { tempoEvents, meterEvents } = {}) {
  return createCanonicalProject({
    id: 'fixture-project', title: 'Final delivery fixture', sources: [OFFICIAL], events,
    tempoEvents: tempoEvents ?? [createCanonicalTempoEvent({ id: 't1', beat: '0', bpm: 120, sourceIds: ['official'] })],
    meterEvents: meterEvents ?? [createCanonicalMeterEvent({ id: 'm1', beat: '0', numerator: 4, denominator: 4, sourceIds: ['official'] })],
    decisions: [], metadata: { sourceComplete: true },
  });
}

const FOUR_BEATS = [
  note({ id: 'n1', pitch: 60, start: 0, end: 1 }),
  note({ id: 'n2', pitch: 62, start: 1, end: 2 }),
  note({ id: 'n3', pitch: 64, start: 2, end: 4 }),
  note({ id: 'n4', pitch: 55, start: 0, end: 4, role: 'Chord1' }),
];

const SETTINGS = { meterText: '0 4/4', recording: 'synthetic version 1', offset: '0', end: '4', audioRequired: 'no', preview: 'none' };

function workspaceFor(project, { slots = ['candidate', 'baseline'] } = {}) {
  const w = newWorkspace();
  w.title = 'Final delivery fixture';
  w.settings = { ...SETTINGS };
  const content = JSON.stringify(project);
  for (const slot of slots) w.assets[slot] = intake({ name: `${slot}.json`, content, id: slot, meterText: w.settings.meterText });
  return w;
}

const reviewAll = (w, skip = []) => REVIEW_NAMES.filter(name => !skip.includes(name))
  .reduce((acc, name) => recordReview(acc, name, `Reviewed ${name}`, 'fixture:whole-piece'), w);

const ready = (events = FOUR_BEATS) => reviewAll(workspaceFor(candidateProject(events)));
const codes = result => result.diagnostics.map(item => item.code);
const blockedNames = result => result.blockedGates.map(gate => gate.name);

// The established six-role MML fixture: one whole note in each of the first
// three roles, three empty roles.
const MML = 'MML@t120o4c1,t120o3e1,t120o2c1,,,;';
function mmlWorkspace() {
  const w = newWorkspace();
  w.title = 'MML candidate fixture';
  w.settings = { ...SETTINGS };
  for (const slot of ['candidate', 'baseline']) w.assets[slot] = intake({ name: `${slot}.mml`, content: MML, id: slot, meterText: w.settings.meterText });
  return reviewAll(w);
}

// ── the pre-emission gate policy ───────────────────────────────────────────

test('only the two output-dependent gates are exempt before emission', () => {
  // Widening this list is how a Web review would become bypassable, so the list
  // is pinned rather than merely described. `technical` and `deliveryIdentity`
  // both grade the MML that does not exist yet; every other gate answers a
  // question about the candidate, which does exist.
  assert.deepEqual([...PRE_EMISSION_EXEMPT_GATES], ['technical', 'deliveryIdentity']);
  const report = analyzeWorkspace(ready());
  for (const name of Object.keys(report.gates)) {
    if (PRE_EMISSION_EXEMPT_GATES.includes(name)) continue;
    assert.ok(['PASS', 'N/A'].includes(report.gates[name].status), `${name} must be satisfied before this fixture can generate`);
  }
  // The exempt pair is exactly what a fully reviewed candidate still blocks on,
  // which is what makes requiring them circular.
  assert.deepEqual(report.blockers, ['technical', 'deliveryIdentity']);
});

test('a required Web gate that is still pending emits nothing', () => {
  // No reviews at all: the candidate is intact but unreviewed.
  const w = workspaceFor(candidateProject(FOUR_BEATS));
  const result = generateFinalDelivery(w);
  assert.equal(result.status, 'PENDING');
  assert.equal(result.combinedMml, null);
  assert.ok(codes(result).includes('FINAL_GENERATION_BLOCKED'));
  for (const name of ['source', 'lead', 'core3', 'full6', 'tempo', 'adaptation', 'regression']) {
    assert.ok(blockedNames(result).includes(name), `${name} must block generation`);
  }
  // Nothing was emitted, so nothing can be written.
  const applied = applyFinalDelivery(w, result);
  assert.equal(applied.deliveryMml, undefined);
  assert.equal(applied.finalDelivery.status, 'PENDING');
  assert.equal(analyzeWorkspace(applied).rawMml, null);
});

test('a Web-only human review still blocks generation when backend readiness is clear', () => {
  // `adaptation` exists only in the Web layer -- evaluateProjectReadiness has no
  // such gate. If generation consulted backend readiness alone it would emit.
  const w = reviewAll(workspaceFor(candidateProject(FOUR_BEATS)), ['adaptation']);
  const backend = evaluateProjectReadiness({
    project: candidateProject(FOUR_BEATS), mmlValidation: null, core3Report: null, harmonyReport: null,
  });
  assert.ok(!backend.preGameBlocking.includes('adaptation'), 'backend readiness does not know this gate exists');

  const result = generateFinalDelivery(w);
  assert.equal(result.status, 'PENDING');
  assert.equal(result.combinedMml, null);
  assert.deepEqual(blockedNames(result), ['adaptation']);
});

test('a backend readiness blocker also refuses, and readiness is handed to the emitter', () => {
  // No baseline: `baseline` is a backend readiness gate, and `source` depends on
  // it. The emitter is never reached.
  const w = reviewAll(workspaceFor(candidateProject(FOUR_BEATS), { slots: ['candidate'] }));
  const result = generateFinalDelivery(w);
  assert.equal(result.status, 'PENDING');
  assert.equal(result.combinedMml, null);
  assert.ok(blockedNames(result).includes('baseline'));
  assert.ok(result.blockedGates.find(gate => gate.name === 'baseline').blockers.includes('SOURCE_FAITHFUL_BASELINE_MISSING'));

  // And the emitter is given the readiness report on the path that does reach
  // it: the backend allows `options.readiness` to be omitted, and omitting it is
  // what would turn this integration into a readiness bypass.
  const passing = ready();
  const context = analyzeWorkspace(passing);
  assert.equal(context.readiness.preGameBlocking.filter(name => name !== 'technical').length, 0);
  assert.equal(generateFinalDelivery(passing).status, 'PASS');
});

// ── the exact-output contract ──────────────────────────────────────────────

test('a clean candidate emits, and the exact emitter string becomes the delivery', () => {
  const w = ready();
  const result = generateFinalDelivery(w);
  assert.equal(result.status, 'PASS');
  assert.equal(result.combinedMml, 'MML@t120o4cde2,t120o3g1,,,,;');
  assert.equal(result.roundTrip.status, 'PASS', 'PASS is only reachable through the emitter round-trip');

  const next = applyFinalDelivery(w, result);
  assert.equal(next.deliveryMml, result.combinedMml, 'the stored delivery is the emitted string, unchanged');
  assert.deepEqual(next.deliveryBinding, { revision: w.revision, origin: 'generated' });

  // The string the UI would copy, download and bind is the same string again.
  const report = analyzeWorkspace(next);
  assert.equal(report.rawMml, result.combinedMml);
  assert.equal(report.deliveryOrigin, 'generated');
  assert.equal(report.rawMml.trim(), report.rawMml, 'trimming must never be able to change the delivery');
});

test('a generated delivery passes the existing technical and identity gates', () => {
  const w = ready();
  const next = applyFinalDelivery(w, generateFinalDelivery(w));
  const report = analyzeWorkspace(next);
  assert.equal(report.technical.ok, true);
  assert.equal(report.gates.technical.status, 'PASS');
  assert.equal(report.gates.deliveryIdentity.status, 'PASS');
  assert.deepEqual(report.blockers, []);
  assert.equal(report.state, 'VALIDATED');
  assert.equal(report.tracks.length, 6);
});

test('empty roles stay empty through generation and readback', () => {
  const w = ready();
  const result = generateFinalDelivery(w);
  const empties = result.roles.filter(entry => entry.empty);
  assert.deepEqual(empties.map(entry => entry.role), ['Chord2', 'Chord3', 'Chord4', 'Chord5']);
  for (const entry of empties) {
    assert.equal(entry.mml, '', 'an empty role is emitted as nothing, not as filler tempo or rests');
    assert.equal(entry.characters, 0);
    assert.equal(entry.attacks, 0);
  }
  assert.ok(result.combinedMml.endsWith(',,,,;'));
  const report = analyzeWorkspace(applyFinalDelivery(w, result));
  assert.deepEqual(report.tracks.slice(2), ['', '', '', '']);
});

test('character counts are the emitter\'s, in its units, with P1 left open', () => {
  const result = generateFinalDelivery(ready());
  assert.equal(result.characterCounts.limit, 2400);
  assert.equal(result.characterCounts.unit, 'javascript-string-length');
  assert.equal(result.characterCounts.clientEquivalenceVerified, false, 'PENDING P1 stays open');
  // Not recomputed here: the counts are the ones the emitter reported.
  for (const entry of result.characterCounts.perRole) {
    assert.equal(entry.characters, result.roles.find(role => role.role === entry.role).characters);
  }
});

test('repeated same-pitch attacks survive generation as separate attacks', () => {
  const events = [
    note({ id: 'a1', pitch: 60, start: 0, end: 1 }),
    note({ id: 'a2', pitch: 60, start: 1, end: 2 }),
    note({ id: 'a3', pitch: 60, start: 2, end: 4 }),
  ];
  const result = generateFinalDelivery(ready(events));
  assert.equal(result.status, 'PASS');
  const melody = result.roles.find(entry => entry.role === 'Melody');
  assert.equal(melody.attacks, 3, 'three attacks must not be tied into one sustain');
  assert.ok(!melody.mml.includes('&'), 'adjacent repeated attacks are not joined with a tie');
  assert.equal(result.roundTrip.status, 'PASS');
});

test('a tempo change inside a sustained note adds no attack and still reads back exactly', () => {
  const events = [note({ id: 's1', pitch: 60, start: 0, end: 4 }), note({ id: 's2', pitch: 55, start: 0, end: 4, role: 'Chord1' })];
  const tempoEvents = [
    createCanonicalTempoEvent({ id: 't1', beat: '0', bpm: 120, sourceIds: ['official'] }),
    createCanonicalTempoEvent({ id: 't2', beat: '2', bpm: 144, sourceIds: ['official'] }),
  ];
  const w = reviewAll(workspaceFor(candidateProject(events, { tempoEvents })));
  const result = generateFinalDelivery(w);
  assert.equal(result.status, 'PASS');
  const melody = result.roles.find(entry => entry.role === 'Melody');
  assert.equal(melody.attacks, 1, 'the sustained note is still one attack');
  assert.ok(melody.mml.includes('&'), 'the split is a tie, not a second attack');
  assert.ok(melody.mml.includes('t144'));
  assert.equal(result.roundTrip.status, 'PASS');
  // Both non-empty roles carry the same Tempo map (MOBILE_SYNTAX §7).
  assert.ok(result.roles.find(entry => entry.role === 'Chord1').mml.includes('t144'));
});

// ── refusals ───────────────────────────────────────────────────────────────

test('a character budget overflow keeps no output and shortens nothing', () => {
  const events = [];
  for (let index = 0; index < 1200; index += 1) {
    events.push(note({ id: `wide-${index}`, pitch: [48, 72, 60][index % 3], start: index / 2, end: (index + 1) / 2 }));
  }
  const w = ready(events);
  const result = generateFinalDelivery(w);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.combinedMml, null, 'an over-budget role produces no combined output at all');
  assert.ok(codes(result).includes('CHARACTER_BUDGET_EXCEEDED'));
  const overflow = result.diagnostics.find(item => item.code === 'CHARACTER_BUDGET_EXCEEDED');
  assert.ok(overflow.characters > 2400);
  assert.equal(overflow.limit, 2400);
  assert.equal(overflow.attacks, 1200, 'every attack is still counted; none was dropped to fit');

  // And nothing is written, so no truncated string can be copied.
  const next = applyFinalDelivery(w, result);
  assert.equal(next.deliveryMml, undefined);
  assert.equal(analyzeWorkspace(next).rawMml, null);
});

test('a bounded duration-search miss is reported as a search limit, never as impossible', () => {
  // A 100-beat sustain is exactly 16 dotted whole notes plus one whole note, but
  // the default 12-segment cap cannot reach that decomposition. The claim the
  // emitter is entitled to make is about its search, not about arithmetic.
  const events = [note({ id: 'long', pitch: 60, start: 0, end: 100 })];
  const result = generateFinalDelivery(ready(events));
  assert.equal(result.status, 'FAIL');
  assert.equal(result.combinedMml, null);
  assert.ok(codes(result).includes('DURATION_SEARCH_POLICY_LIMIT'));
  const miss = result.diagnostics.find(item => item.code === 'DURATION_SEARCH_POLICY_LIMIT');
  assert.equal(miss.planFailure, 'search-policy-limit');
  assert.equal(miss.completenessProven, false);
  // No diagnostic this integration surfaces may claim unrepresentability.
  for (const item of result.diagnostics) {
    assert.ok(!/not representable|unrepresentable|impossible/i.test(item.message), `overclaim in ${item.code}: ${item.message}`);
    assert.ok(!/NOT_REPRESENTABLE/.test(item.code) || item.code.startsWith('SOURCE_SUPPORTED_INTERVAL'), `overclaiming code ${item.code}`);
  }
});

test('emitter diagnostics reach the caller with the emitter\'s own structure, and a refusal writes nothing', () => {
  const events = [note({ id: 'long', pitch: 60, start: 0, end: 100 })];
  const w = ready(events);
  const result = generateFinalDelivery(w);
  assert.equal(result.status, 'FAIL');
  // Structured emitter fields survive the trip: this integration reports the
  // emitter's verdict, it does not re-derive or re-word one.
  const miss = result.diagnostics.find(item => item.code === 'DURATION_SEARCH_POLICY_LIMIT');
  assert.equal(miss.severity, 'error');
  assert.equal(miss.role, 'Melody');
  assert.equal(miss.eventId, 'long');
  assert.ok(miss.message.includes('search'));
  // The emitter's Canonical identity is carried, so the UI can state which
  // published release produced the verdict.
  assert.equal(result.canonical.canonical_version, '2026-09-13-v1');
  assert.equal(result.canonical.rules_snapshot_sha, '0a172900a01fdf39c2e9e84cf176961320b779ea');

  const next = applyFinalDelivery(w, result);
  assert.equal(next.deliveryMml, undefined, 'a refusal never writes a delivery');
  assert.equal(next.finalDelivery.status, 'FAIL');
});

test('a failed generation never overwrites a delivery that already passed', () => {
  const w = ready();
  const passed = applyFinalDelivery(w, generateFinalDelivery(w));
  const good = passed.deliveryMml;
  const failure = { ...generateFinalDelivery(w), status: 'FAIL', combinedMml: null, diagnostics: [] };
  const after = applyFinalDelivery(passed, failure);
  assert.equal(after.deliveryMml, good, 'the existing delivery is untouched by a failed attempt');
  assert.equal(after.finalDelivery.status, 'FAIL');
});

// ── delivery identity (D1) ─────────────────────────────────────────────────

test('an explicit delivery is what gets verified, even when the candidate is MML', () => {
  // Before this was fixed, an MML candidate made `w.deliveryMml` unreachable:
  // the candidate's own text was validated and read back against itself, so a
  // mismatched delivery could not be detected and a generated one was ignored.
  const w = mmlWorkspace();
  assert.equal(analyzeWorkspace(w).state, 'VALIDATED', 'the candidate alone still validates as its own delivery');
  assert.equal(analyzeWorkspace(w).deliveryOrigin, 'candidate-source');

  const mismatched = { ...w, deliveryMml: MML.replace('o4c1', 'o4d1'), deliveryBinding: { revision: w.revision, origin: 'pasted' } };
  const report = analyzeWorkspace(mismatched);
  assert.equal(report.deliveryOrigin, 'pasted');
  assert.equal(report.gates.deliveryIdentity.status, 'PENDING');
  assert.equal(report.rawMml, null, 'a delivery that is not the candidate cannot be copied as verified MML');
  assert.equal(report.state, 'CANDIDATE');
});

test('a generated delivery for an MML candidate is the string that gets verified', () => {
  const w = mmlWorkspace();
  const result = generateFinalDelivery(w);
  assert.equal(result.status, 'PASS');
  const next = applyFinalDelivery(w, result);
  const report = analyzeWorkspace(next);
  assert.equal(report.deliveryOrigin, 'generated');
  assert.equal(report.rawMml, result.combinedMml);
  assert.equal(report.gates.deliveryIdentity.status, 'PASS');
  assert.equal(report.state, 'VALIDATED');
});

// ── staleness and derived state ────────────────────────────────────────────

test('a generation result for another project or revision is discarded', () => {
  const w = ready();
  const result = generateFinalDelivery(w);
  assert.throws(() => applyFinalDelivery({ ...w, revision: w.revision + 1 }, result), new RegExp(STALE_FINAL_DELIVERY));
  assert.throws(() => applyFinalDelivery({ ...w, id: 'a-different-project' }, result), new RegExp(STALE_FINAL_DELIVERY));
  assert.throws(() => applyFinalDelivery(w, null), new RegExp(STALE_FINAL_DELIVERY));
  // The matching workspace still accepts it.
  assert.equal(applyFinalDelivery(w, result).deliveryMml, result.combinedMml);
});

test('changing the candidate drops the generated delivery instead of leaving it copyable', () => {
  const w = ready();
  const next = applyFinalDelivery(w, generateFinalDelivery(w));
  assert.equal(analyzeWorkspace(next).state, 'VALIDATED');

  const changed = invalidate(next);
  assert.equal(changed.deliveryMml, undefined, 'a superseded delivery is not carried into the new revision');
  assert.equal(changed.deliveryBinding, undefined);
  assert.equal(changed.finalDelivery, undefined);
  const report = analyzeWorkspace(changed);
  assert.equal(report.rawMml, null, 'nothing stale remains copyable as the current Final');
  assert.equal(report.tracks, null);
  assert.equal(report.state, 'CANDIDATE');
});

test('a delivery bound to a superseded revision is never treated as current', () => {
  // Defence in depth: `invalidate` already drops the delivery, so this state can
  // only arise from a result applied across a revision change.
  const w = ready();
  const next = applyFinalDelivery(w, generateFinalDelivery(w));
  const stale = { ...next, revision: next.revision + 1, deliveryBinding: { ...next.deliveryBinding } };
  const report = analyzeWorkspace(stale);
  assert.equal(report.deliveryOrigin, null);
  assert.equal(report.rawMml, null);
  assert.equal(report.gates.deliveryIdentity.status, 'PENDING');
});

test('a stored or tampered finalDelivery PASS grants nothing', () => {
  // `finalDelivery` is derived cache. Validity is re-established by the analysis
  // on every run, never read out of the record.
  const unreviewed = workspaceFor(candidateProject(FOUR_BEATS));
  const forged = {
    ...unreviewed,
    finalDelivery: { status: 'PASS', at: new Date().toISOString(), revision: unreviewed.revision, blockedGates: [], diagnostics: [], roundTrip: { status: 'PASS' } },
  };
  const report = analyzeWorkspace(forged);
  assert.equal(report.state, 'CANDIDATE');
  assert.equal(report.rawMml, null);
  assert.ok(report.blockers.includes('source'));
  assert.deepEqual(report.blockers, analyzeWorkspace(unreviewed).blockers, 'the forged record changes no gate');

  // A forged PASS alongside a delivery that is not the candidate stays refused.
  const w = ready();
  const tampered = {
    ...w,
    deliveryMml: 'MML@t120o4c1,,,,,;',
    deliveryBinding: { revision: w.revision, origin: 'generated' },
    finalDelivery: { status: 'PASS', at: new Date().toISOString(), revision: w.revision, blockedGates: [], diagnostics: [] },
  };
  const tamperedReport = analyzeWorkspace(tampered);
  assert.equal(tamperedReport.gates.deliveryIdentity.status, 'PENDING');
  assert.equal(tamperedReport.rawMml, null);
  assert.equal(tamperedReport.state, 'CANDIDATE');
});

test('a restored backup carries the delivery text but none of its status', () => {
  const w = ready();
  const next = applyFinalDelivery(w, generateFinalDelivery(w));
  assert.equal(analyzeWorkspace(next).state, 'VALIDATED');

  const restored = importWorkspace(JSON.stringify(next));
  assert.equal(restored.deliveryMml, next.deliveryMml, 'the exact text is carried');
  assert.equal(restored.deliveryBinding, undefined, 'its generated binding is not');
  assert.equal(restored.finalDelivery, undefined, 'and neither is its PASS record');
  // Reviews are history again, so the restored workspace is a candidate.
  const report = analyzeWorkspace(restored);
  assert.equal(report.state, 'CANDIDATE');
  assert.equal(report.deliveryOrigin, 'pasted', 'a restored delivery is re-verified as a pasted one');
  // The text itself still reads back correctly; it is the reviews that are gone.
  assert.equal(report.gates.deliveryIdentity.status, 'PASS');
  assert.ok(report.blockers.includes('source'));
});

test('acceptance still requires VALIDATED and binds the exact generated string', () => {
  const w = ready();
  assert.throws(() => recordAcceptance(w, { client: 'c', instrument: 'i', evidence: 'e' }), /Gate/);
  const next = applyFinalDelivery(w, generateFinalDelivery(w));
  const accepted = recordAcceptance(next, { client: 'test-client', instrument: 'three-role piano', evidence: 'controlled fixture only' });
  assert.equal(accepted.acceptance.exactMml, next.deliveryMml);
  assert.equal(analyzeWorkspace(accepted).state, 'IN_GAME_ACCEPTED');

  // Regenerating clears acceptance, because the bound string is replaced.
  const regenerated = applyFinalDelivery(accepted, generateFinalDelivery(accepted));
  assert.equal(regenerated.acceptance, null);
  assert.equal(analyzeWorkspace(regenerated).state, 'VALIDATED');
});

test('a Web delivery-validation refusal is reported in the validator\'s own words', () => {
  // The emitter has no final-bar-completeness check and the Web technical
  // validation does, so a candidate whose music stops mid-bar serializes
  // cleanly and is then refused here. That disagreement is a current
  // implementation finding, not a published rule and not a proven engine limit,
  // so the refusal is carried verbatim rather than paraphrased -- and nothing
  // pads the music to make it go away.
  const events = [
    note({ id: 'half1', pitch: 60, start: 0, end: 1 }),
    note({ id: 'half2', pitch: 62, start: 1, end: 2 }),
  ];
  const w = ready(events);
  const result = generateFinalDelivery(w);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.combinedMml, null, 'a refused delivery keeps no output');
  assert.ok(codes(result).includes('FINAL_DELIVERY_READBACK_FAILED'));
  assert.equal(result.delivery.technical.ok, false, 'the Web validator is what refused it');

  const next = applyFinalDelivery(w, result);
  assert.equal(next.deliveryMml, undefined, 'nothing is written');
  assert.equal(next.finalDelivery.deliveryCheck.technicalOk, false);
  assert.ok(next.finalDelivery.deliveryCheck.errors.length > 0, 'the validator messages are kept so the UI can show them');
  assert.ok(next.finalDelivery.deliveryCheck.errors.every(message => typeof message === 'string' && message.length));
  assert.equal(analyzeWorkspace(next).rawMml, null);
});
