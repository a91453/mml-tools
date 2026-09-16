import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAcceptedArrangement,
  revisionIdentityMatches,
  candidateDigestOf,
  derivedDuplicateEventId,
  ACCEPTED_DECISION_TYPES,
} from '../backend/arrangement/decision-application.mjs';
import { suggestRoleCandidates } from '../backend/arrangement/role-candidates.mjs';
import { f } from '../backend/mml/index.mjs';
import {
  roleDeclaredBaseline,
  acceptanceFor,
  leadDemotionEvidence,
  leadPromotionEvidence,
  CANONICAL_IDENTITY,
  rotate,
  reverseKeys,
} from './fixtures/g11d-fixtures.mjs';

// Application: immutability, determinism, per-type semantics, revision lineage
// and the reversible provenance trace.

const baseline = roleDeclaredBaseline();
const suggestion = suggestRoleCandidates(baseline);
const accept = (overrides = {}) => ({ ...acceptanceFor(baseline, { suggestion }), ...overrides });

const apply = (decisions, extra = {}) => applyAcceptedArrangement({
  baseline, suggestion, decisions, canonicalIdentity: CANONICAL_IDENTITY, ...extra,
});

const assign = (id, eventIds, toRole, overrides = {}) => ({
  id, type: 'ASSIGN_ROLE', target: { eventIds }, toRole,
  reason: `Fixture: ${toRole} by explicit review.`, evidence: ['fixture:score'], acceptance: accept(), ...overrides,
});
const keep = (id, eventIds, fromRole, overrides = {}) => ({
  id, type: 'KEEP', target: { eventIds }, fromRole,
  reason: 'Fixture: kept as reviewed.', evidence: ['fixture:score'], acceptance: accept(), ...overrides,
});
const move = (id, eventIds, fromRole, toRole, overrides = {}) => ({
  id, type: 'MOVE_ROLE', target: { eventIds }, fromRole, toRole,
  reason: `Fixture: ${fromRole} -> ${toRole} by explicit review.`, evidence: ['fixture:score'], acceptance: accept(), ...overrides,
});
const omit = (id, eventIds, overrides = {}) => ({
  id, type: 'OMIT_FROM_SIX', target: { eventIds },
  reason: 'Fixture: not carried into the six roles.', evidence: ['fixture:score'], acceptance: accept(), ...overrides,
});
const duplicate = (id, eventIds, toRoles, overrides = {}) => ({
  id, type: 'DUPLICATE_WITH_JUSTIFICATION', target: { eventIds }, toRoles,
  reason: 'Fixture: doubled with a cited reason.', evidence: ['fixture:score bar 1 doubling'], acceptance: accept(), ...overrides,
});

const noteById = (project, id) => project.events.find(event => event.id === id);
const roleOf = (project, id) => noteById(project, id)?.role ?? null;

// ─── A. immutability ────────────────────────────────────────────────────────

test('the Source-Faithful Baseline is byte-identical before and after', () => {
  const before = JSON.parse(JSON.stringify(baseline));
  const result = apply([
    assign('a1', ['tex-1', 'tex-2'], 'Chord3'),
    move('m1', ['harm-2'], 'Chord1', 'Chord4'),
    omit('o1', ['bass-2']),
  ]);
  assert.equal(result.status, 'PASS');
  assert.deepEqual(JSON.parse(JSON.stringify(baseline)), before, 'the baseline object must be untouched');
  assert.equal(result.immutability.baselineUnchanged, true);
  assert.equal(result.immutability.baselineDigestBefore, result.immutability.baselineDigestAfter);

  // Not just equal -- the events are the same frozen objects the caller owns.
  for (const event of baseline.events) assert.equal(Object.isFrozen(event), true);
  assert.equal(roleOf(baseline, 'tex-1'), null, 'a baseline role is never written back');
  assert.equal(roleOf(baseline, 'harm-2'), 'Chord1');
  assert.ok(noteById(baseline, 'bass-2'), 'an omitted event still exists in the baseline');
});

