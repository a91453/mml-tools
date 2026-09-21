import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAcceptedArrangement,
  createArrangementRevision,
  revisionIdentityMatches,
  baselineIdentityOf,
  laneDecompositionDigestOf,
  DECISION_REJECTION,
  CONFLICT_CODES,
} from '../backend/arrangement/decision-application.mjs';
import { suggestRoleCandidates } from '../backend/arrangement/role-candidates.mjs';
import { leadPromotionReportsFromApplication } from '../backend/arrangement/decision-review.mjs';
import {
  roleDeclaredBaseline,
  acceptanceFor,
  leadDemotionEvidence,
  CANONICAL_IDENTITY,
  SOURCE_ID,
  rotate,
} from './fixtures/g11d-fixtures.mjs';

// Stale-decision protection, optimistic concurrency, conflict handling and the
// transactional guarantee.
//
// Everything in this file is about refusing to apply. A decision that was
// reviewed against different inputs, a set that disagrees with itself, and a
// batch with one illegal member must all leave the reviewer with no candidate
// at all -- not a partial one, and never one assembled by picking a winner.

const baseline = roleDeclaredBaseline();
const suggestion = suggestRoleCandidates(baseline);
const identity = baselineIdentityOf(baseline);
const laneDigest = laneDecompositionDigestOf(suggestion);

const accept = (overrides = {}) => ({ ...acceptanceFor(baseline, { suggestion }), ...overrides });

const assign = (id, eventIds, toRole, overrides = {}) => ({
  id,
  type: 'ASSIGN_ROLE',
  target: { eventIds },
  toRole,
  reason: `Fixture: ${toRole} by explicit review.`,
  evidence: ['fixture:score'],
  acceptance: accept(),
  ...overrides,
});

const move = (id, eventIds, fromRole, toRole, overrides = {}) => ({
  id,
  type: 'MOVE_ROLE',
  target: { eventIds },
  fromRole,
  toRole,
  reason: `Fixture: ${fromRole} -> ${toRole} by explicit review.`,
  evidence: ['fixture:score'],
  acceptance: accept(),
  ...overrides,
});

const apply = (decisions, extra = {}) => applyAcceptedArrangement({
  baseline, suggestion, decisions, canonicalIdentity: CANONICAL_IDENTITY, ...extra,
});

const refusesEverything = result => {
  assert.equal(result.candidate, null, 'a refused set produces no candidate');
  assert.equal(result.revision, null, 'a refused set mints no revision');
  assert.deepEqual([...result.applied], [], 'a refused set applies nothing');
  assert.deepEqual([...result.trace], [], 'a refused set traces nothing');
  assert.equal(result.immutability.baselineUnchanged, true);
};

// ─── staleness ──────────────────────────────────────────────────────────────

test('a decision bound to a superseded candidate revision is refused', () => {
  const stale = apply([move('m1', ['harm-1'], 'Chord1', 'Chord3', {
    acceptance: accept({ reviewedRevisionId: 'g11d:rev:0000000000000000000000000000000000000000000000000000000000000000' }),
  })]);
  assert.equal(stale.status, 'FAIL');
  assert.equal(stale.requiresFreshReview, true);
  assert.equal(stale.stale[0].code, DECISION_REJECTION.STALE_DECISION_REVISION_MISMATCH);
  refusesEverything(stale);
});

test('a decision reviewed against the baseline cannot be replayed onto a later revision', () => {
  const first = apply([assign('a1', ['tex-1', 'tex-2'], 'Chord3')]);
  assert.equal(first.status, 'PASS');

  // Identical decision, still bound to `reviewedRevisionId: null`, replayed
  // against revision 1. The lane id is the same and the event ids are the same;
  // only the revision it was reviewed against has moved.
  const replay = apply([move('m1', ['tex-1'], 'Chord3', 'Chord4')], {
    parent: { revision: first.revision, candidate: first.candidate },
  });
  assert.equal(replay.status, 'FAIL');
  assert.equal(replay.stale[0].code, DECISION_REJECTION.STALE_DECISION_REVISION_MISMATCH);
  assert.equal(replay.stale[0].expected, first.revision.id);
  refusesEverything(replay);

  // Re-accepted against the revision the reviewer actually saw, it applies.
  const fresh = applyAcceptedArrangement({
    baseline,
    suggestion,
    canonicalIdentity: CANONICAL_IDENTITY,
    parent: { revision: first.revision, candidate: first.candidate },
    decisions: [move('m1', ['tex-1'], 'Chord3', 'Chord4', {
      acceptance: accept({ reviewedRevisionId: first.revision.id }),
    })],
  });
  assert.equal(fresh.status, 'PASS');
  assert.equal(fresh.revision.parentRevisionId, first.revision.id);
  assert.equal(fresh.revision.index, 2);
});

