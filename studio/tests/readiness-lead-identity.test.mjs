// Gate 3 — a Lead swap across two projects that share no event ids.
//
// The sibling file `readiness-lead-swap.test.mjs` covers the same-onset swap
// when both sides share an id space. This one covers the case that survived it,
// found by an external audit and reproduced before being fixed.
//
// `compare/version-drift.mjs` aligns notes by structure -- exact, then
// role+onset+pitch, then role+onset, then role move -- and never by identity.
// Studio Web can hold a baseline and a candidate imported as separate assets,
// whose event ids are independently generated. Then:
//
//   baseline   A Melody C5 @0       candidate   X Melody E5 @0
//              B Chord3 E5 @0                   Y Chord3 C5 @0
//
// aligns as A<->X "pitch 72->76" and B<->Y "pitch 76->72" on the role+onset
// pass. Observed before the fix:
//
//   roleMoved []   added []   removed []
//   leadDemotion  N/A   leadPromotion  N/A   neither blocking
//
// A Lead swap with no evidence at all, and `N/A` is PASS-like. Melody
// membership by event id -- which closes the shared-id case -- cannot help,
// because no id is on both sides.
//
// The fix does NOT re-align and does NOT read a pitch change as a role move.
// It asks a narrower question: is this pairing corroborated by identity, or is
// it the aligner's guess? Corroboration is the same event id, the same
// single-source provenance citation, or a reversible derived-duplicate chain --
// never pitch or onset coincidence, which is exactly the substitution the Lead
// evidence binding exists to refuse. An uncorroborated pairing touching a Lead
// event whose id has no counterpart leaves the Lead question neither proven nor
// refuted, and Canonical requires it resolved: MASTER_RULES §4 demands positive
// role evidence to demote a source-supported Lead, and Gate 3 the evidence
// chain for any Lead demotion. Unresolvable is PENDING, never N/A.

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateProjectReadiness } from '../backend/final/index.mjs';
import { compareCandidateLineage, compareCanonicalVersions } from '../backend/compare/version-drift.mjs';
import {
  createCanonicalProject,
  createCanonicalNoteEvent,
  createCanonicalTempoEvent,
  createCanonicalMeterEvent,
  createSource,
} from '../backend/canonical/index.mjs';

const SOURCE = 'fixture:official-midi';
const UNRESOLVED = 'LEAD_IDENTITY_CORRESPONDENCE_UNRESOLVED';

const note = (id, pitch, role, { start = '0', end = '1', cites = id, metadata = {} } = {}) => createCanonicalNoteEvent({
  id, pitch, start, end, role, voice: role.toLowerCase(), volume: null, metadata,
  sourceIds: [SOURCE], sourceEventIds: [`${SOURCE}#${cites}`],
});

const SECOND_SOURCE = 'fixture:second-source';
const source = (id, sha) => createSource({ id, label: id, kind: 'official-midi', authority: 'primary-symbolic', sha256: sha, metadata: {} });

const project = (id, events, metadata = {}) => createCanonicalProject({
  id, title: id, metadata, events,
  sources: [source(SOURCE, 'a'.repeat(64)), source(SECOND_SOURCE, 'b'.repeat(64))],
  tempoEvents: [createCanonicalTempoEvent({ id: `${id}:tempo`, beat: '0', bpm: 120, sourceIds: [SOURCE], sourceEventIds: [`${SOURCE}#tempo`] })],
  meterEvents: [createCanonicalMeterEvent({ id: `${id}:meter`, beat: '0', numerator: 4, denominator: 4, sourceIds: [SOURCE], sourceEventIds: [`${SOURCE}#meter`] })],
});

// A Melody C5 and a Chord3 E5 at the same onset, plus one untouched filler.
const baseline = project('fixture:baseline', [
  note('A', 72, 'Melody'),
  note('B', 76, 'Chord3'),
  note('pad', 67, 'Chord1', { start: '1', end: '2' }),
]);

const candidateOf = events => project('fixture:candidate', events, { sourceFaithfulBaseline: { snapshot: baseline } });

const readinessOf = (candidate, reports = {}) => evaluateProjectReadiness({
  project: candidate,
  lineageReport: compareCandidateLineage({ sourceBaseline: baseline, acceptedPrevious: null, candidate }),
  leadDemotionReports: reports.demotion ?? [],
  leadPromotionReports: reports.promotion ?? [],
});