test('a failed application leaves the baseline and the parent untouched', () => {
  const first = apply([assign('a1', ['tex-1', 'tex-2'], 'Chord3')]);
  const baselineBefore = JSON.parse(JSON.stringify(baseline));
  const parentBefore = JSON.parse(JSON.stringify(first.candidate));

  const failed = apply([
    move('m1', ['tex-1'], 'Chord3', 'Chord4', { acceptance: accept({ reviewedRevisionId: first.revision.id }) }),
    move('m2', ['tex-1'], 'Chord3', 'Chord5', { acceptance: accept({ reviewedRevisionId: first.revision.id }) }),
  ], { parent: { revision: first.revision, candidate: first.candidate } });

  assert.equal(failed.status, 'FAIL');
  assert.equal(failed.candidate, null);
  assert.deepEqual(JSON.parse(JSON.stringify(baseline)), baselineBefore);
  assert.deepEqual(JSON.parse(JSON.stringify(first.candidate)), parentBefore);
  assert.equal(failed.immutability.baselineUnchanged, true);
  assert.equal(failed.immutability.parentUnchanged, true);
});

test('the G11-B decomposition and the G11-C suggestion are unchanged by application', () => {
  const suggestionBefore = JSON.parse(JSON.stringify(suggestion));
  apply([assign('a1', ['tex-1'], 'Chord3')]);
  assert.deepEqual(JSON.parse(JSON.stringify(suggestion)), suggestionBefore);
});

// ─── B. determinism ─────────────────────────────────────────────────────────

const deterministicSet = [
  keep('k1', ['lead-1', 'lead-2'], 'Melody'),
  assign('a1', ['tex-1', 'tex-2'], 'Chord3'),
  move('m1', ['harm-2'], 'Chord1', 'Chord4'),
  omit('o1', ['bass-2']),
  duplicate('d1', ['harm-1'], ['Chord5']),
];

test('the same accepted set produces the same candidate, revision and diff', () => {
  const first = apply(deterministicSet);
  const again = apply(deterministicSet);
  assert.equal(first.status, 'PASS');
  assert.equal(first.revision.id, again.revision.id);
  assert.equal(candidateDigestOf(first.candidate), candidateDigestOf(again.candidate));
  assert.deepEqual(JSON.parse(JSON.stringify(first.candidate)), JSON.parse(JSON.stringify(again.candidate)));
  assert.deepEqual(JSON.parse(JSON.stringify(first.trace)), JSON.parse(JSON.stringify(again.trace)));
});

test('decision order, event order and object key order do not change the result', () => {
  const reference = apply(deterministicSet);

  for (const offset of [1, 2, 3, 4]) {
    const rotated = apply(rotate(deterministicSet, offset));
    assert.equal(rotated.revision.id, reference.revision.id, `rotation by ${offset} must not change the revision`);
    assert.deepEqual(rotated.candidate.events.map(event => event.id), reference.candidate.events.map(event => event.id));
    assert.deepEqual(JSON.parse(JSON.stringify(rotated.trace)), JSON.parse(JSON.stringify(reference.trace)));
    assert.equal(rotated.decisionSetDigest, reference.decisionSetDigest);
  }

  // Reversed baseline event order.
  const reversedBaseline = { ...baseline, events: [...baseline.events].reverse() };
  const reversed = applyAcceptedArrangement({
    baseline: reversedBaseline, suggestion, decisions: deterministicSet, canonicalIdentity: CANONICAL_IDENTITY,
  });
  assert.equal(reversed.status, 'PASS');
  assert.equal(reversed.revision.id, reference.revision.id, 'input event order must not reach the revision identity');
  assert.deepEqual(reversed.candidate.events.map(event => event.id), reference.candidate.events.map(event => event.id));

  // Reversed object key order on every decision.
  const keyReversed = apply(deterministicSet.map(reverseKeys));
  assert.equal(keyReversed.status, 'PASS');
  assert.equal(keyReversed.revision.id, reference.revision.id);
  assert.equal(keyReversed.decisionSetDigest, reference.decisionSetDigest);
});

test('a revision id carries no timestamp, counter or random component', () => {
  const first = apply(deterministicSet);
  assert.match(first.revision.id, /^g11d:rev:[a-f0-9]{64}$/);
  assert.equal(revisionIdentityMatches(first.revision), true);
  // Recomputed from its own content after a JSON round trip through storage.
  assert.equal(revisionIdentityMatches(JSON.parse(JSON.stringify(first.revision))), true);
});