test('a decision bound to a different baseline or source identity is refused', () => {
  const changedBaseline = apply([assign('a1', ['tex-1'], 'Chord3', {
    acceptance: accept({ baselineContentDigest: 'f'.repeat(64) }),
  })]);
  assert.equal(changedBaseline.status, 'FAIL');
  assert.equal(changedBaseline.stale[0].code, DECISION_REJECTION.STALE_DECISION_BASELINE_CHANGED);
  refusesEverything(changedBaseline);

  const changedSource = apply([assign('a1', ['tex-1'], 'Chord3', {
    acceptance: accept({ sourceIdentityDigest: 'a'.repeat(64) }),
  })]);
  assert.equal(changedSource.status, 'FAIL');
  assert.ok(changedSource.stale.some(item => item.code === DECISION_REJECTION.STALE_DECISION_SOURCE_CHANGED));
  refusesEverything(changedSource);
});

test('a real baseline edit invalidates every decision accepted against the old one', () => {
  // Same event ids, one different pitch: the kind of change a re-ingest of
  // corrected source bytes produces. The decision still names events that
  // exist, so only the content binding can catch it.
  const edited = roleDeclaredBaseline();
  const mutated = {
    ...edited,
    events: edited.events.map(event => (event.id === 'tex-1' ? { ...event, pitch: 61 } : event)),
  };
  const result = applyAcceptedArrangement({
    baseline: mutated,
    suggestion,
    canonicalIdentity: CANONICAL_IDENTITY,
    decisions: [assign('a1', ['tex-1'], 'Chord3')],
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.stale[0].code, DECISION_REJECTION.STALE_DECISION_BASELINE_CHANGED);
  refusesEverything(result);
});

test('a decision bound to a different Canonical release is refused', () => {
  const result = apply([assign('a1', ['tex-1'], 'Chord3', {
    acceptance: accept({ canonicalRulesSnapshotSha: 'b'.repeat(40) }),
  })]);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.stale[0].code, DECISION_REJECTION.STALE_DECISION_CANONICAL_CHANGED);
  assert.equal(result.requiresFreshReview, true);
  refusesEverything(result);
});