const pass = (eventId, destinationRole) => ({ status: 'PASS', pass: true, eventId, destinationRole, blockers: [], warnings: [] });

// ─── 1. disjoint-id Lead swap, no evidence ──────────────────────────────────

test('a disjoint-id Lead swap is not N/A, and blocks', () => {
  const candidate = candidateOf([
    note('X', 76, 'Melody', { cites: 'X' }),
    note('Y', 72, 'Chord3', { cites: 'Y' }),
    note('pad2', 67, 'Chord1', { start: '1', end: '2', cites: 'pad2' }),
  ]);

  // The premise, asserted rather than assumed: the diff sees two pitch edits.
  const diff = compareCanonicalVersions(baseline, candidate);
  assert.deepEqual([...diff.notes.roleMoved], []);
  assert.deepEqual([...diff.notes.added], []);
  assert.deepEqual([...diff.notes.removed], []);
  assert.ok(diff.notes.modified.some(pair => pair.before.id === 'A' && pair.after.id === 'X'));

  const readiness = readinessOf(candidate);
  for (const name of ['leadDemotion', 'leadPromotion']) {
    assert.notEqual(readiness.gates[name].status, 'N/A', `${name} must not go quiet`);
    assert.equal(readiness.gates[name].status, 'PENDING');
    assert.ok(readiness.gates[name].blockers.includes(UNRESOLVED));
    assert.ok(readiness.preGameBlocking.includes(name));
  }
  assert.equal(readiness.candidateReady, false);

  // And it does NOT name fake per-event Lead moves: the honest answer is that
  // the correspondence is unknown, not that a specific event was demoted.
  assert.equal(readiness.gates.leadDemotion.pendingEventIds, undefined);
  assert.deepEqual(readiness.gates.leadDemotion.unresolvedPairings.map(p => [p.beforeId, p.afterId]), [['A', 'X']]);

  // Supplying evidence cannot paper over it: the question is traceability.
  const withEvidence = readinessOf(candidate, { demotion: [pass('A', 'Chord3')], promotion: [pass('X', 'Melody')] });
  assert.equal(withEvidence.gates.leadDemotion.status, 'PENDING');
  assert.equal(withEvidence.gates.leadPromotion.status, 'PENDING');
});

// ─── 2. the shared-id protection still works ────────────────────────────────

test('a same-id Lead swap keeps its existing per-event requirement', () => {
  const candidate = candidateOf([
    note('A', 72, 'Chord3'),
    note('B', 76, 'Melody'),
    note('pad', 67, 'Chord1', { start: '1', end: '2' }),
  ]);

  const readiness = readinessOf(candidate);
  assert.equal(readiness.gates.leadDemotion.status, 'PENDING');
  assert.deepEqual([...readiness.gates.leadDemotion.pendingEventIds], ['A']);
  assert.equal(readiness.gates.leadPromotion.status, 'PENDING');
  assert.deepEqual([...readiness.gates.leadPromotion.pendingEventIds], ['B']);
  // Named events, so it is answerable by evidence -- unlike case 1.
  for (const name of ['leadDemotion', 'leadPromotion']) {
    assert.equal(readiness.gates[name].blockers.includes(UNRESOLVED), false);
  }

  const answered = readinessOf(candidate, { demotion: [pass('A', 'Chord3')], promotion: [pass('B', 'Melody')] });
  assert.equal(answered.gates.leadDemotion.status, 'PASS');
  assert.equal(answered.gates.leadPromotion.status, 'PASS');
});

// ─── 3. an ordinary Melody pitch edit is not a role move ────────────────────

test('a genuine Melody pitch correction is not turned into a demotion plus promotion', () => {
  // Same ids, so the correspondence is proven: A is still the Lead, only its
  // pitch was corrected. No Lead role question arises at all.
  const candidate = candidateOf([
    note('A', 73, 'Melody'),
    note('B', 76, 'Chord3'),
    note('pad', 67, 'Chord1', { start: '1', end: '2' }),
  ]);

  const diff = compareCanonicalVersions(baseline, candidate);
  assert.ok(diff.notes.modified.some(pair => pair.before.id === 'A' && pair.after.id === 'A' && pair.changes.pitch));

  const readiness = readinessOf(candidate);
  assert.equal(readiness.gates.leadDemotion.status, 'N/A', 'a pitch edit is not a demotion');
  assert.equal(readiness.gates.leadPromotion.status, 'N/A', 'a pitch edit is not a promotion');
  assert.equal(readiness.preGameBlocking.includes('leadDemotion'), false);
  assert.equal(readiness.preGameBlocking.includes('leadPromotion'), false);
});