// ─── C. KEEP ────────────────────────────────────────────────────────────────

test('KEEP changes nothing about the event it keeps', () => {
  const result = apply([keep('k1', ['lead-1', 'harm-1', 'bass-1'], null)]);
  assert.equal(result.status, 'PASS');
  for (const id of ['lead-1', 'harm-1', 'bass-1']) {
    const before = noteById(baseline, id);
    const after = noteById(result.candidate, id);
    assert.equal(after.id, before.id);
    assert.equal(after.role, before.role);
    assert.equal(after.pitch, before.pitch);
    assert.equal(f(after.start).cmp(before.start), 0);
    assert.equal(f(after.end).cmp(before.end), 0);
    assert.equal(after.volume, before.volume);
    assert.deepEqual([...after.sourceIds], [...before.sourceIds]);
    assert.deepEqual([...after.sourceEventIds], [...before.sourceEventIds]);
  }
});

// ─── suggestion is not acceptance, proven on the candidate ──────────────────

test('a role G11-C suggested but nobody accepted does not appear in the candidate', () => {
  const suggested = suggestion.lanes.find(lane => lane.id === 'lane:texture#0');
  assert.equal(suggested.candidateRole, 'Chord3', 'the fixture must really produce a suggestion for this lane');

  const result = apply([keep('k1', ['lead-1'], 'Melody')]);
  assert.equal(result.status, 'PASS');
  assert.equal(roleOf(result.candidate, 'tex-1'), null, 'a suggested role is not an accepted role');
  assert.equal(roleOf(result.candidate, 'tex-2'), null);
  assert.ok(result.diagnostics.some(item => item.code === 'UNASSIGNED_MATERIAL_RETAINED'),
    'unaccepted material is retained and reported, never dropped');
  const unassigned = result.diagnostics.find(item => item.code === 'UNASSIGNED_MATERIAL_RETAINED');
  assert.ok(unassigned.eventIds.includes('tex-1'));
});

// ─── D. ASSIGN ──────────────────────────────────────────────────────────────

test('ASSIGN_ROLE places unassigned material and keeps its provenance', () => {
  const result = apply([assign('a1', ['tex-1', 'tex-2'], 'Chord3')]);
  assert.equal(result.status, 'PASS');
  assert.equal(roleOf(result.candidate, 'tex-1'), 'Chord3');
  assert.equal(roleOf(result.candidate, 'tex-2'), 'Chord3');
  assert.deepEqual([...noteById(result.candidate, 'tex-1').sourceEventIds], [...noteById(baseline, 'tex-1').sourceEventIds]);

  const entries = result.trace.filter(item => item.decisionId === 'a1');
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(entry.decisionType, ACCEPTED_DECISION_TYPES.ASSIGN_ROLE);
    assert.equal(entry.fromRole, null);
    assert.equal(entry.toRole, 'Chord3');
    assert.deepEqual([...entry.outputEventIds], [entry.inputEventId]);
    assert.equal(entry.baselineEventId, entry.inputEventId);
  }
  assert.equal(result.applied.find(item => item.decisionId === 'a1').eventCount, 2);
});

test('ASSIGN_ROLE on an event that already has an accepted role is refused', () => {
  const result = apply([assign('a1', ['harm-1'], 'Chord3')]);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.rejected.some(item => item.code === 'ASSIGN_ON_ALREADY_ASSIGNED_EVENT'));
});

// ─── E. MOVE ────────────────────────────────────────────────────────────────

test('MOVE_ROLE moves the role and nothing else, and shows up in the diff', () => {
  const result = apply([move('m1', ['harm-2'], 'Chord1', 'Chord4')]);
  assert.equal(result.status, 'PASS');
  assert.equal(roleOf(result.candidate, 'harm-2'), 'Chord4');
  const after = noteById(result.candidate, 'harm-2');
  const before = noteById(baseline, 'harm-2');
  assert.equal(after.pitch, before.pitch);
  assert.equal(f(after.start).cmp(before.start), 0);
  assert.equal(f(after.end).cmp(before.end), 0);

  const moved = result.diffFromBaseline.notes.roleMoved.find(pair => pair.before.id === 'harm-2');
  assert.ok(moved, 'a role move must be visible in the baseline diff');
  assert.deepEqual(moved.changes.role, { before: 'Chord1', after: 'Chord4' });
  assert.equal(result.diffFromBaseline.summary.roleMoved, 1);
  assert.equal(result.diffFromBaseline.summary.noteRemoved, 0);
  assert.equal(result.diffFromBaseline.summary.noteAdded, 0);
});

