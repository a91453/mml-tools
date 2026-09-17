import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalTempoEvent,
  createCanonicalMeterEvent,
  createCanonicalProject,
} from '../backend/canonical/index.mjs';
import {
  evaluateLeadDemotion,
  sourceIdentityBlockers,
  leadEvidenceIdentityBlockers as gateBinding,
  LEAD_EVIDENCE_IDENTITY_MISMATCH,
  LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS,
  LEAD_EVIDENCE_IDENTITY_BLOCKERS,
} from '../backend/arbitration/lead-demotion.mjs';
import {
  applyAcceptedArrangement,
  leadEvidenceIdentityBlockers as applicationBinding,
  LEAD_EVIDENCE_IDENTITY_MISMATCH as APPLICATION_MISMATCH,
  DECISION_REJECTION,
} from '../backend/arrangement/decision-application.mjs';
import { intake, newWorkspace, analyzeWorkspace, recordLeadEvidence, invalidate, importWorkspace, WORKSPACE_SCHEMA } from '../web/model.mjs';
import { acceptanceFor, CANONICAL_IDENTITY } from './fixtures/g11d-fixtures.mjs';

// G11-D residual A: Lead evidence identity containment at the shared gate.
//
// Two production paths reach the Lead Demotion Gate with a stored citation:
//
//   * the pre-G11-D Studio Web path -- `workspace.leadEvidence[]`, judged by
//     `analyzeWorkspace()` against the baseline event each record names;
//   * the G11-D path -- `decision.leadEvidence`, judged at application and
//     again by the downstream report builder.
//
// The G11-D path bound the citation to the event since PR #28; the Web path
// did not, and "the only writer builds it correctly" was the whole containment.
// Both now go through one binding that lives inside the gate itself. These
// regressions drive the *Web* path through the real model, and then prove the
// two paths raise the same codes for the same citation.

const SCORE = 'official-score';
const MIDI = 'third-party-midi';
const settings = { meterText: '0 4/4', recording: 'synthetic', offset: '0', end: '4', audioRequired: 'no', preview: 'none' };

const note = (id, pitch, start, end, role, { sourceIds = [SCORE], sourceEventIds = [`${SCORE}#${id}`] } = {}) =>
  createCanonicalNoteEvent({ id, pitch, start, end, sourceIds, sourceEventIds, role, metadata: {} });

function project(id, { leadRole = 'Melody', multi = false } = {}) {
  const events = [
    note('lead-1', 72, '0', '1', leadRole),
    note('lead-2', 74, '1', '2', 'Melody'),
    note('harm-1', 64, '0', '2', 'Chord1'),
    note('bass-1', 48, '0', '2', 'Chord2'),
  ];
  if (multi) {
    events[0] = note('lead-1', 72, '0', '1', leadRole, { sourceIds: [SCORE, MIDI], sourceEventIds: [`${SCORE}#lead-1`, 'track:1/event:7'] });
  }
  return createCanonicalProject({
    id,
    title: 'Web Lead identity fixture',
    sources: [
      createSource({ id: SCORE, label: 'score', kind: 'official-musicxml', authority: 'primary-symbolic' }),
      ...(multi ? [createSource({ id: MIDI, label: 'midi', kind: 'third-party-midi', authority: 'supporting' })] : []),
    ],
    events,
    tempoEvents: [createCanonicalTempoEvent({ id: 'tempo-1', beat: '0', bpm: 120, sourceIds: [SCORE] })],
    meterEvents: [createCanonicalMeterEvent({ id: 'meter-1', beat: '0', numerator: 4, denominator: 4, sourceIds: [SCORE] })],
    metadata: { sourceComplete: true },
  });
}

const asset = (name, value) => intake({ name, content: JSON.stringify(value), id: name });

// A workspace whose candidate has demoted lead-1 to Chord3 relative to the
// baseline, so the readiness Lead gate requires a report for lead-1.
function workspace({ multi = false } = {}) {
  return {
    ...newWorkspace(),
    title: 'fixture',
    settings,
    assets: {
      baseline: asset('baseline.json', project('fixture:baseline', { multi })),
      candidate: asset('candidate.json', project('fixture:candidate', { leadRole: 'Chord3', multi })),
    },
  };
}

const form = overrides => ({
  eventId: 'lead-1',
  destinationRole: 'Chord3',
  sectionRole: 'vocal-active',
  scoreClass: 'inner',
  scoreCitation: 'score: inner staff, bar 1',
  audioClass: 'background',
  audioCitation: 'audio: 0:00-0:01 behind the vocal',
  positiveReason: 'The score places it on the inner staff and the mix keeps it behind the lead.',
  continuity: 'checked',
  ...overrides,
});

const leadReport = report => report.leadReports.find(item => item.eventId === 'lead-1');
const identityOnly = report => [...(report?.blockers ?? [])].filter(code => LEAD_EVIDENCE_IDENTITY_BLOCKERS.includes(code));

// ─── the record is constructed behind the Worker, never by the page ─────────

