// Studio Web — the Lead promotion evidence path.
//
// Web had a Lead *demotion* evidence path only: `recordLeadEvidence` requires
// the source event to be a baseline Melody event and refuses a Melody
// destination, and the analysis graded every stored record with
// `evaluateLeadDemotion`. The shared `leadPromotion` readiness gate was already
// wired into the Web gate grid, so a lawful non-Melody -> Melody candidate left
// an unclearable blocker: the gate asked for evidence the browser app had no
// way to supply.
//
// These regressions drive the new promotion path through the real model, and
// pin the three things that keep it a gate rather than a checkbox: it reuses
// the SAME shared grader, a generic Lead review PASS cannot stand in for it,
// and a record stops counting when what it describes changes.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalTempoEvent,
  createCanonicalMeterEvent,
  createCanonicalProject,
} from '../backend/canonical/index.mjs';
import { evaluateLeadPromotion } from '../backend/arbitration/lead-demotion.mjs';
import {
  intake,
  newWorkspace,
  analyzeWorkspace,
  recordLeadEvidence,
  recordLeadPromotionEvidence,
  recordReview,
  invalidate,
} from '../web/model.mjs';

const SCORE = 'official-score';
const MIDI = 'third-party-midi';
const settings = { meterText: '0 4/4', recording: 'synthetic', offset: '0', end: '4', audioRequired: 'no', preview: 'none' };

const note = (id, pitch, start, end, role, { sourceIds = [SCORE], sourceEventIds = [`${SCORE}#${id}`], metadata = {} } = {}) =>
  createCanonicalNoteEvent({ id, pitch, start, end, sourceIds, sourceEventIds, role, metadata });

function project(id, events) {
  return createCanonicalProject({
    id,
    title: 'Web Lead promotion fixture',
    sources: [
      createSource({ id: SCORE, label: 'score', kind: 'official-musicxml', authority: 'primary-symbolic' }),
      createSource({ id: MIDI, label: 'midi', kind: 'third-party-midi', authority: 'supporting' }),
    ],
    events,
    tempoEvents: [createCanonicalTempoEvent({ id: 'tempo-1', beat: '0', bpm: 120, sourceIds: [SCORE] })],
    meterEvents: [createCanonicalMeterEvent({ id: 'meter-1', beat: '0', numerator: 4, denominator: 4, sourceIds: [SCORE] })],
    metadata: { sourceComplete: true },
  });
}

const baselineEvents = ({ multi = false } = {}) => [
  note('lead-1', 74, '1', '2', 'Melody'),
  note('harm-1', 64, '0', '2', 'Chord1'),
  note('bass-1', 48, '0', '2', 'Chord2'),
  multi
    ? note('tex-1', 72, '0', '1', 'Chord3', { sourceIds: [SCORE, MIDI], sourceEventIds: [`${SCORE}#tex-1`, 'track:1/event:7'] })
    : note('tex-1', 72, '0', '1', 'Chord3'),
];

// The candidate promotes `tex-1` from Chord3 into Melody. The baseline diff
// therefore reports a role move into Melody, and the shared readiness gate
// requires promotion evidence for it.
const candidateEvents = ({ multi = false, extra = [], leadPitch = 72 } = {}) => [
  note('lead-1', 74, '1', '2', 'Melody'),
  note('harm-1', 64, '0', '2', 'Chord1'),
  note('bass-1', 48, '0', '2', 'Chord2'),
  multi
    ? note('tex-1', leadPitch, '0', '1', 'Melody', { sourceIds: [SCORE, MIDI], sourceEventIds: [`${SCORE}#tex-1`, 'track:1/event:7'] })
    : note('tex-1', leadPitch, '0', '1', 'Melody'),
  ...extra,
];

const asset = (name, value) => intake({ name, content: JSON.stringify(value), id: name });

function workspace(options = {}) {
  return {
    ...newWorkspace(),
    title: 'fixture',
    settings,
    assets: {
      baseline: asset('baseline.json', project('fixture:baseline', baselineEvents(options))),
      candidate: asset('candidate.json', project('fixture:candidate', candidateEvents(options))),
    },
  };
}

const form = overrides => ({
  promotedEventId: 'tex-1',
  sectionRole: 'instrumental',
  scoreClass: 'lead',
  scoreCitation: 'score: top staff, bar 1',
  audioClass: 'foreground',
  audioCitation: 'audio: 0:00-0:01 in front of the accompaniment',
  positiveReason: 'The score places this attack on the top staff and the mix carries it in front.',
  continuity: 'checked',
  ...overrides,
});