test('a Melody demotion with the full evidence chain applies, and is still a Lead move in the diff', () => {
  const result = apply([move('m1', ['lead-1'], 'Melody', 'Chord3', {
    leadEvidence: leadDemotionEvidence(),
  })]);
  assert.equal(result.status, 'PASS');
  assert.equal(roleOf(result.candidate, 'lead-1'), 'Chord3');
  const moved = result.diffFromBaseline.notes.roleMoved.find(pair => pair.before.id === 'lead-1');
  assert.deepEqual(moved.changes.role, { before: 'Melody', after: 'Chord3' });
});

test('a Melody promotion with positive cited evidence applies', () => {
  const result = apply([assign('p1', ['tex-1'], 'Melody', { leadEvidence: leadPromotionEvidence() })]);
  assert.equal(result.status, 'PASS');
  assert.equal(roleOf(result.candidate, 'tex-1'), 'Melody');
});

// ─── F. OMIT ────────────────────────────────────────────────────────────────

test('OMIT_FROM_SIX removes from the candidate only, and can never vanish from the record', () => {
  const result = apply([omit('o1', ['tex-2', 'bass-2'])]);
  assert.equal(result.status, 'PASS');

  for (const id of ['tex-2', 'bass-2']) {
    assert.equal(noteById(result.candidate, id), undefined, `${id} must be absent from the candidate`);
    assert.ok(noteById(baseline, id), `${id} must still exist in the Source-Faithful Baseline`);

    // Three independent records, so no single deletion can hide an omission.
    const record = result.omitted.find(item => item.eventId === id);
    assert.ok(record, 'the omission ledger names it');
    assert.equal(record.stillInBaseline, true);
    assert.ok(record.sourceEventIds.length, 'with its source provenance');

    assert.ok(result.diffFromBaseline.notes.removed.some(event => event.id === id), 'the baseline diff shows it removed');
    assert.ok(result.trace.some(item => item.inputEventId === id && item.outputEventIds.length === 0), 'the trace shows it produced no output event');
  }
  assert.equal(result.diffFromBaseline.summary.noteRemoved, 2);

  // Omitting Core3 material is applied, and reported as what it is.
  const core3 = result.diagnostics.find(item => item.code === 'CORE3_MATERIAL_OMITTED');
  assert.ok(core3);
  assert.deepEqual([...core3.eventIds], ['bass-2']);
  assert.deepEqual([...core3.roles], ['Chord2']);
});

// ─── G. DUPLICATE ───────────────────────────────────────────────────────────