test('recordLeadEvidence binds the record to the loaded baseline Melody event and cites its single source', () => {
  const next = recordLeadEvidence(workspace(), form());
  assert.equal(next.leadEvidence.length, 1);
  const record = next.leadEvidence[0];
  assert.equal(record.eventId, 'lead-1');
  assert.deepEqual(record.sourceIdentity, { sourceId: SCORE, sourceEventId: `${SCORE}#lead-1` });
  assert.equal(record.revision, 0);
  assert.equal(next.acceptance, null);
  // Re-recording the same event replaces, never duplicates.
  assert.equal(recordLeadEvidence(next, form({ sectionRole: 'vocal-rest' })).leadEvidence.length, 1);
});

test('recordLeadEvidence refuses a non-Melody baseline event, an unknown event and an invalid destination', () => {
  assert.throws(() => recordLeadEvidence(workspace(), form({ eventId: 'harm-1' })), /Melody/);
  assert.throws(() => recordLeadEvidence(workspace(), form({ eventId: 'nope' })), /Melody/);
  assert.throws(() => recordLeadEvidence(workspace(), form({ destinationRole: 'Melody' })), /Chord1/);
  assert.throws(() => recordLeadEvidence({ ...workspace(), assets: {} }, form()), /Melody/);
});

test('recordLeadEvidence never index-pairs a multi-source event', () => {
  const next = recordLeadEvidence(workspace({ multi: true }), form());
  assert.equal(next.leadEvidence[0].sourceIdentity, null, 'no pairing can be proven, so none is written');
  const report = leadReport(analyzeWorkspace(next));
  assert.equal(report.status, 'PENDING');
  assert.deepEqual(identityOnly(report), ['SOURCE_IDENTITY_MISSING', LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS]);
  assert.equal(analyzeWorkspace(next).readiness.gates.leadDemotion.status, 'PENDING');
});

// ─── the Web path is judged by the gate against the exact baseline event ────

test('1: a correct single-source record passes the Web Lead gate exactly as before', () => {
  const report = analyzeWorkspace(recordLeadEvidence(workspace(), form()));
  const lead = leadReport(report);
  assert.equal(lead.status, 'PASS');
  assert.deepEqual([...lead.blockers], []);
  assert.equal(report.readiness.gates.leadDemotion.status, 'PASS');
});

test('2: a stored record for event A carrying event B\'s source event identity is PENDING under A\'s id', () => {
  const next = recordLeadEvidence(workspace(), form());
  // Storage is the reviewer's own and mutable. The record keeps eventId lead-1
  // but its citation is rewritten to lead-2's source event.
  const forged = structuredClone(next);
  forged.leadEvidence[0].sourceIdentity = { sourceId: SCORE, sourceEventId: `${SCORE}#lead-2` };
  const report = analyzeWorkspace(forged);
  const lead = leadReport(report);
  assert.equal(lead.eventId, 'lead-1');
  assert.equal(lead.status, 'PENDING');
  assert.deepEqual(identityOnly(lead), [LEAD_EVIDENCE_IDENTITY_MISMATCH]);
  assert.equal(report.readiness.gates.leadDemotion.status, 'PENDING');
  assert.ok(report.readiness.gates.leadDemotion.pendingEventIds.includes('lead-1'));
});

test('3: same sourceId, wrong sourceEventId is refused', () => {
  const forged = structuredClone(recordLeadEvidence(workspace(), form()));
  forged.leadEvidence[0].sourceIdentity = { sourceId: SCORE, sourceEventId: `${SCORE}#not-a-note` };
  assert.deepEqual(identityOnly(leadReport(analyzeWorkspace(forged))), [LEAD_EVIDENCE_IDENTITY_MISMATCH]);
});

test('4: correct sourceEventId under the wrong sourceId is refused', () => {
  const forged = structuredClone(recordLeadEvidence(workspace(), form()));
  forged.leadEvidence[0].sourceIdentity = { sourceId: 'somewhere-else', sourceEventId: `${SCORE}#lead-1` };
  assert.deepEqual(identityOnly(leadReport(analyzeWorkspace(forged))), [LEAD_EVIDENCE_IDENTITY_MISMATCH]);
});

test('5: a missing or emptied identity is refused, and a fabricated one too', () => {
  for (const sourceIdentity of [undefined, null, {}, { sourceId: SCORE }, { sourceId: '', sourceEventId: '' }]) {
    const forged = structuredClone(recordLeadEvidence(workspace(), form()));
    forged.leadEvidence[0].sourceIdentity = sourceIdentity;
    assert.deepEqual(identityOnly(leadReport(analyzeWorkspace(forged))), ['SOURCE_IDENTITY_MISSING'], JSON.stringify(sourceIdentity));
  }
  const fabricated = structuredClone(recordLeadEvidence(workspace(), form()));
  fabricated.leadEvidence[0].sourceIdentity = { sourceId: 'anything', sourceEventId: 'anything' };
  assert.deepEqual(identityOnly(leadReport(analyzeWorkspace(fabricated))), [LEAD_EVIDENCE_IDENTITY_MISMATCH]);
});