test('a lane-targeted decision does not silently retarget when the decomposition changes', () => {
  // A decomposition whose lane ids are identical but whose membership is not.
  const otherSuggestion = suggestRoleCandidates(roleDeclaredBaseline({ extraSource: true }));
  assert.notEqual(laneDecompositionDigestOf(otherSuggestion), laneDigest, 'the fixture must actually change the decomposition digest');

  const result = applyAcceptedArrangement({
    baseline,
    suggestion: otherSuggestion,
    canonicalIdentity: CANONICAL_IDENTITY,
    decisions: [{
      id: 'l1',
      type: 'ASSIGN_ROLE',
      target: { laneId: 'lane:texture#0' },
      toRole: 'Chord3',
      reason: 'Fixture: texture lane accepted as enrichment.',
      evidence: ['fixture:score'],
      acceptance: accept(),
    }],
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.stale[0].code, DECISION_REJECTION.STALE_DECISION_LANE_DECOMPOSITION_CHANGED);
  refusesEverything(result);
});

test('a decision naming an event that does not exist fails closed', () => {
  const result = apply([assign('a1', ['tex-1', 'ghost-9'], 'Chord3')]);
  assert.equal(result.status, 'FAIL');
  const rejection = result.rejected.find(item => item.code === DECISION_REJECTION.TARGET_EVENT_NOT_FOUND);
  assert.deepEqual([...rejection.missingEventIds], ['ghost-9']);
  refusesEverything(result);
});

test('a lane target whose events are no longer all present fails closed rather than shrinking', () => {
  const first = apply([{
    id: 'o1',
    type: 'OMIT_FROM_SIX',
    target: { eventIds: ['tex-2'] },
    reason: 'Fixture: this texture note is not carried into the six roles.',
    evidence: ['fixture:score'],
    acceptance: accept(),
  }]);
  assert.equal(first.status, 'PASS');

  const second = applyAcceptedArrangement({
    baseline,
    suggestion,
    canonicalIdentity: CANONICAL_IDENTITY,
    parent: { revision: first.revision, candidate: first.candidate },
    decisions: [{
      id: 'l1',
      type: 'ASSIGN_ROLE',
      target: { laneId: 'lane:texture#0' },
      toRole: 'Chord3',
      reason: 'Fixture: texture lane accepted as enrichment.',
      evidence: ['fixture:score'],
      acceptance: accept({ reviewedRevisionId: first.revision.id }),
    }],
  });
  assert.equal(second.status, 'FAIL');
  const rejection = second.rejected.find(item => item.code === DECISION_REJECTION.LANE_TARGET_EVENTS_NOT_IN_PARENT);
  assert.deepEqual([...rejection.missingEventIds], ['tex-2']);
  refusesEverything(second);
});

// ─── parent tampering ───────────────────────────────────────────────────────

test('a parent revision record whose fields were edited no longer hashes to its own id', () => {
  const first = apply([assign('a1', ['tex-1', 'tex-2'], 'Chord3')]);
  assert.equal(revisionIdentityMatches(first.revision), true);

  for (const patch of [
    { index: 9 },
    { parentRevisionId: 'g11d:rev:forged' },
    { decisionSetDigest: 'c'.repeat(64) },
    { candidateDigest: 'd'.repeat(64) },
    { baselineIdentity: { ...first.revision.baselineIdentity, contentDigest: 'e'.repeat(64) } },
    { canonicalIdentity: { ...first.revision.canonicalIdentity, rules_snapshot_sha: 'f'.repeat(40) } },
  ]) {
    const forged = { ...first.revision, ...patch };
    assert.equal(revisionIdentityMatches(forged), false, `${Object.keys(patch)[0]} must break the revision identity`);
    const result = apply([assign('a2', ['harm-1'], 'Chord3')], { parent: { revision: forged, candidate: first.candidate } });
    assert.equal(result.status, 'FAIL');
    assert.ok(result.rejected.some(item => item.code === 'PARENT_REVISION_IDENTITY_TAMPERED' || item.code.startsWith('PARENT_')));
    refusesEverything(result);
  }
});

test('a parent candidate that is not the one the revision describes is refused', () => {
  const first = apply([assign('a1', ['tex-1', 'tex-2'], 'Chord3')]);
  const swapped = { ...first.candidate, events: first.candidate.events.filter(event => event.id !== 'tex-2') };
  const result = apply([move('m1', ['tex-1'], 'Chord3', 'Chord4', { acceptance: accept({ reviewedRevisionId: first.revision.id }) })], {
    parent: { revision: first.revision, candidate: swapped },
  });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.rejected.some(item => item.code === 'PARENT_CANDIDATE_DIGEST_MISMATCH'));
  refusesEverything(result);
});

test('a revision that claims a different baseline cannot be used as a parent', () => {
  const first = apply([assign('a1', ['tex-1'], 'Chord3')]);
  const otherBaseline = roleDeclaredBaseline({ id: 'fixture:other-baseline' });
  const result = applyAcceptedArrangement({
    baseline: otherBaseline,
    suggestion,
    canonicalIdentity: CANONICAL_IDENTITY,
    parent: { revision: first.revision, candidate: first.candidate },
    decisions: [move('m1', ['tex-1'], 'Chord3', 'Chord4', { acceptance: acceptanceFor(otherBaseline, { suggestion, reviewedRevisionId: first.revision.id }) })],
  });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.rejected.some(item => item.code === 'PARENT_BASELINE_MISMATCH'));
});

test('a parent revision made under a different Canonical release cannot be chained onto', () => {
  const first = apply([assign('a1', ['tex-1'], 'Chord3')]);
  // A revision that is internally honest -- it recomputes to its own id, names
  // this baseline and this candidate -- but was produced under another rules
  // snapshot. Only the Canonical binding stands between it and revision 2.
  const otherCanonical = { ...CANONICAL_IDENTITY, rules_snapshot_sha: 'f'.repeat(40) };
  const foreignRevision = createArrangementRevision({
    index: first.revision.index,
    parentRevisionId: null,
    baselineIdentity: first.revision.baselineIdentity,
    parentCandidateIdentity: null,
    decisionSetDigest: first.revision.decisionSetDigest,
    canonicalIdentity: otherCanonical,
    laneDecompositionDigest: first.revision.laneDecompositionDigest,
    candidateDigest: first.revision.candidateDigest,
  });
  assert.equal(revisionIdentityMatches(foreignRevision), true);
  const result = applyAcceptedArrangement({
    baseline, suggestion, canonicalIdentity: CANONICAL_IDENTITY,
    parent: { revision: foreignRevision, candidate: first.candidate },
    decisions: [move('m1', ['tex-1'], 'Chord3', 'Chord4', { acceptance: accept({ reviewedRevisionId: foreignRevision.id }) })],
  });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.rejected.some(item => item.code === 'PARENT_CANONICAL_MISMATCH'));
  assert.equal(result.candidate, null);
});