test('a duplicate is derived candidate material, never a second source event', () => {
  const result = apply([duplicate('d1', ['harm-1'], ['Chord3', 'Chord5'])]);
  assert.equal(result.status, 'PASS');

  const original = noteById(result.candidate, 'harm-1');
  assert.equal(original.role, 'Chord1', 'the original keeps its id and its role');

  const copies = result.candidate.events.filter(event => event.metadata?.g11d?.derivedFromEventId === 'harm-1');
  assert.equal(copies.length, 2);
  assert.deepEqual(copies.map(copy => copy.role).sort(), ['Chord3', 'Chord5']);

  for (const copy of copies) {
    // Deterministic, derived identity -- not a random id, and reproducible.
    assert.equal(copy.id, derivedDuplicateEventId('harm-1', copy.role, 'd1'));
    assert.match(copy.id, /^harm-1#g11d-dup:[a-f0-9]{16}$/);
    // The source event it copies, stated -- and only that one.
    assert.deepEqual([...copy.sourceIds], [...original.sourceIds]);
    assert.deepEqual([...copy.sourceEventIds], [...original.sourceEventIds]);
    assert.equal(copy.pitch, original.pitch);
    assert.ok(copy.tags.includes('g11d-derived-duplicate'), 'a copy is marked derived');
    assert.equal(copy.metadata.g11d.decisionId, 'd1');
    assert.equal(copy.metadata.g11d.derived, ACCEPTED_DECISION_TYPES.DUPLICATE_WITH_JUSTIFICATION);
    assert.ok(copy.metadata.g11d.reason.length);
    assert.ok(copy.metadata.g11d.evidence.length);
  }

  // Exactly one source event, however many candidate events it produced.
  const sourceEventIds = new Set(result.candidate.events.flatMap(event => [...event.sourceEventIds]));
  assert.equal([...sourceEventIds].filter(id => id.endsWith('#harm-1')).length, 1);

  const entry = result.trace.find(item => item.decisionId === 'd1');
  assert.equal(entry.outputEventIds.length, 3, 'the original plus both copies');
  assert.ok(entry.outputEventIds.includes('harm-1'));
});

test('duplicate identity depends on the decision, so two reviewers do not collide', () => {
  assert.notEqual(derivedDuplicateEventId('harm-1', 'Chord3', 'd1'), derivedDuplicateEventId('harm-1', 'Chord3', 'd2'));
  assert.notEqual(derivedDuplicateEventId('harm-1', 'Chord3', 'd1'), derivedDuplicateEventId('harm-1', 'Chord4', 'd1'));
  assert.equal(derivedDuplicateEventId('harm-1', 'Chord3', 'd1'), derivedDuplicateEventId('harm-1', 'Chord3', 'd1'));
});

// ─── revision lineage ───────────────────────────────────────────────────────

test('each application produces a new revision without overwriting its parent', () => {
  const first = apply([assign('a1', ['tex-1', 'tex-2'], 'Chord3')]);
  const second = applyAcceptedArrangement({
    baseline, suggestion, canonicalIdentity: CANONICAL_IDENTITY,
    parent: { revision: first.revision, candidate: first.candidate },
    decisions: [move('m1', ['tex-1'], 'Chord3', 'Chord4', { acceptance: accept({ reviewedRevisionId: first.revision.id }) })],
  });
  const third = applyAcceptedArrangement({
    baseline, suggestion, canonicalIdentity: CANONICAL_IDENTITY,
    parent: { revision: second.revision, candidate: second.candidate },
    decisions: [omit('o1', ['tex-2'], { acceptance: accept({ reviewedRevisionId: second.revision.id }) })],
  });

  assert.equal(second.status, 'PASS');
  assert.equal(third.status, 'PASS');
  assert.deepEqual(
    [first.revision.index, second.revision.index, third.revision.index],
    [1, 2, 3],
  );
  assert.equal(second.revision.parentRevisionId, first.revision.id);
  assert.equal(third.revision.parentRevisionId, second.revision.id);
  assert.equal(first.revision.parentRevisionId, null);

  // Every revision still names the same baseline and the same Canonical release.
  for (const revision of [first.revision, second.revision, third.revision]) {
    assert.equal(revision.baselineIdentity.contentDigest, first.revision.baselineIdentity.contentDigest);
    assert.equal(revision.canonicalIdentity.rules_snapshot_sha, CANONICAL_IDENTITY.rules_snapshot_sha);
    assert.deepEqual([...revision.notice.matchAll(/certifies no/g)].length > 0, true);
  }

  // Nothing about the earlier revisions moved.
  assert.equal(roleOf(first.candidate, 'tex-1'), 'Chord3');
  assert.equal(roleOf(second.candidate, 'tex-1'), 'Chord4');
  assert.ok(noteById(second.candidate, 'tex-2'), 'revision 2 still carries the event revision 3 omits');
  assert.equal(noteById(third.candidate, 'tex-2'), undefined);

  // And revision 3's diffs answer both questions Canonical asks for.
  assert.ok(third.diffFromBaseline.notes.removed.some(event => event.id === 'tex-2'));
  assert.ok(third.diffFromParent.notes.removed.some(event => event.id === 'tex-2'));
  assert.equal(third.diffFromParent.summary.roleMoved, 0, 'revision 3 moved no role');
  assert.equal(third.diffFromBaseline.summary.roleMoved, 1, 'but the lineage from the baseline still shows revision 2\'s move');
});

test('a derived revision never inherits its parent\'s gate evidence', () => {
  const tainted = {
    ...baseline,
    metadata: {
      sourceComplete: true,
      audioAlignmentEvidence: [{ section: 'all', warnings: [] }],
      note: 'ordinary metadata survives',
    },
  };
  const result = applyAcceptedArrangement({
    baseline: tainted, suggestion, canonicalIdentity: CANONICAL_IDENTITY,
    decisions: [assign('a1', ['tex-1'], 'Chord3', { acceptance: acceptanceFor(tainted, { suggestion }) })],
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.candidate.metadata.sourceComplete, undefined);
  assert.equal(result.candidate.metadata.audioAlignmentEvidence, undefined);
  assert.equal(result.candidate.metadata.note, 'ordinary metadata survives');
  const stripped = result.diagnostics.find(item => item.code === 'PARENT_GATE_METADATA_NOT_INHERITED');
  assert.deepEqual([...stripped.keys].sort(), ['audioAlignmentEvidence', 'sourceComplete']);
});

test('the candidate carries its revision as provenance that certifies nothing', () => {
  const result = apply([assign('a1', ['tex-1'], 'Chord3')]);
  const provenance = result.candidate.metadata.g11d;
  assert.equal(provenance.revision.id, result.revision.id);
  assert.deepEqual(provenance.certifiesGates, []);
  assert.deepEqual(provenance.appliedDecisionIds, ['a1']);
  assert.match(provenance.notice, /data, not authority/);
  // The candidate also carries the baseline it was derived from, so the
  // existing readiness baseline gate has a real snapshot to diff against.
  assert.equal(result.candidate.metadata.sourceFaithfulBaseline.snapshot.id, baseline.id);
  assert.equal(result.candidate.metadata.sourceFaithfulBaseline.snapshot.events.length, baseline.events.length);
});

// ─── tempo / meter / rests are not touched ──────────────────────────────────

test('tempo, meter and rest events pass through a role decision unchanged', () => {
  const result = apply([move('m1', ['harm-2'], 'Chord1', 'Chord4'), omit('o1', ['tex-2'])]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.candidate.tempoEvents)),
    JSON.parse(JSON.stringify(baseline.tempoEvents)),
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.candidate.meterEvents)),
    JSON.parse(JSON.stringify(baseline.meterEvents)),
  );
  assert.equal(result.diffFromBaseline.summary.tempoChanged, 0);
  assert.equal(result.diffFromBaseline.summary.tempoAdded, 0);
  assert.equal(result.diffFromBaseline.summary.tempoRemoved, 0);
});