// ─── 4. disjoint ids, equivalent Lead material ──────────────────────────────

test('independently imported projects with equivalent Lead material require no Lead move', () => {
  // Every id differs and every provenance citation differs -- the shape a Web
  // workspace takes when baseline and candidate are imported separately -- but
  // the music is the same, so no pairing carries a change and there is nothing
  // to be unsure about.
  const candidate = candidateOf([
    note('X', 72, 'Melody', { cites: 'X' }),
    note('Y', 76, 'Chord3', { cites: 'Y' }),
    note('pad2', 67, 'Chord1', { start: '1', end: '2', cites: 'pad2' }),
  ]);

  const readiness = readinessOf(candidate);
  assert.equal(readiness.gates.leadDemotion.status, 'N/A');
  assert.equal(readiness.gates.leadPromotion.status, 'N/A');
  assert.equal(readiness.preGameBlocking.includes('leadDemotion'), false);
  assert.equal(readiness.preGameBlocking.includes('leadPromotion'), false);
});

// ─── 5. a traceable disjoint-id correspondence is provable and gradeable ────

test('disjoint ids that still cite the same source events resolve to ordinary Lead moves', () => {
  // The ids differ, but each candidate note carries the provenance citation of
  // the baseline note it is: X cites A, Y cites B. That is identity, not
  // coincidence, so the swap is proven rather than unresolved -- and the
  // pairing the aligner made is corroborated away.
  const candidate = candidateOf([
    note('X', 76, 'Melody', { cites: 'B' }),
    note('Y', 72, 'Chord3', { cites: 'A' }),
    note('pad2', 67, 'Chord1', { start: '1', end: '2', cites: 'pad' }),
  ]);

  const readiness = readinessOf(candidate);
  for (const name of ['leadDemotion', 'leadPromotion']) {
    assert.equal(readiness.gates[name].blockers?.includes(UNRESOLVED) ?? false, false, `${name} correspondence is traceable`);
  }
  // The aligner pairs A<->Y and B<->X by provenance-corroborated structure, so
  // these are role moves it can name, and the shared graders can answer them.
  assert.equal(readiness.gates.leadDemotion.status, 'PENDING');
  assert.deepEqual([...readiness.gates.leadDemotion.pendingEventIds], ['A']);
  assert.equal(readiness.gates.leadPromotion.status, 'PENDING');
  assert.deepEqual([...readiness.gates.leadPromotion.pendingEventIds], ['X']);

  const answered = readinessOf(candidate, { demotion: [pass('A', 'Chord3')], promotion: [pass('X', 'Melody')] });
  assert.equal(answered.gates.leadDemotion.status, 'PASS');
  assert.equal(answered.gates.leadPromotion.status, 'PASS');
});

// ─── 6. ambiguity is PENDING, never N/A ─────────────────────────────────────

test('an ambiguous identity correspondence is unresolved rather than absent', () => {
  // Multi-source provenance: the Canonical IR carries `sourceIds` and
  // `sourceEventIds` as independent arrays with no pairing between them, so
  // which source event belongs to which source cannot be established. The Lead
  // evidence binding already fails closed on exactly this
  // (LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS), and so does correspondence.
  //
  // The fixture is built to discriminate: this note cites EXACTLY the citation
  // baseline `A` carries, so dropping the single-source rule would correspond
  // the two and report no Lead move at all. It carries two sources, so which
  // source that citation belongs to cannot be established, and it must not.
  const ambiguous = createCanonicalNoteEvent({
    id: 'X', pitch: 76, start: '0', end: '1', role: 'Melody', voice: 'melody', volume: null, metadata: {},
    sourceIds: [SOURCE, SECOND_SOURCE],
    sourceEventIds: [`${SOURCE}#A`],
  });
  const candidate = candidateOf([
    ambiguous,
    note('Y', 72, 'Chord3', { cites: 'Y' }),
    note('pad2', 67, 'Chord1', { start: '1', end: '2', cites: 'pad2' }),
  ]);

  const readiness = readinessOf(candidate);
  for (const name of ['leadDemotion', 'leadPromotion']) {
    assert.notEqual(readiness.gates[name].status, 'N/A');
    assert.equal(readiness.gates[name].status, 'PENDING');
    assert.ok(readiness.gates[name].blockers.includes(UNRESOLVED));
    assert.ok(readiness.preGameBlocking.includes(name));
  }
});