test('two decisions sharing an id are refused rather than deduplicated', () => {
  const result = apply([assign('a1', ['tex-1'], 'Chord3'), assign('a1', ['tex-2'], 'Chord4')]);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.rejected.some(item => item.code === DECISION_REJECTION.DUPLICATE_DECISION_ID));
  refusesEverything(result);
});

// ─── conflicts ──────────────────────────────────────────────────────────────

const conflictCases = [
  {
    name: 'two moves of one event to different roles',
    code: CONFLICT_CODES.MULTIPLE_DISPOSITIONS,
    decisions: [move('c1', ['harm-1'], 'Chord1', 'Chord3'), move('c2', ['harm-1'], 'Chord1', 'Chord4')],
  },
  {
    name: 'keep and omit on one event',
    code: CONFLICT_CODES.DISPOSITION_AND_OMISSION,
    decisions: [
      { id: 'c1', type: 'KEEP', target: { eventIds: ['harm-1'] }, fromRole: 'Chord1', reason: 'Fixture: keep.', evidence: ['fixture:score'], acceptance: accept() },
      { id: 'c2', type: 'OMIT_FROM_SIX', target: { eventIds: ['harm-1'] }, reason: 'Fixture: omit.', evidence: ['fixture:score'], acceptance: accept() },
    ],
  },
  {
    name: 'omit and duplicate on one event',
    code: CONFLICT_CODES.DUPLICATION_OF_OMITTED_EVENT,
    decisions: [
      { id: 'c1', type: 'OMIT_FROM_SIX', target: { eventIds: ['harm-1'] }, reason: 'Fixture: omit.', evidence: ['fixture:score'], acceptance: accept() },
      { id: 'c2', type: 'DUPLICATE_WITH_JUSTIFICATION', target: { eventIds: ['harm-1'] }, toRoles: ['Chord3'], reason: 'Fixture: duplicate.', evidence: ['fixture:score'], acceptance: accept() },
    ],
  },
  {
    name: 'two duplications of one event',
    code: CONFLICT_CODES.MULTIPLE_DUPLICATIONS,
    decisions: [
      { id: 'c1', type: 'DUPLICATE_WITH_JUSTIFICATION', target: { eventIds: ['harm-1'] }, toRoles: ['Chord3'], reason: 'Fixture: duplicate A.', evidence: ['fixture:score'], acceptance: accept() },
      { id: 'c2', type: 'DUPLICATE_WITH_JUSTIFICATION', target: { eventIds: ['harm-1'] }, toRoles: ['Chord4'], reason: 'Fixture: duplicate B.', evidence: ['fixture:score'], acceptance: accept() },
    ],
  },
  {
    name: 'a lane assigned two mutually exclusive roles',
    code: CONFLICT_CODES.MULTIPLE_DISPOSITIONS,
    decisions: [
      { id: 'c1', type: 'ASSIGN_ROLE', target: { laneId: 'lane:texture#0' }, toRole: 'Chord3', reason: 'Fixture: enrichment A.', evidence: ['fixture:score'], acceptance: accept() },
      { id: 'c2', type: 'ASSIGN_ROLE', target: { laneId: 'lane:texture#0' }, toRole: 'Chord4', reason: 'Fixture: enrichment B.', evidence: ['fixture:score'], acceptance: accept() },
    ],
  },
];

for (const scenario of conflictCases) {
  test(`conflict: ${scenario.name} is reported, never resolved`, () => {
    const result = apply(scenario.decisions);
    assert.equal(result.status, 'FAIL');
    refusesEverything(result);
    const conflict = result.conflicts.find(item => item.code === scenario.code);
    assert.ok(conflict, `expected ${scenario.code}, got ${result.conflicts.map(item => item.code).join(', ')}`);
    assert.equal(conflict.resolvedAutomatically, false);
    assert.deepEqual([...conflict.decisionIds], ['c1', 'c2']);
  });

  test(`conflict: ${scenario.name} does not depend on decision order`, () => {
    const forward = apply(scenario.decisions);
    const reverse = apply([...scenario.decisions].reverse());
    assert.equal(forward.status, reverse.status);
    assert.deepEqual(
      reverse.conflicts.map(item => item.id),
      forward.conflicts.map(item => item.id),
      'the same conflicts, identically identified, whichever order they arrive in',
    );
    assert.equal(forward.decisionSetDigest, reverse.decisionSetDigest);
  });
}