const promotionReport = (report, id = 'tex-1') => report.leadPromotionReports.find(item => item.eventId === id);

// ─── the record is constructed behind the Worker, never by the page ─────────

test('recordLeadPromotionEvidence binds the record to the candidate Melody event and its baseline origin', () => {
  const next = recordLeadPromotionEvidence(workspace(), form());
  assert.equal(next.leadPromotionEvidence.length, 1);
  const record = next.leadPromotionEvidence[0];
  assert.equal(record.promotedEventId, 'tex-1');
  assert.equal(record.originEventId, 'tex-1');
  assert.equal(record.destinationRole, 'Melody');
  assert.deepEqual(record.sourceIdentity, { sourceId: SCORE, sourceEventId: `${SCORE}#tex-1` });
  assert.equal(record.revision, 0);
  assert.equal(next.acceptance, null);
  // Re-recording the same event replaces, never duplicates.
  assert.equal(recordLeadPromotionEvidence(next, form({ sectionRole: 'solo' })).leadPromotionEvidence.length, 1);
});

test('recordLeadPromotionEvidence refuses what is not a promotion', () => {
  // Not a Melody event in the candidate.
  assert.throws(() => recordLeadPromotionEvidence(workspace(), form({ promotedEventId: 'harm-1' })), /候選 Melody event/);
  assert.throws(() => recordLeadPromotionEvidence(workspace(), form({ promotedEventId: 'nope' })), /候選 Melody event/);
  // A destination other than Melody belongs to the demotion path.
  assert.throws(() => recordLeadPromotionEvidence(workspace(), form({ destinationRole: 'Chord1' })), /Melody/);
  // The origin was already the Lead, so nothing was promoted.
  assert.throws(() => recordLeadPromotionEvidence(workspace(), form({ promotedEventId: 'lead-1' })), /已是 Melody/);
  // No baseline means nothing to bind an origin to.
  assert.throws(() => recordLeadPromotionEvidence({ ...workspace(), assets: {} }, form()), /Baseline/);
});

test('recordLeadPromotionEvidence never index-pairs a multi-source origin', () => {
  const next = recordLeadPromotionEvidence(workspace({ multi: true }), form());
  assert.equal(next.leadPromotionEvidence[0].sourceIdentity, null, 'no pairing can be proven, so none is written');
  const report = promotionReport(analyzeWorkspace(next));
  assert.equal(report.status, 'PENDING');
  assert.ok(report.blockers.includes('LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS'));
});

// ─── the shared grader, and only the shared grader ──────────────────────────

test('a complete Web promotion record reaches shared readiness as a PASS', () => {
  const analysed = analyzeWorkspace(recordLeadPromotionEvidence(workspace(), form()));
  const report = promotionReport(analysed);
  assert.equal(report.status, 'PASS');
  assert.equal(report.originEventId, 'tex-1');
  assert.deepEqual([...report.blockers], []);

  // The verdict is the shared gate's own, byte for byte on every field it owns.
  const direct = evaluateLeadPromotion({
    sourceIdentity: { sourceId: SCORE, sourceEventId: `${SCORE}#tex-1` },
    sectionRole: 'instrumental',
    scoreEvidence: { availability: 'available', classification: 'lead', citation: 'score: top staff, bar 1' },
    audioEvidence: { availability: 'available', classification: 'foreground', citation: 'audio: 0:00-0:01 in front of the accompaniment' },
    continuity: { checked: true, createsLeadGap: false, replacementEventIds: [] },
    core3: { checked: true, status: 'PASS' },
    positiveReason: 'The score places this attack on the top staff and the mix carries it in front.',
    event: { ...baselineEvents()[3] },
    destinationRole: 'Melody',
  });
  assert.equal(direct.status, report.status);
  assert.deepEqual(direct.evidence.score, report.evidence.score);
  assert.deepEqual(direct.evidence.audio, report.evidence.audio);

  assert.equal(analysed.readiness.gates.leadPromotion.status, 'PASS');
  assert.equal(analysed.blockers.includes('leadPromotion'), false);
});