test('6: a multi-source baseline event fails closed on pairing whatever the stored citation says', () => {
  for (const sourceIdentity of [
    { sourceId: SCORE, sourceEventId: `${SCORE}#lead-1` },   // apparently correct
    { sourceId: MIDI, sourceEventId: 'track:1/event:7' },      // apparently correct
    { sourceId: SCORE, sourceEventId: 'track:1/event:7' },     // cross-paired
  ]) {
    const forged = structuredClone(recordLeadEvidence(workspace({ multi: true }), form()));
    forged.leadEvidence[0].sourceIdentity = sourceIdentity;
    const report = analyzeWorkspace(forged);
    assert.equal(leadReport(report).status, 'PENDING');
    assert.deepEqual(identityOnly(leadReport(report)), [LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS], JSON.stringify(sourceIdentity));
    assert.equal(report.readiness.gates.leadDemotion.status, 'PENDING');
  }
});

test('a record naming an event that is not in the baseline is a PENDING report, not a thrown analysis', () => {
  const forged = structuredClone(recordLeadEvidence(workspace(), form()));
  forged.leadEvidence[0].eventId = 'ghost';
  const report = analyzeWorkspace(forged);
  const ghost = report.leadReports.find(item => item.eventId === 'ghost');
  assert.deepEqual([...ghost.blockers], ['LEAD_EVIDENCE_EVENT_NOT_IN_BASELINE']);
  assert.equal(report.readiness.gates.leadDemotion.status, 'PENDING', 'lead-1 still has no report');
  // And a record the gate cannot read is reported the same way.
  const broken = structuredClone(recordLeadEvidence(workspace(), form()));
  broken.leadEvidence[0].sectionRole = 'not-a-section';
  const brokenReport = leadReport(analyzeWorkspace(broken));
  assert.equal(brokenReport.status, 'PENDING');
  assert.match(brokenReport.blockers[0], /^LEAD_DEMOTION_EVIDENCE_INVALID/);
});

test('a revision bump and a portable import both drop stored Lead evidence', () => {
  const next = recordLeadEvidence(workspace(), form());
  assert.deepEqual(invalidate(next).leadEvidence, []);
  const imported = importWorkspace(JSON.stringify({ ...next, schema: WORKSPACE_SCHEMA }));
  assert.deepEqual(imported.leadEvidence, []);
});

// ─── one binding, two paths, one vocabulary ─────────────────────────────────

test('the G11-D application re-exports the gate\'s own binding, not a copy', () => {
  assert.equal(applicationBinding, gateBinding, 'a second implementation is the drift the shared boundary rules out');
  assert.equal(APPLICATION_MISMATCH, LEAD_EVIDENCE_IDENTITY_MISMATCH);
});

test('8: the pre-G11-D Web path and the G11-D path return the same identity blockers for the same citation', () => {
  const baseline = project('fixture:baseline');
  const foreignIdentity = { sourceId: SCORE, sourceEventId: `${SCORE}#lead-2` };
  const evidence = {
    sourceIdentity: foreignIdentity,
    sectionRole: 'vocal-active',
    scoreEvidence: { availability: 'available', classification: 'inner', citation: 'score: inner staff' },
    audioEvidence: { availability: 'available', classification: 'background', citation: 'audio: behind the vocal' },
    continuity: { checked: true, createsLeadGap: false, replacementEventIds: [] },
    core3: { checked: true, status: 'PASS' },
    positiveReason: 'inner staff, behind the vocal',
  };

  // Web path: the stored record's citation is lead-2's.
  const forged = structuredClone(recordLeadEvidence(workspace(), form()));
  forged.leadEvidence[0].sourceIdentity = foreignIdentity;
  const web = identityOnly(leadReport(analyzeWorkspace(forged)));

  // G11-D path: an accepted demotion of lead-1 carrying the same citation.
  const application = applyAcceptedArrangement({
    baseline, canonicalIdentity: CANONICAL_IDENTITY,
    decisions: [{
      id: 'd1', type: 'MOVE_ROLE', target: { eventIds: ['lead-1'] }, fromRole: 'Melody', toRole: 'Chord3',
      reason: 'Reviewed: inner staff.', evidence: ['score'], leadEvidence: evidence, acceptance: acceptanceFor(baseline),
    }],
  });
  assert.equal(application.status, 'PENDING');
  const g11d = application.rejected.find(item => item.code === DECISION_REJECTION.LEAD_DEMOTION_EVIDENCE_REQUIRED).events[0].blockers;

  // And the gate called directly.
  const direct = identityOnly(evaluateLeadDemotion({ ...evidence, event: baseline.events.find(item => item.id === 'lead-1'), destinationRole: 'Chord3' }));

  assert.deepEqual(web, [LEAD_EVIDENCE_IDENTITY_MISMATCH]);
  assert.deepEqual([...g11d], [LEAD_EVIDENCE_IDENTITY_MISMATCH]);
  assert.deepEqual(direct, [LEAD_EVIDENCE_IDENTITY_MISMATCH]);
  assert.deepEqual(sourceIdentityBlockers(foreignIdentity, baseline.events[0]), [LEAD_EVIDENCE_IDENTITY_MISMATCH]);
});