test('a duplication may coexist with the one disposition that keeps its event present', () => {
  const result = apply([
    { id: 'k1', type: 'KEEP', target: { eventIds: ['harm-1'] }, fromRole: 'Chord1', reason: 'Fixture: keep as principal harmony.', evidence: ['fixture:score'], acceptance: accept() },
    { id: 'd1', type: 'DUPLICATE_WITH_JUSTIFICATION', target: { eventIds: ['harm-1'] }, toRoles: ['Chord3'], reason: 'Fixture: doubled for enrichment with a cited reason.', evidence: ['fixture:score bar 1 doubling'], acceptance: accept() },
  ]);
  assert.equal(result.status, 'PASS', 'compatibility is explicit, not "whatever did not collide"');
  assert.deepEqual([...result.conflicts], []);
});

// ─── transactional ──────────────────────────────────────────────────────────

test('one illegal decision in a batch of twenty leaves nothing applied', () => {
  const legal = ['tex-1', 'tex-2'].map((eventId, index) => assign(`ok-${index}`, [eventId], 'Chord3'));
  const filler = Array.from({ length: 17 }, (_, index) => ({
    id: `keep-${index}`,
    type: 'KEEP',
    target: { eventIds: [['lead-1', 'lead-2', 'lead-3', 'lead-4', 'harm-1', 'harm-2', 'bass-1', 'bass-2'][index % 8]] },
    reason: 'Fixture: keep as reviewed.',
    evidence: ['fixture:score'],
    acceptance: accept(),
  }));
  // Seventeen of the fillers repeat events, so keep only distinct ones.
  const distinctFiller = filler.filter((item, index, list) =>
    list.findIndex(other => other.target.eventIds[0] === item.target.eventIds[0]) === index);
  const illegal = move('bad', ['harm-1'], 'Chord5', 'Chord3'); // fromRole does not match

  const healthy = apply([...legal, ...distinctFiller]);
  assert.equal(healthy.status, 'PASS', 'the batch without the illegal member must really be applicable');

  for (const at of [0, 3, Math.floor(distinctFiller.length / 2), distinctFiller.length + legal.length]) {
    const batch = [...legal, ...distinctFiller];
    batch.splice(at, 0, illegal);
    const result = apply(batch);
    assert.equal(result.status, 'FAIL', `illegal member at position ${at} must fail the whole set`);
    assert.ok(result.rejected.some(item => item.code === DECISION_REJECTION.PREVIOUS_ROLE_MISMATCH));
    refusesEverything(result);
  }
});

test('a refused set reports the same rejections whatever order it arrived in', () => {
  const decisions = [
    assign('a1', ['tex-1'], 'Chord3'),
    move('m1', ['harm-1'], 'Chord5', 'Chord3'),
    assign('a2', ['ghost'], 'Chord4'),
    move('m2', ['bass-1'], 'Chord2', 'Chord2'),
  ];
  const first = apply(decisions);
  const rotated = apply(rotate(decisions, 3));
  const reversed = apply([...decisions].reverse());
  const shape = result => result.rejected.map(item => `${item.decisionId}|${item.code}`);
  assert.equal(first.status, 'FAIL');
  assert.deepEqual(shape(rotated), shape(first));
  assert.deepEqual(shape(reversed), shape(first));
});

// ─── an accepted decision does not disable the Lead Demotion Gate ───────────