test('without the record the promotion gate blocks, and a generic Lead review does not clear it', () => {
  const bare = analyzeWorkspace(workspace());
  assert.equal(bare.readiness.gates.leadPromotion.status, 'PENDING');
  assert.ok(bare.readiness.gates.leadPromotion.blockers.includes('LEAD_PROMOTION_EVIDENCE_REQUIRED'));
  assert.ok(bare.blockers.includes('leadPromotion'));

  // The Web `lead` review is a different axis: it records that a human looked
  // at Lead phrasing, rests and hand-offs. It is not event-bound evidence about
  // one promotion, and it must not stand in for the promotion gate.
  const reviewed = analyzeWorkspace(recordReview(workspace(), 'lead', 'Lead 樂句與接棒已逐段核對。', 'score bars 1-8'));
  assert.equal(reviewed.gates.lead.status, 'PASS', 'the generic Lead review does pass');
  assert.equal(reviewed.readiness.gates.leadPromotion.status, 'PENDING', 'and the promotion gate still blocks');
  assert.ok(reviewed.blockers.includes('leadPromotion'));

  // A demotion record for the same event is not a promotion record either.
  assert.throws(() => recordLeadEvidence(workspace(), { eventId: 'tex-1', destinationRole: 'Chord1', sectionRole: 'instrumental', continuity: 'checked' }), /Melody/);
});

test('incomplete positive evidence stays PENDING instead of becoming a PASS', () => {
  for (const [label, overrides] of [
    ['no score or audio Lead classification', { scoreClass: 'inner', audioClass: 'background' }],
    ['an unresolved section role', { sectionRole: 'unknown' }],
    ['no positive destination reason', { positiveReason: '' }],
    ['continuity and Core3 unchecked', { continuity: 'unknown' }],
  ]) {
    const report = promotionReport(analyzeWorkspace(recordLeadPromotionEvidence(workspace(), form(overrides))));
    assert.equal(report.status, 'PENDING', label);
    assert.ok(report.blockers.length > 0, label);
  }
});

// ─── staleness: a record stops counting when what it describes changes ──────

test('a promotion record does not survive a new revision', () => {
  const recorded = recordLeadPromotionEvidence(workspace(), form());
  assert.equal(analyzeWorkspace(recorded).readiness.gates.leadPromotion.status, 'PASS');

  // Re-loading sources moves the revision; every evidence record is bound to
  // the revision it was recorded against and is dropped with it.
  const next = invalidate(recorded);
  assert.deepEqual(next.leadPromotionEvidence, []);
  assert.equal(analyzeWorkspace(next).readiness.gates.leadPromotion.status, 'PENDING');
});

test('a record whose candidate no longer shows the promotion is reported, never silently kept', () => {
  const recorded = recordLeadPromotionEvidence(workspace(), form());
  // The candidate is edited so tex-1 is back in Chord3: nothing was promoted,
  // so the stored record describes a move that is not there.
  const withdrawn = {
    ...recorded,
    assets: {
      ...recorded.assets,
      candidate: asset('candidate.json', project('fixture:candidate', [
        note('lead-1', 74, '1', '2', 'Melody'),
        note('harm-1', 64, '0', '2', 'Chord1'),
        note('bass-1', 48, '0', '2', 'Chord2'),
        note('tex-1', 72, '0', '1', 'Chord3'),
      ])),
    },
  };
  const report = promotionReport(analyzeWorkspace(withdrawn));
  assert.equal(report.status, 'PENDING');
  assert.deepEqual([...report.blockers], ['LEAD_PROMOTION_EVENT_NOT_IN_CANDIDATE']);
});

test('a record whose promoted event changed pitch goes back to PENDING', () => {
  // The citation is bound to the baseline origin's provenance. If the candidate
  // event it is keyed to is no longer the note that origin describes, the
  // citation is about something that is not there, and a stale PASS about a
  // different note is exactly what must not happen.
  const moved = recordLeadPromotionEvidence(workspace(), form());
  moved.assets = {
    ...moved.assets,
    candidate: asset('candidate.json', project('fixture:candidate', candidateEvents({ leadPitch: 79 }))),
  };
  const report = promotionReport(analyzeWorkspace(moved));
  assert.equal(report.status, 'PENDING');
  assert.deepEqual([...report.blockers], ['LEAD_EVIDENCE_EVENT_CHANGED']);
});

// ─── derived duplicates keep their origin chain ─────────────────────────────