// ─── section windows ────────────────────────────────────────────────────────

test('a section window restricts a lane decision to the events inside it', () => {
  const result = apply([{
    id: 's1',
    type: 'ASSIGN_ROLE',
    target: { laneId: 'lane:texture#0' },
    toRole: 'Chord3',
    section: { start: '0', end: '1' },
    reason: 'Fixture: only the first beat of this lane is enrichment.',
    evidence: ['fixture:score bar 1'],
    acceptance: accept(),
  }]);
  assert.equal(result.status, 'PASS');
  assert.equal(roleOf(result.candidate, 'tex-1'), 'Chord3');
  assert.equal(roleOf(result.candidate, 'tex-2'), null, 'the event outside the window is untouched');
});

// ─── a duplicate always sounds with its original, and says so ───────────────

test('a declared duplication reports the doubling it creates', () => {
  const result = apply([duplicate('d1', ['harm-1'], ['Chord3'])]);
  assert.equal(result.status, 'PASS');
  const doubling = result.diagnostics.find(item => item.code === 'DERIVED_DUPLICATE_SOUNDS_WITH_ORIGINAL');
  assert.ok(doubling, 'a copy at the same pitch and time in another role is never left unmentioned');
  assert.equal(doubling.deleted, false);
  assert.equal(doubling.doublings[0].eventId, 'harm-1');
  assert.equal(doubling.doublings[0].originalRole, 'Chord1');
  assert.deepEqual([...doubling.doublings[0].duplicateRoles], ['Chord3']);
  assert.equal(doubling.doublings[0].decisionId, 'd1');

  // Cross-source arbitration is right not to see it: both events carry the same
  // sourceIds, so they are not a cross-source conflict. That is exactly why the
  // doubling is reported here.
  const original = noteById(result.candidate, 'harm-1');
  const copy = result.candidate.events.find(event => event.metadata?.g11d?.derivedFromEventId === 'harm-1');
  assert.deepEqual([...copy.sourceIds], [...original.sourceIds]);
  assert.equal(copy.pitch, original.pitch);
  assert.equal(f(copy.start).cmp(original.start), 0);
});