// ─── the derived-duplicate chain is a third corroboration ───────────────────

test('a justified duplicate into Melody is traceable through its derived chain', () => {
  // The derived id is in no snapshot, and it cites its origin's provenance
  // rather than its own. Its identity is still traceable -- `derivedFromEventId`
  // is reversible -- so it stays an ordinary promotion the Lead graders answer,
  // not an open correspondence question.
  const derived = createCanonicalNoteEvent({
    id: 'B#dup', pitch: 76, start: '0', end: '1', role: 'Melody', voice: 'melody', volume: null,
    sourceIds: [SOURCE], sourceEventIds: [`${SOURCE}#B`],
    metadata: { g11d: { derivedFromEventId: 'B' } },
  });
  const candidate = candidateOf([
    note('A', 72, 'Melody'),
    note('B', 76, 'Chord3'),
    derived,
    note('pad', 67, 'Chord1', { start: '1', end: '2' }),
  ]);

  const readiness = readinessOf(candidate);
  assert.equal(readiness.gates.leadPromotion.blockers?.includes(UNRESOLVED) ?? false, false);
  // It is an added Melody note, so the promotion is required by id and is
  // answerable in the ordinary way.
  assert.equal(readiness.gates.leadPromotion.status, 'PENDING');
  assert.deepEqual([...readiness.gates.leadPromotion.pendingEventIds], ['B#dup']);
  assert.equal(readinessOf(candidate, { promotion: [pass('B#dup', 'Melody')] }).gates.leadPromotion.status, 'PASS');
});

// ─── the same case on the plane it actually reaches ─────────────────────────
//
// The fixtures above drive readiness directly. This one drives the real Studio
// Web analysis, because that is the plane where two projects genuinely arrive
// with unrelated id spaces: two MML deliveries, parsed independently, produce
// `b:note:Melody:1` and `c:note:Melody:1` for the same musical slot.
//
// Without the correspondence check this exact workspace reported
// `leadDemotion: N/A`, `leadPromotion: N/A` and an empty Lead blocker list for
// a swapped Lead. Verified by disabling the check and re-running.

test('a disjoint-id Lead swap reaches Gate 3 through the real Studio Web analysis', async () => {
  const { newWorkspace, analyzeWorkspace, intake } = await import('../web/model.mjs');
  const settings = { meterText: '0 4/4', recording: '', offset: '', end: '', audioRequired: 'no', preview: 'none' };
  const mmlAsset = (name, content, id) => intake({ name, content, id, meterText: '0 4/4' });

  const workspace = { ...newWorkspace(), title: 'web lead swap', settings };
  // Melody C / Chord1 E, against Melody E / Chord1 C: the Lead and the inner
  // voice trade places at the same onset.
  workspace.assets.baseline = mmlAsset('baseline.mml', 'MML@t120o5c1,t120o5e1,,,,;', 'b');
  workspace.assets.candidate = mmlAsset('candidate.mml', 'MML@t120o5e1,t120o5c1,,,,;', 'c');

  const report = analyzeWorkspace(workspace);
  assert.equal(report.readiness.gates.baseline.status, 'PASS', 'the baseline snapshot is present, so the gate really ran');

  for (const name of ['leadDemotion', 'leadPromotion']) {
    const gate = report.readiness.gates[name];
    assert.notEqual(gate.status, 'N/A', `${name} must not go quiet on a Web Lead swap`);
    assert.equal(gate.status, 'PENDING');
    assert.ok(gate.blockers.includes(UNRESOLVED));
    assert.ok(report.readiness.preGameBlocking.includes(name));
  }
  // The ids really are disjoint -- that is what makes this the Web case.
  const [pairing] = report.readiness.gates.leadDemotion.unresolvedPairings;
  assert.notEqual(pairing.beforeId, pairing.afterId);
  assert.notEqual(report.state, 'VALIDATED');
});