test('a duplicate promoted into Melody is graded under its derived id and its baseline origin', () => {
  // The G11-D shape: `harm-1` stays in Chord1 and a derived copy of it carries
  // the Lead. The derived id is not a source event id, so the citation binds to
  // the origin `harm-1` through the reversible chain.
  // A derived duplicate carries its origin's provenance -- that is what makes
  // the citation bindable at all -- while its own id lives in another namespace.
  const derived = note('harm-1#dup', 64, '0', '2', 'Melody', {
    sourceIds: [SCORE],
    sourceEventIds: [`${SCORE}#harm-1`],
    metadata: { g11d: { derivedFromEventId: 'harm-1' } },
  });
  const workspaceWithDuplicate = {
    ...newWorkspace(),
    title: 'fixture',
    settings,
    assets: {
      baseline: asset('baseline.json', project('fixture:baseline', baselineEvents())),
      candidate: asset('candidate.json', project('fixture:candidate', [
        note('lead-1', 74, '1', '2', 'Melody'),
        note('harm-1', 64, '0', '2', 'Chord1'),
        note('bass-1', 48, '0', '2', 'Chord2'),
        note('tex-1', 72, '0', '1', 'Chord3'),
        derived,
      ])),
    },
  };

  const recorded = recordLeadPromotionEvidence(workspaceWithDuplicate, form({ promotedEventId: 'harm-1#dup' }));
  const record = recorded.leadPromotionEvidence[0];
  assert.equal(record.promotedEventId, 'harm-1#dup');
  assert.equal(record.originEventId, 'harm-1', 'the origin is resolved through the derived chain, not guessed');
  assert.deepEqual(record.sourceIdentity, { sourceId: SCORE, sourceEventId: `${SCORE}#harm-1` });

  const analysed = analyzeWorkspace(recorded);
  const report = promotionReport(analysed, 'harm-1#dup');
  assert.equal(report.status, 'PASS');
  assert.equal(report.originEventId, 'harm-1');
  assert.equal(analysed.readiness.gates.leadPromotion.status, 'PASS');
});

test('a derived id whose chain does not reach the baseline is refused at record time', () => {
  const orphan = note('orphan#dup', 64, '0', '2', 'Melody', { sourceIds: [SCORE], sourceEventIds: [`${SCORE}#harm-1`], metadata: { g11d: { derivedFromEventId: 'not-a-baseline-event' } } });
  const broken = {
    ...newWorkspace(),
    title: 'fixture',
    settings,
    assets: {
      baseline: asset('baseline.json', project('fixture:baseline', baselineEvents())),
      candidate: asset('candidate.json', project('fixture:candidate', [...candidateEvents(), orphan])),
    },
  };
  assert.throws(() => recordLeadPromotionEvidence(broken, form({ promotedEventId: 'orphan#dup' })), /Source-Faithful Baseline/);
});

// ─── the Web plane's own re-review path ─────────────────────────────────────
//
// The Agent plane needed a new operation for this: there, evidence lives in the
// `applied[]` of the revision that performed the move, so a later revision that
// changed the Lead picture left a citation that could not be re-supplied --
// G11-D refuses to re-apply a move that already happened.
//
// Studio Web does not have that problem, and this pins why rather than leaving
// it as an assumption: both evidence arrays are read only while the record names
// the CURRENT revision, and both writers replace by event id. So a new revision
// asks for the evidence again, and re-recording through the same form is the
// answer. The two planes reach the same place -- a citation must describe the
// arrangement being graded -- by different routes, and neither carries a
// previous PASS forward.

test('Web Lead evidence is read only for the current revision, so a new revision asks again', () => {
  const recorded = recordLeadPromotionEvidence(workspace(), form());
  assert.equal(recorded.leadPromotionEvidence[0].revision, 0);
  assert.equal(promotionReport(analyzeWorkspace(recorded)).status, 'PASS');

  // A new revision. The record is still on the workspace for the audit trail,
  // and is no longer read.
  const advanced = { ...recorded, revision: recorded.revision + 1 };
  assert.equal(advanced.leadPromotionEvidence.length, 1);
  const stale = analyzeWorkspace(advanced);
  assert.equal(stale.leadPromotionReports.length, 0, 'a record from an earlier revision feeds no report');
  assert.equal(stale.readiness.gates.leadPromotion.status, 'PENDING');

  // Re-recording through the same form is the re-review, and it is graded by
  // the shared promotion gate again rather than restored from the old record.
  const again = recordLeadPromotionEvidence(advanced, form());
  assert.equal(again.leadPromotionEvidence.length, 1, 'the superseded record is replaced, not accumulated');
  assert.equal(again.leadPromotionEvidence[0].revision, 1);
  assert.equal(promotionReport(analyzeWorkspace(again)).status, 'PASS');
  assert.equal(analyzeWorkspace(again).readiness.gates.leadPromotion.status, 'PASS');
});