test('a derived duplicate id that would collide with an existing event is refused', async () => {
  const { derivedDuplicateEventId: derive } = await import('../backend/arrangement/decision-application.mjs');
  const { createSource, createCanonicalNoteEvent, createCanonicalProject } = await import('../backend/canonical/index.mjs');
  const { baselineIdentityOf } = await import('../backend/arrangement/decision-application.mjs');

  const collidingId = derive('h1', 'Chord3', 'dup');
  const source = createSource({ id: 'fixture:collision', label: 'Collision fixture', kind: 'official-midi', authority: 'primary-symbolic' });
  const note = (id, pitch, role) => createCanonicalNoteEvent({ id, pitch, start: '0', end: '1', sourceIds: [source.id], sourceEventIds: [`${source.id}#${id}`], role });
  const project = createCanonicalProject({
    id: 'fixture:collision-project',
    title: 'Collision fixture',
    sources: [source],
    // An event whose id is exactly the id the duplication below would derive.
    events: [note('h1', 64, 'Chord1'), note(collidingId, 55, 'Chord2')],
  });
  const identity = baselineIdentityOf(project);

  const result = applyAcceptedArrangement({
    baseline: project,
    canonicalIdentity: CANONICAL_IDENTITY,
    decisions: [{
      id: 'dup',
      type: 'DUPLICATE_WITH_JUSTIFICATION',
      target: { eventIds: ['h1'] },
      toRoles: ['Chord3'],
      reason: 'Fixture: doubled for enrichment.',
      evidence: ['fixture:score'],
      acceptance: {
        state: 'ACCEPTED',
        acceptedBy: 'fixture-reviewer',
        reviewedRevisionId: null,
        baselineContentDigest: identity.contentDigest,
        sourceIdentityDigest: identity.sourceIdentityDigest,
        laneDecompositionDigest: null,
        canonicalRulesSnapshotSha: CANONICAL_IDENTITY.rules_snapshot_sha,
      },
    }],
  });
  assert.equal(result.status, 'FAIL', 'a colliding derived id is a structured rejection, not a thrown constructor error');
  assert.equal(result.candidate, null);
  const rejection = result.rejected.find(item => item.code === 'DERIVED_DUPLICATE_ID_COLLISION');
  assert.ok(rejection);
  assert.equal(rejection.events[0].derivedId, collidingId);
});

// ─── the caller's objects are read once, and never held ─────────────────────

test('mutating a decision after validation cannot change the result', () => {
  const decisions = [
    { ...assign('a1', ['tex-1'], 'Chord3') },
    { ...move('m1', ['harm-2'], 'Chord1', 'Chord4') },
  ];
  const before = apply(decisions);
  assert.equal(before.status, 'PASS');
  const snapshot = JSON.parse(JSON.stringify(before.candidate));

  // Everything a hostile or careless caller could reach for after the call.
  decisions[0].toRole = 'Melody';
  decisions[0].target.eventIds.push('lead-1');
  decisions[1].fromRole = 'Chord5';
  decisions[1].acceptance.baselineContentDigest = 'f'.repeat(64);

  assert.deepEqual(JSON.parse(JSON.stringify(before.candidate)), snapshot, 'the returned candidate is not a live view of its inputs');
  assert.equal(Object.isFrozen(before.trace), true);
  assert.equal(Object.isFrozen(before.applied), true);
  assert.equal(Object.isFrozen(before.revision), true);
});

test('an accepted arrangement decision never becomes an accepted arbitration decision', () => {
  const result = apply([
    move('m1', ['harm-2'], 'Chord1', 'Chord4'),
    assign('a1', ['tex-1', 'tex-2'], 'Chord3'),
  ]);
  assert.equal(result.status, 'PASS');
  // A cross-source harmony conflict is marked resolved by an accepted decision
  // covering both of its event ids. G11-D writes none, so it cannot resolve one.
  assert.deepEqual([...result.candidate.decisions], []);
  assert.equal(result.diagnostics.some(item => item.code === 'ARBITRATION_DECISIONS_CARRIED_FORWARD'), false);
});