test('a Melody demotion without the evidence chain is PENDING, not applied', () => {
  const bare = apply([move('m1', ['lead-1'], 'Melody', 'Chord3')]);
  assert.equal(bare.status, 'PENDING');
  refusesEverything(bare);
  const rejection = bare.rejected.find(item => item.code === DECISION_REJECTION.LEAD_DEMOTION_EVIDENCE_REQUIRED);
  assert.equal(rejection.events[0].eventId, 'lead-1');
  assert.deepEqual([...rejection.events[0].blockers], ['LEAD_DEMOTION_EVIDENCE_MISSING']);

  // "Not proven Vocal" is not positive evidence, and neither is an accepted
  // decision that simply asserts the destination.
  const unproven = apply([move('m2', ['lead-1'], 'Melody', 'Chord3', {
    leadEvidence: leadDemotionEvidence({ scoreClassification: 'unknown', audioClassification: 'unknown' }),
  })]);
  assert.equal(unproven.status, 'PENDING');
  assert.ok(unproven.rejected[0].events[0].blockers.includes('POSITIVE_ROLE_EVIDENCE_MISSING'));

  // Evidence that still says this material is the lead blocks the demotion.
  const conflicting = apply([move('m3', ['lead-1'], 'Melody', 'Chord3', {
    leadEvidence: leadDemotionEvidence({ scoreClassification: 'lead' }),
  })]);
  assert.equal(conflicting.status, 'PENDING');
  assert.ok(conflicting.rejected[0].events[0].blockers.includes('SOURCE_ROLE_EVIDENCE_CONFLICT'));

  // A demotion that would open a Lead gap is blocked even with role evidence.
  const gap = apply([move('m4', ['lead-1'], 'Melody', 'Chord3', {
    leadEvidence: leadDemotionEvidence({ createsLeadGap: true }),
  })]);
  assert.equal(gap.status, 'PENDING');
  assert.ok(gap.rejected[0].events[0].blockers.includes('LEAD_GAP_CREATED'));
});

test('omitting a Melody event is a Lead demotion too', () => {
  const result = apply([{
    id: 'o1',
    type: 'OMIT_FROM_SIX',
    target: { eventIds: ['lead-2'] },
    fromRole: 'Melody',
    reason: 'Fixture: dropped from the six roles.',
    evidence: ['fixture:score'],
    acceptance: accept(),
  }]);
  assert.equal(result.status, 'PENDING');
  const rejection = result.rejected.find(item => item.code === DECISION_REJECTION.LEAD_DEMOTION_EVIDENCE_REQUIRED);
  assert.equal(rejection.events[0].destinationRole, 'omitted');
  refusesEverything(result);
});

test('promoting material into Melody needs positive, section-resolved lead evidence', () => {
  const bare = apply([assign('p1', ['tex-1'], 'Melody')]);
  assert.equal(bare.status, 'PASS');
  assert.ok(bare.candidate, 'role-less material may be materialized for review');
  const diagnostic = bare.diagnostics.find(item => item.code === 'ROLELESS_LEAD_ASSIGNMENT_REVIEW_PENDING');
  assert.ok(diagnostic);
  assert.deepEqual([...diagnostic.eventIds], ['tex-1']);
  const reports = leadPromotionReportsFromApplication(bare, baseline);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].eventId, 'tex-1');
  assert.equal(reports[0].status, 'PENDING', 'candidate construction is not positive Lead evidence');

  const noSection = apply([assign('p2', ['tex-1'], 'Melody', {
    leadEvidence: {
      sourceIdentity: { sourceId: SOURCE_ID, sourceEventId: `${SOURCE_ID}#tex-1` },
      sectionRole: 'unknown',
      scoreEvidence: { availability: 'available', classification: 'lead', citation: 'fixture:score top staff' },
    },
  })]);
  assert.equal(noSection.status, 'PENDING');
  assert.ok(noSection.rejected[0].events[0].blockers.includes('SECTION_ROLE_UNRESOLVED'));

  // Highest pitch is never the evidence: the promotion stays blocked when the
  // cited classification does not say this material is the lead.
  const notLead = apply([assign('p3', ['tex-1'], 'Melody', {
    leadEvidence: {
      sourceIdentity: { sourceId: SOURCE_ID, sourceEventId: `${SOURCE_ID}#tex-1` },
      sectionRole: 'instrumental',
      scoreEvidence: { availability: 'available', classification: 'inner', citation: 'fixture:score inner staff' },
      audioEvidence: { availability: 'available', classification: 'background', citation: 'fixture:audio background' },
    },
  })]);
  assert.equal(notLead.status, 'PENDING');
  assert.ok(notLead.rejected[0].events[0].blockers.includes('POSITIVE_LEAD_EVIDENCE_MISSING'));
});

test('a revision cannot be constructed without the identities it is addressed by', () => {
  assert.throws(() => createArrangementRevision({
    index: 0,
    baselineIdentity: identity,
    decisionSetDigest: 'x',
    canonicalIdentity: CANONICAL_IDENTITY,
    candidateDigest: 'y',
  }), /index must be an integer/);
});
