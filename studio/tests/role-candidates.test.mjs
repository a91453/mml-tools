import test from 'node:test';
import assert from 'node:assert/strict';
import {
  suggestRoleCandidates,
  ROLE_CANDIDATE_STATUS,
  ROLE_DECISIONS,
  SIX_ROLES,
  CORE3_ROLE_NAMES,
  ENRICHMENT_ROLE_NAMES,
} from '../backend/arrangement/index.mjs';
import { f } from '../backend/mml/index.mjs';

// ─── fixture helpers ────────────────────────────────────────────────────────

const note = (id, pitch, start, end, voice, extra = {}) => Object.freeze({
  kind: 'note',
  id,
  pitch,
  start,
  end,
  sourceIds: Object.freeze([extra.sourceId ?? 'fixture']),
  sourceEventIds: Object.freeze([`raw:${id}`]),
  role: extra.role ?? null,
  voice,
  volume: null,
  tags: Object.freeze(extra.tags ?? ['source-faithful']),
  metadata: Object.freeze(extra.metadata ?? {}),
});

const project = events => Object.freeze({
  schema: 'mabinogi-mobile-mml-studio/canonical-project@2',
  id: 'fixture-project',
  title: 'fixture',
  sources: Object.freeze([]),
  events: Object.freeze(events),
});

// Four quarter notes forming a varied, independently-attacking line.
const line = (prefix, pitches, voice, from = 0, extra = {}) => pitches.map((pitch, index) =>
  note(`${prefix}${index + 1}`, pitch, String(from + index), String(from + index + 1), voice, extra));

// A block chord: every member attacks and releases together, so no member is an
// independent line no matter how high it sits.
const block = (prefix, pitches, voice, start, end, extra = {}) => pitches.map((pitch, index) =>
  note(`${prefix}${index + 1}`, pitch, String(start), String(end), voice, extra));

const laneOf = (candidate, laneId) => candidate.lanes.find(lane => lane.id === laneId);
const diagnostic = (candidate, code) => candidate.diagnostics.find(item => item.code === code);
const ledgerFor = (candidate, eventId) => candidate.ledger.filter(entry => entry.eventId === eventId);
const sameBeat = (a, b) => f(a).cmp(b) === 0;

// ─── invariants asserted on every fixture ───────────────────────────────────

// ACCEPTANCE_CRITERIA.md Gate 2 / the G11-C coverage obligation: input event ids
// must equal assigned ∪ pending ∪ unassigned ∪ unsupported. Nothing may vanish,
// and nothing may appear that the source did not contain.
function assertAccountedFor(candidate, events) {
  const input = new Set(events.filter(event => event.kind === 'note').map(event => event.id));
  const assigned = new Set(candidate.ledger.filter(entry => entry.selected).map(entry => entry.eventId));
  const pending = new Set(candidate.ledger.filter(entry => entry.decision === ROLE_DECISIONS.PENDING).map(entry => entry.eventId));
  const omitted = new Set(candidate.ledger.filter(entry => entry.decision === ROLE_DECISIONS.OMIT_FROM_SIX).map(entry => entry.eventId));
  const unsupported = new Set(candidate.unsupportedSourceMaterial.map(item => item.eventId));
  const accounted = new Set([...assigned, ...pending, ...omitted, ...unsupported]);
  assert.deepEqual(accounted, input, 'every source event must be assigned, pending, unassigned, or retained as unsupported');
  assert.equal(candidate.coverage.complete, true);
  assert.deepEqual([...candidate.coverage.missingEventIds], []);
  assert.deepEqual([...candidate.coverage.unknownEventIds], []);
}

// MASTER_RULES.md §3: a candidate transformation must never erase the original
// identity. The ledger restates pitch/onset/duration, and they must still match.
function assertNoMutation(candidate, events) {
  const byId = new Map(events.filter(event => event.kind === 'note').map(event => [event.id, event]));
  assert.deepEqual([...candidate.coverage.mutatedEventIds], []);
  for (const entry of candidate.ledger) {
    const source = byId.get(entry.eventId);
    assert.ok(source, `ledger entry ${entry.eventId} must trace to a source event`);
    assert.equal(entry.sourcePitch, source.pitch, `${entry.eventId} pitch must be unchanged`);
    assert.ok(sameBeat(entry.sourceStart, source.start), `${entry.eventId} onset must be unchanged`);
    assert.ok(sameBeat(entry.sourceEnd, source.end), `${entry.eventId} duration must be unchanged`);
    assert.deepEqual([...entry.sourceIds], [...source.sourceIds]);
    assert.deepEqual([...entry.sourceEventIds], [...source.sourceEventIds]);
  }
}

// The candidate must be a pure function of the event set, not of the array order
// the caller happened to build.
function assertOrderIndependent(events, options) {
  const canonical = JSON.stringify(suggestRoleCandidates(project(events), options));
  const rotated = events.map((_, index) => events[(index + 1) % events.length]);
  const reversed = [...events].reverse();
  const byIdDesc = [...events].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const byPitch = [...events].sort((a, b) => a.pitch - b.pitch);
  for (const [label, variant] of [['rotated', rotated], ['reversed', reversed], ['id-desc', byIdDesc], ['pitch-asc', byPitch]]) {
    assert.equal(JSON.stringify(suggestRoleCandidates(project(variant), options)), canonical,
      `${label} input order must produce an identical candidate`);
  }
}

function run(events, options) {
  const candidate = suggestRoleCandidates(project(events), options);
  assertAccountedFor(candidate, events);
  assertNoMutation(candidate, events);
  return candidate;
}

// ─── 1. obvious monophonic Lead + harmony + bass ─────────────────────────────

const MELODY_VOICE = 'track:0/channel:0';
const HARMONY_VOICE = 'track:1/channel:1';
const BASS_VOICE = 'track:2/channel:2';

const obviousEvents = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE),
  ...block('ha', [60, 64, 67], HARMONY_VOICE, 0, 2),
  ...block('hb', [59, 62, 67], HARMONY_VOICE, 2, 4),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
];

test('fixture 1: Lead + harmony + bass yields a Core3 candidate that explains its own completeness', () => {
  const candidate = run(obviousEvents);
  assertOrderIndependent(obviousEvents);

  assert.equal(candidate.roles.Melody.status, 'ASSIGNED');
  assert.deepEqual([...candidate.roles.Melody.laneIds], [`lane:${MELODY_VOICE}#0`]);
  assert.equal(candidate.roles.Chord1.status, 'ASSIGNED');
  assert.equal(candidate.roles.Chord2.status, 'ASSIGNED');
  assert.deepEqual([...candidate.roles.Chord2.laneIds], [`lane:${BASS_VOICE}#0`]);

  assert.equal(candidate.core3.status, 'COMPLETE');
  assert.deepEqual([...candidate.core3.missingFunctions], []);
  assert.equal(candidate.core3.identityDependsOnEnrichment, false);

  // Completeness is argued, not merely asserted: each of the four musical
  // functions has to appear in the rationale with its own verdict.
  const codes = candidate.core3.rationale.map(item => item.code);
  assert.ok(codes.includes('CORE3_EVALUATED_INDEPENDENTLY_OF_FULL6'));
  assert.ok(codes.includes('LEAD_CONTINUITY_SOURCE_SUPPORTED'));
  assert.ok(codes.includes('PRINCIPAL_HARMONY_PRESENT'));
  assert.ok(codes.includes('BASS_SKELETON_PRESENT'));
  assert.equal(candidate.core3.functions.leadContinuity.satisfied, true);
  assert.equal(candidate.core3.functions.principalHarmony.satisfied, true);
  assert.equal(candidate.core3.functions.bassSkeleton.satisfied, true);
  assert.equal(candidate.core3.functions.essentialInnerSupport.satisfied, true);
  assert.equal(candidate.core3.canonicallyCompleteGate, 'CORE3');
});

test('fixture 1: the walking bass keeps its Lead evidence instead of having it erased', () => {
  const candidate = run(obviousEvents);
  const bass = laneOf(candidate, `lane:${BASS_VOICE}#0`);
  // MASTER_RULES.md §8: a numerical score must never be improved by erasing
  // Lead evidence. The bass is assigned Chord2 on a stronger tier while its
  // weaker Lead evidence survives, and the disagreement is reported.
  assert.equal(bass.roleSupport.Melody.tier, 3);
  assert.equal(bass.roleSupport.Chord2.tier, 2);
  assert.equal(bass.candidateRole, 'Chord2');
  const conflict = diagnostic(candidate, 'CONFLICTING_ROLE_EVIDENCE');
  assert.ok(conflict, 'competing role evidence must be reported, not resolved silently');
  assert.deepEqual(conflict.lanes.find(item => item.laneId === bass.id).primaryEvidenceRoles, ['Chord2', 'Melody']);
  assert.equal(conflict.deleted, false);
});

// ─── 2. Lead + harmony + bass + three enrichment voices ─────────────────────

const enrichedEvents = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 2),
  ...block('hb', [59, 62], HARMONY_VOICE, 2, 4),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
  // A repeated-pitch ostinato: rhythmic detail, never an independent line.
  ...[0, 1, 2, 3, 4, 5, 6, 7].map(step =>
    note(`o${step}`, 67, String(f(step).div(2)), String(f(step + 1).div(2)), 'track:3/channel:3')),
  // A sustained two-pitch pad: texture, never an independent line.
  note('p1', 55, '0', '2', 'track:4/channel:4'),
  note('p2', 57, '2', '4', 'track:4/channel:4'),
];

test('fixture 2: six roles fill with Core3 complete on its own and Full6 explaining each addition', () => {
  const candidate = run(enrichedEvents);
  assertOrderIndependent(enrichedEvents);

  for (const role of SIX_ROLES) assert.equal(candidate.roles[role].status, 'ASSIGNED', `${role} must carry a lane`);
  assert.equal(candidate.core3.status, 'COMPLETE');
  assert.equal(candidate.core3.identityDependsOnEnrichment, false);

  // Full6 is a separate reading. Removing every enrichment role must leave the
  // Core3 verdict untouched.
  for (const role of ENRICHMENT_ROLE_NAMES) {
    const contribution = candidate.full6.roleContributions[role];
    assert.equal(contribution.status !== 'EMPTY', true, `${role} must report a contribution`);
    assert.ok(contribution.addedFunctions.length, `${role} must say what musical function it adds`);
  }
  for (const entry of candidate.full6.enrichmentRationale) {
    assert.equal(entry.removingLeavesCore3Intact, true, 'no enrichment lane may hold Core3 material here');
    assert.ok(entry.eventIds.length, 'every enrichment entry must name the source events supporting it');
  }
  assert.ok(candidate.full6.addedFunctions.length);
});

test('fixture 2: Core3 is evaluable without reading any Full6 field', () => {
  const candidate = run(enrichedEvents);
  const core3LaneIds = new Set(CORE3_ROLE_NAMES.flatMap(role => candidate.roles[role].laneIds));
  const enrichmentLaneIds = ENRICHMENT_ROLE_NAMES.flatMap(role => candidate.roles[role].laneIds);
  for (const laneId of enrichmentLaneIds) assert.equal(core3LaneIds.has(laneId), false);
  for (const item of candidate.core3.rationale) {
    for (const laneId of item.laneIds ?? []) assert.equal(core3LaneIds.has(laneId), true,
      'the Core3 rationale must argue from Core3 lanes only');
  }
});

// ─── 3. vocal-rest instrumental hand-off ────────────────────────────────────

const handOffEvents = [
  // "Vocal": phrases either side of a rest at beats 2-5.
  ...line('v', [72, 74], MELODY_VOICE, 0),
  ...line('w', [76, 72], MELODY_VOICE, 5),
  // Instrumental answer that fills the rest, with a line of its own.
  ...line('i', [79, 77, 76], 'track:9/channel:5', 2),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 4),
  ...block('hb', [59, 62], HARMONY_VOICE, 4, 7),
  ...line('b', [48, 50, 43, 45, 48, 50, 43], BASS_VOICE),
];

test('fixture 3: an instrumental answer continues Melody instead of creating a false gap', () => {
  const candidate = run(handOffEvents);
  assertOrderIndependent(handOffEvents);

  assert.equal(candidate.roles.Melody.status, 'ASSIGNED');
  assert.equal(candidate.roles.Melody.laneIds.length, 2, 'both the vocal lane and the instrumental answer carry Melody');
  assert.ok(candidate.roles.Melody.laneIds.includes('lane:track:9/channel:5#0'));
  assert.ok(candidate.roles.Melody.reasons.includes('LEAD_HANDOFF_CONTINUATION'));
  assert.equal(candidate.core3.functions.leadContinuity.sourceSupportedHandOff, true);

  // A rest is not a contest, and "not proven Vocal" never demotes anything.
  assert.equal(diagnostic(candidate, 'COMPETING_LEAD_CANDIDATES'), undefined);
  assert.equal(candidate.core3.functions.leadContinuity.satisfied, true);
  assert.equal(candidate.core3.status, 'COMPLETE');
});

// ─── 4. a source top voice that is clearly accompaniment ────────────────────

const topAccompanimentEvents = [
  // The highest pitches in the whole fixture, but every member of the block
  // attacks and releases with its siblings.
  ...block('ta', [79, 72, 67], 'track:1/channel:1', 0, 2),
  ...block('tb', [77, 71, 65], 'track:1/channel:1', 2, 4),
  // The actual line, a tenth lower.
  ...line('m', [60, 62, 64, 60], MELODY_VOICE),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
];

test('fixture 4: the highest source voice does not become Melody on register alone', () => {
  const candidate = run(topAccompanimentEvents);
  assertOrderIndependent(topAccompanimentEvents);

  const top = laneOf(candidate, 'lane:track:1/channel:1#0');
  assert.equal(top.metrics.maxPitch, 79, 'the accompaniment top voice really is the highest material');
  const register = top.evidence.find(record => record.signal === 'register_position');
  assert.equal(register.measurement.registerRankFromTop, 0, 'it ranks first by register');
  assert.equal(register.strength, 'supporting', 'register may never be primary evidence');
  assert.equal(top.roleSupport.Melody.tier, null, 'and it still carries no Lead evidence');

  assert.deepEqual([...candidate.roles.Melody.laneIds], [`lane:${MELODY_VOICE}#0`]);
  const melody = laneOf(candidate, `lane:${MELODY_VOICE}#0`);
  assert.equal(melody.roleSupport.Melody.tierName, 'INDEPENDENT_MELODIC_LINE');
  // The decision must cite the function measurements, never the register record.
  for (const evidenceId of candidate.roles.Melody.evidenceIds) {
    assert.ok(/melodic_contour|attack_independence|source_role_hint|trusted_symbolic_role/.test(evidenceId),
      `Melody was justified by ${evidenceId}, which is not a role-bearing signal`);
  }
});

// ─── 5. strong bass + essential inner voice ─────────────────────────────────

const essentialInnerEvents = [
  // The Lead sings throughout, in a lower register than the accompaniment.
  ...line('m', [60, 62, 64, 60, 62, 64], MELODY_VOICE, 0),
  // Principal harmony and bass both rest across beats 2-4.
  ...block('ha', [67, 71], HARMONY_VOICE, 0, 2),
  ...block('hb', [66, 70], HARMONY_VOICE, 4, 6),
  ...line('b', [48, 50], BASS_VOICE, 0),
  ...line('c', [43, 45], BASS_VOICE, 4),
  // A sustained inner voice is the only accompaniment left in that window. It
  // sits above the Lead, so it is never the harmonic floor and cannot reach
  // Chord2 through the bass-function path.
  note('in1', 67, '2', '3', 'track:6/channel:6'),
  note('in2', 69, '3', '4', 'track:6/channel:6'),
];

test('fixture 5: Chord2 carries the bass skeleton plus essential inner support, not Bass-only', () => {
  const candidate = run(essentialInnerEvents);
  assertOrderIndependent(essentialInnerEvents);

  const chord2 = candidate.roles.Chord2.laneIds;
  assert.ok(chord2.length >= 2, 'Chord2 must be able to hold more than the bass skeleton');
  assert.ok(chord2.includes(`lane:${BASS_VOICE}#0`), 'the bass skeleton is in Chord2');
  assert.ok(chord2.includes('lane:track:6/channel:6#0'), 'the essential inner voice is in Chord2');

  const support = candidate.core3.functions.essentialInnerSupport;
  assert.equal(support.satisfied, true);
  assert.equal(support.status, 'PRESENT');
  assert.ok(support.promotedToChord2.includes('lane:track:6/channel:6#0'));

  // The inner support sits well above the bass, so Chord2 is demonstrably not
  // a Bass-only role here.
  const inner = laneOf(candidate, 'lane:track:6/channel:6#0');
  const bass = laneOf(candidate, `lane:${BASS_VOICE}#0`);
  assert.ok(inner.metrics.minPitch > bass.metrics.maxPitch);
  assert.equal(candidate.core3.status, 'COMPLETE');
  // Core3 never falls silent, and after the promotion the Lead is never left
  // without accompaniment either.
  assert.deepEqual([...candidate.core3.sourceCoverage.uncoveredSoundingWindows], []);
  assert.deepEqual([...candidate.core3.sourceCoverage.unaccompaniedSoundingWindows], []);
});

// ─── 6. ambiguous two-lead situation ────────────────────────────────────────

const twoLeadEvents = [
  ...line('p', [72, 74, 76, 72], 'track:0/channel:0'),
  ...line('q', [67, 69, 71, 67], 'track:1/channel:1'),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
];

test('fixture 6: two overlapping Lead candidates stay PENDING instead of one being deleted', () => {
  const candidate = run(twoLeadEvents);
  assertOrderIndependent(twoLeadEvents);

  assert.equal(candidate.roles.Melody.status, 'PENDING');
  assert.deepEqual([...candidate.roles.Melody.laneIds], []);
  assert.deepEqual([...candidate.roles.Melody.competingLaneIds].sort(),
    ['lane:track:0/channel:0#0', 'lane:track:1/channel:1#0']);

  const pendingDiagnostic = diagnostic(candidate, 'COMPETING_LEAD_CANDIDATES');
  assert.ok(pendingDiagnostic);
  assert.equal(pendingDiagnostic.deleted, false);

  // Neither candidate lost an event, and both keep their evidence.
  const pendingLaneIds = candidate.pending.map(item => item.laneId).sort();
  assert.deepEqual(pendingLaneIds, ['lane:track:0/channel:0#0', 'lane:track:1/channel:1#0']);
  for (const item of candidate.pending) {
    assert.equal(item.proposedRole, 'Melody');
    assert.ok(item.eventIds.length, 'a pending lane still names its source events');
    assert.ok(item.evidenceIds.length, 'a pending lane still carries the evidence that made it a candidate');
  }
  for (const id of ['p1', 'q1']) {
    const entries = ledgerFor(candidate, id);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].decision, ROLE_DECISIONS.PENDING);
    assert.equal(entries[0].uncertainty, 'PENDING');
  }
  assert.equal(candidate.core3.status, 'PENDING');
});

// ─── 7. more than six musically meaningful source lanes ─────────────────────

const pad = (prefix, low, high, voice) => [
  note(`${prefix}1`, low, '0', '2', voice),
  note(`${prefix}2`, high, '2', '4', voice),
];

const overflowEvents = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 2),
  ...block('hb', [59, 62], HARMONY_VOICE, 2, 4),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
  ...pad('p', 55, 57, 'track:3/channel:3'),
  ...pad('q', 56, 58, 'track:4/channel:4'),
  ...pad('r', 61, 63, 'track:5/channel:5'),
  ...pad('s', 65, 66, 'track:6/channel:6'),
];

test('fixture 7: lanes beyond six-role capacity overflow explicitly instead of disappearing', () => {
  const candidate = run(overflowEvents);
  assertOrderIndependent(overflowEvents);

  assert.equal(candidate.lanes.length, 8, 'the fixture really does present more lanes than roles');
  const overflow = diagnostic(candidate, 'SOURCE_LANE_OVERFLOW');
  assert.ok(overflow, 'the capacity problem must be reported');
  assert.equal(overflow.deleted, false);
  assert.equal(overflow.roleCapacity, 6);

  assert.ok(candidate.unassigned.length >= 2);
  for (const item of candidate.unassigned) {
    assert.equal(item.reason, 'SIX_ROLE_CAPACITY_EXCEEDED');
    assert.equal(item.provisional, true, 'omission from this proposal is provisional');
    assert.ok(item.eventIds.length, 'the omitted lane still names its source events');
    assert.ok(item.sourceEventIds.length, 'and still names its raw source event ids');
    assert.equal(item.competingRole, 'Chord3', 'the role it lost out on is recorded');
  }
  for (const entry of candidate.ledger.filter(item => item.decision === ROLE_DECISIONS.OMIT_FROM_SIX)) {
    assert.equal(entry.selected, false);
    assert.equal(entry.provisional, true);
    assert.ok(entry.sourcePitch !== null, 'an omitted event keeps its original identity in the ledger');
  }
  // Six-role capacity never authorises deletion.
  assert.equal(candidate.coverage.sourceEventCount,
    candidate.coverage.assignedEventCount + candidate.coverage.pendingEventCount
    + candidate.coverage.unassignedEventCount + candidate.coverage.unsupportedEventCount);
});

// ─── 8. simultaneous same-pitch source events ───────────────────────────────

const unisonEvents = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 2),
  ...block('hb', [59, 62], HARMONY_VOICE, 2, 4),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
  // Same pitch, same onset, two different source voices.
  note('u1', 64, '0', '2', 'track:7/channel:7'),
];

test('fixture 8: simultaneous same-pitch events stay traceable and are reported, not merged', () => {
  const candidate = run(unisonEvents);
  assertOrderIndependent(unisonEvents);

  const doubling = diagnostic(candidate, 'SIMULTANEOUS_SAME_PITCH_DOUBLING');
  assert.ok(doubling, 'same-pitch doubling is a review signal under MASTER_RULES.md §6');
  assert.equal(doubling.deleted, false);
  const pair = doubling.pairs.find(item => item.eventIds.includes('u1'));
  assert.ok(pair, 'the doubled pair must name both source events');
  assert.equal(pair.pitch, 64);
  assert.equal(pair.eventIds.length, 2);
  assert.notEqual(pair.laneIds[0], pair.laneIds[1], 'the two events remain in separate lanes');

  for (const eventId of pair.eventIds) {
    assert.ok(ledgerFor(candidate, eventId).length, `${eventId} must still have a ledger decision`);
  }
});

// ─── 9. one musical role represented by several lanes ───────────────────────

const multiLaneRoleEvents = [
  ...line('x', [72, 74, 76], MELODY_VOICE, 0, { sourceId: 'score-a' }),
  ...line('y', [77, 76, 74], 'track:8/channel:0', 3, { sourceId: 'score-b' }),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 3),
  ...block('hb', [59, 62], HARMONY_VOICE, 3, 6),
  ...line('b', [48, 50, 43, 45, 48, 50], BASS_VOICE),
];

test('fixture 9: a role may group several lanes without any lane losing its provenance', () => {
  const candidate = run(multiLaneRoleEvents);
  assertOrderIndependent(multiLaneRoleEvents);

  const laneIds = candidate.roles.Melody.laneIds;
  assert.equal(laneIds.length, 2);
  const grouped = laneIds.map(id => laneOf(candidate, id));
  assert.notEqual(grouped[0].sourceVoice, grouped[1].sourceVoice, 'the lanes keep separate source voices');
  assert.deepEqual([...grouped[0].sourceIds], ['score-a']);
  assert.deepEqual([...grouped[1].sourceIds], ['score-b']);
  assert.equal(grouped[0].eventIds.some(id => grouped[1].eventIds.includes(id)), false);

  // Grouping the role must not flatten the per-lane provenance away.
  const roleEventIds = new Set(candidate.roles.Melody.eventIds);
  for (const lane of grouped) for (const id of lane.eventIds) assert.ok(roleEventIds.has(id));
  for (const id of roleEventIds) {
    const entries = ledgerFor(candidate, id);
    assert.equal(entries.length, 1);
    assert.ok(laneIds.includes(entries[0].laneId), 'every ledger entry names the lane it came from');
  }
  const multiLane = diagnostic(candidate, 'ROLE_CARRIES_MULTIPLE_LANES');
  assert.ok(multiLane);
  assert.ok(multiLane.roles.some(entry => entry.role === 'Melody' && entry.laneIds.length === 2));
});

// ─── 10. source role change candidates ──────────────────────────────────────

const declaredRoleEvents = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE, 0, { role: 'Melody' }),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 2, { role: 'Chord3' }),
  ...block('hb', [59, 62], HARMONY_VOICE, 2, 4, { role: 'Chord3' }),
  ...line('b', [48, 50, 43, 45], BASS_VOICE, 0, { role: 'Chord2' }),
];

test('fixture 10: a role move is an explicit ledger entry, and an unchanged role is KEEP_ROLE', () => {
  const movedLaneId = `lane:${HARMONY_VOICE}#0`;
  const candidate = run(declaredRoleEvents, { roleOverrides: { [movedLaneId]: 'Chord1' } });

  // Chord3 -> Chord1 is a move, and the ledger states both ends of it.
  const moved = laneOf(candidate, movedLaneId);
  assert.ok(moved.eventIds.length);
  for (const id of moved.eventIds) {
    const [entry] = ledgerFor(candidate, id);
    assert.equal(entry.decision, ROLE_DECISIONS.MOVE_ROLE);
    assert.equal(entry.sourceRole, 'Chord3');
    assert.equal(entry.candidateRole, 'Chord1');
    assert.ok(entry.reason.includes('CALLER_ROLE_OVERRIDE'));
  }
  // The declared Lead and the declared bass keep their roles, also explicitly.
  for (const id of ['m1', 'b1']) {
    const [entry] = ledgerFor(candidate, id);
    assert.equal(entry.decision, ROLE_DECISIONS.KEEP_ROLE);
    assert.equal(entry.sourceRole, entry.candidateRole);
  }
  // Both ends of a move must be diffable from the ledger alone.
  const moves = candidate.ledger.filter(entry => entry.decision === ROLE_DECISIONS.MOVE_ROLE);
  assert.ok(moves.length);
  for (const move of moves) assert.notEqual(move.sourceRole, move.candidateRole);
});

test('fixture 10: a source-supported Lead is never demoted silently', () => {
  // MASTER_RULES.md §4 / SOURCE_POLICY.md §4: demotion needs positive role
  // evidence and a demotion report. G11-C is not that gate, so it refuses.
  const candidate = run(declaredRoleEvents, {
    roleOverrides: { [`lane:${MELODY_VOICE}#0`]: 'Chord3' },
  });

  assert.equal(candidate.roles.Melody.status, 'PENDING');
  assert.deepEqual([...candidate.roles.Melody.reasons], ['DECLARED_LEAD_DEMOTION_UNRESOLVED']);
  assert.equal(candidate.roles.Chord3.laneIds.includes(`lane:${MELODY_VOICE}#0`), false,
    'the override must not move the Lead into an enrichment role');
  // Nor may some other lane quietly be promoted into the vacated Melody role.
  assert.deepEqual([...candidate.roles.Melody.laneIds], []);

  const pendingEntry = candidate.pending.find(item => item.laneId === `lane:${MELODY_VOICE}#0`);
  assert.ok(pendingEntry);
  assert.deepEqual([...pendingEntry.blockers], ['LEAD_DEMOTION_NOT_EVALUATED']);
  assert.equal(pendingEntry.gate, 'studio/backend/arbitration/lead-demotion.mjs#evaluateLeadDemotion');
  for (const id of ['m1', 'm2', 'm3', 'm4']) {
    const [entry] = ledgerFor(candidate, id);
    assert.equal(entry.decision, ROLE_DECISIONS.PENDING);
    assert.equal(entry.proposedRole, 'Chord3');
    assert.equal(entry.sourceRole, 'Melody');
  }
  assert.equal(candidate.core3.status, 'PENDING');
  assert.ok(candidate.core3.missingFunctions.includes('lead-continuity'));
});

test('a declared candidate duplication is recorded as a duplication, never inferred', () => {
  const laneId = `lane:${BASS_VOICE}#0`;
  const candidate = run(declaredRoleEvents, {
    duplications: [{
      laneId,
      roles: ['Chord2', 'Chord5'],
      reason: 'Bass reinforcement requested for the second performer.',
      evidence: ['fixture:review-note-1'],
    }],
  });

  const entries = ledgerFor(candidate, 'b1');
  assert.equal(entries.length, 2, 'one ledger entry per candidate role the event appears in');
  for (const entry of entries) {
    assert.equal(entry.decision, ROLE_DECISIONS.DUPLICATE_WITH_JUSTIFICATION);
    assert.equal(entry.duplicate, true);
    assert.equal(entry.sourcePitch, 48, 'the original source event stays identifiable in every copy');
    assert.deepEqual([...entry.sourceEventIds], ['raw:b1']);
  }
  assert.deepEqual(entries.map(entry => entry.candidateRole).sort(), ['Chord2', 'Chord5']);
  assert.ok(candidate.coverage.duplicatedEventIds.includes('b1'));
  assert.deepEqual([...candidate.roles.Chord5.duplicatedLaneIds], [laneId]);

  // A duplication cannot be conjured without a justification and evidence.
  assert.throws(() => suggestRoleCandidates(project(declaredRoleEvents), {
    duplications: [{ laneId, roles: ['Chord2', 'Chord5'], reason: '', evidence: [] }],
  }), /positive reason/);
  assert.throws(() => suggestRoleCandidates(project(declaredRoleEvents), {
    duplications: [{ laneId, roles: ['Chord2', 'Chord5'], reason: 'why', evidence: [] }],
  }), /explicit evidence/);
});

// ─── 11. shuffled input ─────────────────────────────────────────────────────

test('fixture 11: caller array order never changes the candidate', () => {
  // Every fixture above already runs this check; this pins it as its own
  // regression against Map/Set enumeration order leaking into a decision.
  for (const events of [obviousEvents, enrichedEvents, handOffEvents, essentialInnerEvents, overflowEvents, twoLeadEvents]) {
    assertOrderIndependent(events);
  }
});

// ─── 12. exact rational timing ──────────────────────────────────────────────

const tripletEvents = [
  note('t1', 72, '0', '1/3', MELODY_VOICE),
  note('t2', 74, '1/3', '2/3', MELODY_VOICE),
  note('t3', 76, '2/3', '1', MELODY_VOICE),
  note('t4', 72, '1', '4/3', MELODY_VOICE),
  note('t5', 74, '4/3', '5/3', MELODY_VOICE),
  note('t6', 76, '5/3', '2', MELODY_VOICE),
  ...block('ha', [60, 64], HARMONY_VOICE, '0', '1'),
  ...block('hb', [59, 62], HARMONY_VOICE, '1', '2'),
  note('b1', 48, '0', '2/3', BASS_VOICE),
  note('b2', 50, '2/3', '4/3', BASS_VOICE),
  note('b3', 43, '4/3', '2', BASS_VOICE),
];

test('fixture 12: exact rational timing survives, and no decision reads a float', () => {
  const candidate = run(tripletEvents);
  assertOrderIndependent(tripletEvents);

  // 1/3 must still be 1/3 in the candidate, never 0.3333333333333333.
  const serialized = JSON.stringify(candidate);
  assert.equal(/\d\.\d{3,}/.test(serialized), false, 'no float-projected beat may appear anywhere in the candidate');
  assert.ok(serialized.includes('1/3'));

  const [entry] = ledgerFor(candidate, 't2');
  assert.equal(entry.sourceStart, '1/3');
  assert.equal(entry.sourceEnd, '2/3');
  const melody = laneOf(candidate, `lane:${MELODY_VOICE}#0`);
  assert.equal(melody.metrics.soundingTime, '2');
  assert.deepEqual([...melody.metrics.attackBeats], ['0', '1/3', '2/3', '1', '4/3', '5/3']);
  const bass = laneOf(candidate, `lane:${BASS_VOICE}#0`);
  assert.equal(bass.metrics.timeAsLowestSoundingPitch, '2');
  assert.equal(candidate.core3.status, 'COMPLETE');
});

// ─── 13. G11-B silence-separated chains ─────────────────────────────────────

const silenceSeparatedEvents = [
  // One source voice, two phrases with real silence between them. G11-B packs
  // both chains into a single lane; that is a packing fact, not a continuous
  // voice, and G11-C must not read it as one.
  ...line('v', [72, 74, 76], MELODY_VOICE, 0),
  ...line('w', [76, 74, 72], MELODY_VOICE, 5),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 4),
  ...block('hb', [59, 62], HARMONY_VOICE, 4, 8),
  ...line('b', [48, 50, 43, 45, 48, 50, 43, 45], BASS_VOICE),
];

test('fixture 13: lane packing across a silence is never asserted to be continuous Lead', () => {
  const candidate = run(silenceSeparatedEvents);
  assertOrderIndependent(silenceSeparatedEvents);

  const melody = laneOf(candidate, `lane:${MELODY_VOICE}#0`);
  assert.equal(melody.chainIds.length, 2, 'the two phrases are separate G11-B chains');
  assert.equal(melody.continuity.continuousVoiceAsserted, false);
  assert.ok(melody.continuity.silenceJunctions.length, 'the silence junction is retained');
  assert.equal(melody.continuity.silenceJunctions[0].from, '3');
  assert.equal(melody.continuity.silenceJunctions[0].to, '5');

  const continuity = melody.evidence.find(record => record.signal === 'continuity');
  assert.equal(continuity.strength, 'supporting');
  assert.equal(continuity.measurement.continuousVoiceAsserted, false);

  const packing = diagnostic(candidate, 'LANE_PACKING_IS_NOT_CONTINUITY');
  assert.ok(packing);
  assert.equal(packing.continuousVoiceAsserted, false);
  assert.ok(packing.lanes.some(item => item.laneId === melody.id && item.role === 'Melody'));

  // Lead continuity is still reported, but the claim is bounded.
  assert.equal(candidate.core3.functions.leadContinuity.satisfied, true);
  assert.equal(candidate.core3.functions.leadContinuity.continuousAcrossSilence, false);
  assert.ok(candidate.core3.functions.leadContinuity.silenceJunctions.length);
});

// ─── 14. same MIDI channel, different source track ──────────────────────────

const sharedChannelEvents = [
  ...line('m', [72, 74, 76, 72], 'track:0/channel:1'),
  ...line('n', [60, 62, 64, 60], 'track:1/channel:1'),
  ...line('b', [48, 50, 43, 45], 'track:2/channel:1'),
];

test('fixture 14: one MIDI channel on two tracks keeps two distinct provenances', () => {
  const candidate = run(sharedChannelEvents);
  assertOrderIndependent(sharedChannelEvents);

  const voices = candidate.lanes.map(lane => lane.sourceVoice);
  assert.deepEqual([...new Set(voices)].sort(), ['track:0/channel:1', 'track:1/channel:1', 'track:2/channel:1']);
  assert.equal(candidate.lanes.length, 3, 'a shared channel number must not merge two tracks into one lane');

  for (const lane of candidate.lanes) {
    const identity = lane.evidence.find(record => record.signal === 'source_voice_identity');
    assert.equal(identity.measurement.sourceVoice, lane.sourceVoice);
    assert.equal(identity.evidenceClass, 'symbolic');
  }
  for (const entry of candidate.ledger) {
    assert.ok(entry.sourceVoice, 'every ledger entry names the source voice it came from');
  }
});

// ─── 15. percussion / unsupported source material ───────────────────────────

const percussionEvents = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 2),
  ...block('hb', [59, 62], HARMONY_VOICE, 2, 4),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
  // GM channel 10 (index 9): drum-kit selectors, not pitches.
  note('d1', 36, '0', '1', 'track:9/channel:9', { metadata: { channel: 9 } }),
  note('d2', 38, '1', '2', 'track:9/channel:9', { metadata: { channel: 9 } }),
  // An adapter that tagged its material unsupported instead.
  note('x1', 42, '2', '3', 'track:10/channel:3', { tags: ['unsupported'] }),
];

test('fixture 15: percussion and unsupported material never become a pitched role', () => {
  const candidate = run(percussionEvents);
  assertOrderIndependent(percussionEvents);

  const retained = candidate.unsupportedSourceMaterial.map(item => item.eventId);
  assert.deepEqual(retained, ['d1', 'd2', 'x1']);
  for (const item of candidate.unsupportedSourceMaterial) {
    assert.equal(item.status, 'PENDING');
    assert.ok(item.reason);
    assert.ok(item.sourceEventIds.length, 'the raw source event ids are retained for a later drum-aware stage');
  }
  assert.equal(candidate.unsupportedSourceMaterial[0].reason, 'PERCUSSION_CHANNEL_EVENT');
  assert.equal(candidate.unsupportedSourceMaterial[2].reason, 'UNSUPPORTED_SOURCE_TAG:unsupported');

  const assignedEventIds = new Set(candidate.ledger.map(entry => entry.eventId));
  for (const id of retained) assert.equal(assignedEventIds.has(id), false, `${id} must not receive a pitched role`);
  for (const lane of candidate.lanes) for (const id of retained) assert.equal(lane.eventIds.includes(id), false);

  const reported = diagnostic(candidate, 'UNSUPPORTED_SOURCE_MATERIAL_RETAINED');
  assert.ok(reported);
  assert.equal(reported.deleted, false);
  assert.equal(candidate.coverage.unsupportedEventCount, 3);
  assert.equal(candidate.core3.status, 'COMPLETE', 'pitched Core3 is unaffected by retained drum evidence');
});

// ─── 16. Core3 non-empty but musically incomplete ───────────────────────────

test('fixture 16: three non-empty roles are not completeness', () => {
  // The inner harmony line is pinned into Chord2, so all three Core3 roles hold
  // events -- but nothing in Chord2 has bass-function evidence, and the real
  // bass is pushed out to enrichment.
  const candidate = run(obviousEvents, {
    roleOverrides: {
      [`lane:${HARMONY_VOICE}#1`]: 'Chord2',
      [`lane:${BASS_VOICE}#0`]: 'Chord3',
    },
  });

  for (const role of CORE3_ROLE_NAMES) {
    assert.ok(candidate.roles[role].eventIds.length, `${role} is non-empty`);
  }
  assert.notEqual(candidate.core3.status, 'COMPLETE');
  assert.equal(candidate.core3.status, 'INCOMPLETE');
  assert.ok(candidate.core3.missingFunctions.includes('bass-skeleton'));
  assert.equal(candidate.core3.functions.bassSkeleton.satisfied, false);
  assert.equal(candidate.core3.functions.bassSkeleton.status, 'ABSENT');
  assert.ok(candidate.core3.rationale.some(item => item.code === 'BASS_SKELETON_MISSING'));
});

// ─── 17. essential material placed only in Chord3-Chord5 ────────────────────

test('fixture 17: Full6 may not hide an incomplete Core3', () => {
  // The inner voice that is the only accompaniment across beats 2-4 is pinned
  // into Chord3 instead of Core3.
  const innerLaneId = 'lane:track:6/channel:6#0';
  const candidate = run(essentialInnerEvents, { roleOverrides: { [innerLaneId]: 'Chord3' } });

  assert.ok(candidate.roles.Chord3.laneIds.includes(innerLaneId));
  assert.ok(candidate.core3.essentialEventIds.length, 'the essential events are still identified');

  assert.equal(candidate.core3.status, 'INCOMPLETE');
  assert.equal(candidate.core3.identityDependsOnEnrichment, true);
  assert.ok(candidate.core3.missingFunctions.includes('essential-inner-support'));
  assert.deepEqual([...candidate.core3.functions.essentialInnerSupport.misplacedLaneIds], [innerLaneId]);
  assert.ok(candidate.core3.rationale.some(item => item.code === 'ESSENTIAL_MATERIAL_OUTSIDE_CORE3'));
  assert.ok(candidate.core3.conflicts.some(item => item.code === 'ESSENTIAL_MATERIAL_OUTSIDE_CORE3'));

  const misplaced = diagnostic(candidate, 'ESSENTIAL_MATERIAL_IN_ENRICHMENT');
  assert.ok(misplaced);
  assert.equal(misplaced.deleted, false);
  assert.deepEqual([...misplaced.laneIds], [innerLaneId]);

  // Full6 must report the dependency rather than present itself as a benefit.
  assert.equal(candidate.full6.status, 'CORE3_DEPENDENCY');
  assert.equal(candidate.full6.roleContributions.Chord3.status, 'ESSENTIAL_MATERIAL_MISPLACED');
  const entry = candidate.full6.enrichmentRationale.find(item => item.laneId === innerLaneId);
  assert.equal(entry.essential, true);
  assert.equal(entry.removingLeavesCore3Intact, false);
});

// ─── 18. redundant enrichment ───────────────────────────────────────────────

const redundantEvents = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 2),
  ...block('hb', [59, 62], HARMONY_VOICE, 2, 4),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
  // A second source voice doubling the principal harmony note for note.
  note('dup1', 64, '0', '2', 'track:7/channel:7'),
  note('dup2', 62, '2', '4', 'track:7/channel:7'),
];

test('fixture 18: a duplicating enrichment lane is reported as duplication, not as a benefit', () => {
  const candidate = run(redundantEvents);
  assertOrderIndependent(redundantEvents);

  const dupLaneId = 'lane:track:7/channel:7#0';
  const entry = candidate.full6.enrichmentRationale.find(item => item.laneId === dupLaneId);
  assert.ok(entry, 'the duplicating lane still holds an enrichment slot and is still reported');
  assert.equal(entry.useful, false);
  assert.ok(entry.duplicationRisks.length);
  assert.equal(entry.duplicationRisks[0].code, 'DUPLICATES_CORE3_PITCHES');
  assert.equal(entry.duplicationRatio, '1');
  assert.equal(entry.measurement.addedPitchClassTime, '0', 'it adds no pitch class Core3 lacks');

  assert.ok(candidate.full6.duplicationRisks.some(risk => risk.laneId === dupLaneId));
  assert.equal(candidate.full6.status, 'REVIEW');

  // Reported, never removed.
  const duplication = diagnostic(candidate, 'ROLE_DUPLICATION');
  assert.ok(duplication);
  assert.equal(duplication.deleted, false);
  for (const id of ['dup1', 'dup2']) assert.equal(ledgerFor(candidate, id).length, 1);
  assert.equal(candidate.core3.status, 'COMPLETE', 'the duplication does not damage Core3');
});

// ─── 19. useful enrichment ──────────────────────────────────────────────────

const usefulEnrichmentEvents = [
  ...line('m', [72, 74, 76, 72], MELODY_VOICE),
  ...block('ha', [60, 64], HARMONY_VOICE, 0, 2),
  ...block('hb', [59, 62], HARMONY_VOICE, 2, 4),
  ...line('b', [48, 50, 43, 45], BASS_VOICE),
  // A counter-line: its own pitches, on its own offbeat attacks.
  ...[0, 1, 2, 3].map(step =>
    note(`c${step}`, [66, 69, 68, 65][step], String(f(1).div(2).add(step)), String(f(3).div(2).add(step)), 'track:7/channel:7')),
];

// Two independently-varied lines are genuinely ambiguous on derived evidence
// alone -- fixture 6 shows that case staying PENDING. Here the score says which
// part is the Lead, so the counter-line can be read as enrichment rather than as
// a rival Lead. Trusted symbolic role evidence requires a citation.
const leadDeclared = {
  sourceRoleEvidence: [{ sourceVoice: MELODY_VOICE, role: 'Melody', citation: 'fixture:score P1 voice 1' }],
};

test('fixture 19: source-supported counter-line is distinguished from duplication', () => {
  const candidate = run(usefulEnrichmentEvents, leadDeclared);
  assertOrderIndependent(usefulEnrichmentEvents, leadDeclared);

  const melody = laneOf(candidate, `lane:${MELODY_VOICE}#0`);
  assert.equal(melody.roleSupport.Melody.tierName, 'DECLARED_SOURCE_ROLE');
  const trusted = melody.evidence.find(record => record.signal === 'trusted_symbolic_role');
  assert.equal(trusted.strength, 'primary');
  assert.equal(trusted.evidenceClass, 'symbolic');
  assert.equal(trusted.measurement.citation, 'fixture:score P1 voice 1');

  const counterLaneId = 'lane:track:7/channel:7#0';
  const entry = candidate.full6.enrichmentRationale.find(item => item.laneId === counterLaneId);
  assert.ok(entry);
  assert.equal(entry.useful, true);
  assert.deepEqual([...entry.duplicationRisks], []);
  assert.ok(entry.addedFunctions.includes('counter-line'));
  assert.ok(entry.addedFunctions.includes('inner-harmony'));
  assert.ok(f(entry.measurement.addedPitchClassTime).cmp(0) > 0);
  assert.equal(entry.measurement.independentAttacks, 4, 'none of its attacks coincide with a Core3 attack');
  assert.equal(entry.removingLeavesCore3Intact, true);

  assert.ok(candidate.full6.addedFunctions.includes('counter-line'));
  assert.equal(candidate.full6.roleContributions.Chord3.status, 'USEFUL');
  assert.equal(candidate.core3.status, 'COMPLETE');
});

// ─── 20. fewer-than-three-role diagnostics ──────────────────────────────────

test('fixture 20: one- and two-role readings are diagnostics, never a completeness gate', () => {
  const soloEvents = line('m', [72, 74, 76, 72], MELODY_VOICE);
  const solo = run(soloEvents);
  assert.equal(solo.roles.Melody.status, 'ASSIGNED');
  assert.equal(solo.roles.Chord1.status, 'EMPTY');
  assert.equal(solo.roles.Chord2.status, 'EMPTY');
  assert.equal(solo.core3.status, 'INCOMPLETE');
  assert.deepEqual([...solo.core3.missingFunctions], ['principal-harmony', 'bass-skeleton']);

  const duoEvents = [...soloEvents, ...line('b', [48, 50, 43, 45], BASS_VOICE)];
  const duo = run(duoEvents);
  assert.equal(duo.roles.Chord2.status, 'ASSIGNED');
  assert.equal(duo.core3.status, 'INCOMPLETE');
  assert.ok(duo.core3.missingFunctions.includes('principal-harmony'));

  for (const candidate of [solo, duo]) {
    const reduced = candidate.reducedRoleDiagnostics;
    assert.equal(reduced.canonicalCompletenessGate, 'CORE3');
    assert.deepEqual([...reduced.rolePriority], ['Melody', 'Chord1', 'Chord2']);
    assert.deepEqual(reduced.tiers.map(tier => tier.roleCount), [1, 2]);
    for (const tier of reduced.tiers) {
      assert.equal(tier.canonicalCompleteness, 'NOT_DEFINED');
      assert.equal(tier.pendingReference, 'PENDING.md P17');
      assert.ok(tier.missingFunctions.length, 'a reduced tier must say which musical functions it loses');
    }
    // No reduced tier may ever be reported as Canonically complete.
    assert.equal(JSON.stringify(reduced).includes('"COMPLETE"'), false);
    assert.equal(candidate.core3.canonicallyCompleteGate, 'CORE3');
  }
  assert.equal(ROLE_CANDIDATE_STATUS.oneRoleCompletenessRule, false);
  assert.equal(ROLE_CANDIDATE_STATUS.twoRoleCompletenessRule, false);
  assert.equal(ROLE_CANDIDATE_STATUS.reducedRolePolicy, 'PENDING.md P17 unresolved');
});

// ─── scope and gate boundaries ──────────────────────────────────────────────

test('the stage certifies no acceptance gate and performs no Final work', () => {
  const candidate = run(obviousEvents);
  assert.equal(candidate.stageKind, 'ARRANGEMENT_CANDIDATE');
  assert.equal(candidate.schema, 'mabinogi-mobile-mml-studio/role-candidate-arrangement@1');
  for (const gate of ['TECHNICAL_PASS', 'SOURCE_PASS', 'PLAYER_READBACK_PASS', 'AUDIO_ALIGNMENT_PASS', 'MOBILE_ADAPTATION_PASS', 'IN_GAME_ACCEPTED']) {
    assert.ok(candidate.notice.includes(gate), `${gate} must be explicitly disclaimed`);
  }
  const serialized = JSON.stringify(candidate);
  assert.equal(serialized.includes('MML@'), false, 'no paste-ready MML may be emitted here');

  for (const key of [
    'sourceEventDeletion', 'sourceEventAddition', 'pitchRewrite', 'onsetRewrite', 'durationRewrite',
    'prominenceRewrite', 'octaveShift', 'quantization', 'laneMerge', 'bestSixOptimizer',
    'collisionRepair', 'theoryCleanupPass', 'finalVolumeMapping', 'finalInstrumentAssignment',
    'finalTempoMapEmission', 'finalMmlEmission', 'pasteReadyMmlEmission', 'mobileRegisterAdaptation',
    'audioEvidenceIntake', 'performerCountAllocation',
    'certifiesTechnicalPass', 'certifiesSourcePass', 'certifiesPlayerReadbackPass',
    'certifiesAudioAlignmentPass', 'certifiesMobileAdaptationPass', 'certifiesInGameAccepted',
  ]) {
    assert.equal(ROLE_CANDIDATE_STATUS[key], false, `${key} must be declared out of scope`);
  }
  assert.equal(ROLE_CANDIDATE_STATUS.sourceEventCoverage, 'lossless');
  assert.equal(ROLE_CANDIDATE_STATUS.referenceStatus, 'MML_MABI_REFERENCE_NOT_VERIFIED');
});

test('heuristic thresholds are declared as implementer values beside their measurements', () => {
  const candidate = run(obviousEvents);
  assert.ok(candidate.thresholds.notice.includes('Not Canonical rules'));
  const melody = laneOf(candidate, `lane:${MELODY_VOICE}#0`);
  const contour = melody.evidence.find(record => record.signal === 'melodic_contour');
  assert.deepEqual(contour.threshold, { minDistinctPitches: 3, minPitchChangeRatio: '1/2' });
  // No aggregate score may stand in for the evidence that produced it.
  assert.equal(JSON.stringify(candidate).includes('melodyScore'), false);
  for (const lane of candidate.lanes) {
    for (const record of lane.evidence) {
      assert.ok(['primary', 'supporting', 'conflict'].includes(record.strength));
      assert.ok(record.measurement, 'every evidence record keeps its own measurement');
      assert.ok(['symbolic', 'symbolic-derived'].includes(record.evidenceClass),
        'symbolic and audio evidence stay distinct classes; audio never reaches this layer');
    }
  }
});

test('input contracts fail closed rather than guessing', () => {
  assert.throws(() => suggestRoleCandidates(null), /Canonical project/);
  assert.throws(() => suggestRoleCandidates({ events: 'no' }), /project.events must be an array/);
  assert.throws(() => suggestRoleCandidates(project(obviousEvents), { roleOverrides: { 'lane:nope#0': 'Melody' } }),
    /unknown candidate lane/);
  assert.throws(() => suggestRoleCandidates(project(obviousEvents), { roleOverrides: { [`lane:${BASS_VOICE}#0`]: 'Chord9' } }),
    /must be null or one of/);
  assert.throws(() => suggestRoleCandidates(project(obviousEvents), {
    sourceRoleEvidence: [{ sourceVoice: MELODY_VOICE, role: 'Melody' }],
  }), /requires a citation/);
  assert.throws(() => suggestRoleCandidates(project(obviousEvents), {
    sourceRoleEvidence: [{ sourceVoice: MELODY_VOICE, role: 'Melody', citation: 'c', evidenceClass: 'audio' }],
  }), /audio evidence is a separate class/);
  const duplicated = [...obviousEvents, obviousEvents[0]];
  assert.throws(() => suggestRoleCandidates(project(duplicated)), /duplicate source event id/);
});

test('a caller may exclude a lane from the six roles without losing it', () => {
  const laneId = `lane:${HARMONY_VOICE}#2`;
  const candidate = run(obviousEvents, { roleOverrides: { [laneId]: null } });
  const omitted = candidate.unassigned.find(item => item.laneId === laneId);
  assert.ok(omitted);
  assert.equal(omitted.reason, 'CALLER_EXCLUDED_FROM_SIX');
  assert.equal(omitted.provisional, true);
  assert.ok(omitted.eventIds.length);
  for (const id of omitted.eventIds) {
    const [entry] = ledgerFor(candidate, id);
    assert.equal(entry.decision, ROLE_DECISIONS.OMIT_FROM_SIX);
    assert.equal(entry.candidateRole, null);
  }
});

// ─── work-shape sanity on a moderate synthetic score ────────────────────────
//
// The repository's existing convention is a work-shape bound, not a wall-clock
// budget (see micro-timing-performance.test.mjs), so these assertions are about
// how the scans grow, not how fast the machine is.

function stressEvents(bars) {
  const voices = [
    { voice: MELODY_VOICE, base: 72, step: 1, duration: 1 },
    { voice: HARMONY_VOICE, base: 60, step: 2, duration: 2 },
    { voice: HARMONY_VOICE, base: 64, step: 2, duration: 2 },
    { voice: BASS_VOICE, base: 43, step: 1, duration: 1 },
    { voice: 'track:3/channel:3', base: 55, step: 4, duration: 4 },
    { voice: 'track:4/channel:4', base: 79, step: 2, duration: 2 },
  ];
  const events = [];
  voices.forEach((entry, index) => {
    for (let step = 0; step * entry.duration < bars * 4; step++) {
      const start = step * entry.duration;
      events.push(note(`s${index}-${step}`, entry.base + ((step * entry.step) % 7),
        String(start), String(start + entry.duration), entry.voice));
    }
  });
  return events;
}

test('candidate generation stays output-sensitive on a moderate full-song score', () => {
  const measurements = [25, 50, 100, 200].map(bars => {
    const events = stressEvents(bars);
    const instrumentation = {};
    const candidate = suggestRoleCandidates(project(events), { instrumentation });
    assert.equal(candidate.coverage.complete, true, 'a large score must still be fully accounted for');
    assert.equal(candidate.coverage.sourceEventCount, events.length);
    const reportedPairs = (diagnostic(candidate, 'SIMULTANEOUS_SAME_PITCH_DOUBLING')?.pairs.length ?? 0)
      + (diagnostic(candidate, 'SUSTAINED_SAME_PITCH_OVERLAP')?.pairs.length ?? 0);
    const reportedIntervals = diagnostic(candidate, 'LOW_MID_CLOSE_INTERVAL')?.candidates.length ?? 0;

    // One sweep over the exact boundary grid, not a rescan per note.
    assert.ok(instrumentation.gridIntervals <= 2 * events.length,
      `grid grew to ${instrumentation.gridIntervals} intervals for ${events.length} notes`);
    assert.ok(instrumentation.gridActiveInspections <= 2 * (events.length + instrumentation.gridIntervals),
      `sweep inspected ${instrumentation.gridActiveInspections} active entries for ${events.length} notes`);
    // The same-pitch scan is bucketed by pitch and breaks early, so it stays
    // linear in notes plus reported pairs rather than quadratic in the score.
    assert.ok(instrumentation.samePitchInspections <= 4 * (events.length + reportedPairs + 1),
      `same-pitch scan inspected ${instrumentation.samePitchInspections} pairs for ${events.length} notes`);
    assert.ok(instrumentation.closeIntervalInspections <= 4 * (instrumentation.gridActiveInspections + reportedIntervals + 1),
      `close-interval scan inspected ${instrumentation.closeIntervalInspections} pairs`);
    return { notes: events.length, ...instrumentation };
  });

  // Doubling the score must not multiply the work by four.
  for (let i = 1; i < measurements.length; i++) {
    const previous = measurements[i - 1];
    const current = measurements[i];
    assert.equal(current.notes, previous.notes * 2);
    for (const counter of ['gridIntervals', 'gridActiveInspections', 'samePitchInspections', 'closeIntervalInspections']) {
      assert.ok(current[counter] <= 3 * previous[counter],
        `${counter} went from ${previous[counter]} to ${current[counter]} when the score doubled`);
    }
  }
});

test('a large score with many source voices still overflows rather than dropping lanes', () => {
  const events = [
    ...stressEvents(20),
    ...pad('z', 50, 52, 'track:5/channel:5'),
    ...pad('y', 51, 53, 'track:6/channel:6'),
    ...pad('x', 68, 70, 'track:7/channel:7'),
  ];
  const candidate = run(events);
  assert.ok(candidate.lanes.length > SIX_ROLES.length);
  assert.ok(candidate.unassigned.length > 0);
  assert.equal(candidate.coverage.complete, true);
  assert.ok(diagnostic(candidate, 'SOURCE_LANE_OVERFLOW'));
});

// ─── remaining cross-role review signals ────────────────────────────────────

test('competing bass candidates stay PENDING rather than one being picked arbitrarily', () => {
  // Two overlapping voices that each hold the harmonic floor for half of their
  // own sounding time. Neither has a stronger claim, so Chord2 stays open.
  const events = [
    ...line('m', [72, 74, 76, 72], MELODY_VOICE),
    ...block('ha', [60, 64], HARMONY_VOICE, 0, 2),
    ...block('hb', [59, 62], HARMONY_VOICE, 2, 4),
    ...line('p', [48, 48, 52, 52], 'track:5/channel:5'),
    ...line('q', [50, 50, 46, 46], 'track:6/channel:6'),
  ];
  const candidate = run(events);
  assertOrderIndependent(events);

  assert.equal(candidate.roles.Chord2.status, 'PENDING');
  assert.deepEqual([...candidate.roles.Chord2.laneIds], []);
  assert.deepEqual([...candidate.roles.Chord2.competingLaneIds].sort(),
    ['lane:track:5/channel:5#0', 'lane:track:6/channel:6#0']);

  const competing = diagnostic(candidate, 'COMPETING_BASS_CANDIDATES');
  assert.ok(competing);
  assert.equal(competing.deleted, false);
  assert.equal(candidate.core3.status, 'PENDING');
  assert.ok(candidate.core3.missingFunctions.includes('bass-skeleton'));
  for (const item of candidate.pending.filter(entry => entry.proposedRole === 'Chord2')) {
    assert.ok(item.eventIds.length);
    assert.ok(item.evidenceIds.length);
  }
});

test('sustained same-pitch overlap, dense attacks and low/mid compression are review signals only', () => {
  const events = [
    ...line('m', [72, 74, 76, 72], MELODY_VOICE),
    ...block('ha', [60, 64], HARMONY_VOICE, 0, 2),
    ...block('hb', [59, 62], HARMONY_VOICE, 2, 4),
    ...line('b', [48, 50, 43, 45], BASS_VOICE),
    // Same pitch as the harmony, different onset, overlapping in time.
    note('s1', 60, '1', '3', 'track:7/channel:7'),
    // A minor second against the bass, low in the register.
    note('s2', 49, '0', '1', 'track:8/channel:8'),
  ];
  const candidate = run(events);
  assertOrderIndependent(events);

  const sustained = diagnostic(candidate, 'SUSTAINED_SAME_PITCH_OVERLAP');
  assert.ok(sustained, 'sustained same-pitch overlap must be reported');
  assert.equal(sustained.deleted, false);
  assert.equal(sustained.truncated, false, 'MASTER_RULES.md §6 forbids truncating to hide a collision here');
  assert.equal(sustained.rolePairsPossible, 15, 'all 15 role pairs are in scope (PENDING.md P15)');
  assert.equal(sustained.pendingReference, 'PENDING.md P11, P15');
  const pair = sustained.pairs.find(item => item.eventIds.includes('s1'));
  assert.ok(pair);
  assert.equal(pair.pitch, 60);
  assert.equal(pair.from, '1');

  const close = diagnostic(candidate, 'LOW_MID_CLOSE_INTERVAL');
  assert.ok(close);
  assert.equal(close.repaired, false);
  assert.ok(close.candidates.some(item => item.intervalName === 'm2' && item.eventIds.includes('s2')));
  for (const item of close.candidates) {
    assert.ok(item.pitches[0] < 60, 'only low/mid compression is reported');
    assert.ok([1, 11, 13].includes(item.semitones));
  }

  const dense = diagnostic(candidate, 'DENSE_SIMULTANEOUS_ATTACKS');
  assert.ok(dense, 'five or more roles attacking together is a review signal');
  assert.equal(dense.deleted, false);
  for (const occurrence of dense.occurrences) {
    assert.ok(occurrence.roleCount >= 5);
    assert.equal(occurrence.justificationRequired, true);
  }

  // Every event named by a review signal still has its own ledger decision.
  const named = new Set([
    ...sustained.pairs.flatMap(item => item.eventIds),
    ...close.candidates.flatMap(item => item.eventIds),
    ...dense.occurrences.flatMap(item => item.eventIds),
  ]);
  for (const id of named) assert.ok(ledgerFor(candidate, id).length, `${id} must still be decided, not removed`);
  assert.equal(candidate.coverage.complete, true);
});

test('the coverage audit fails closed when supplied decompositions do not cover the project', () => {
  // A caller may pass its own G11-B output. If that output is missing events,
  // the candidate must say so rather than quietly proposing roles for a subset.
  const candidate = suggestRoleCandidates(project(obviousEvents), { decompositions: [] });
  assert.equal(candidate.coverage.complete, false);
  assert.equal(candidate.coverage.missingEventIds.length, obviousEvents.length);
  const mismatch = diagnostic(candidate, 'CANDIDATE_COVERAGE_MISMATCH');
  assert.ok(mismatch);
  assert.deepEqual([...mismatch.unknownEventIds], []);
  assert.deepEqual([...mismatch.mutatedEventIds], []);
  assert.throws(() => suggestRoleCandidates(project(obviousEvents), { decompositions: 'no' }),
    /must be an array of G11-B decomposition results/);
});

test('an empty or wholly unsupported project fails closed instead of inventing a candidate', () => {
  const empty = run([]);
  assert.equal(empty.lanes.length, 0);
  assert.equal(empty.core3.status, 'INCOMPLETE');
  assert.deepEqual([...empty.core3.missingFunctions], ['lead-continuity', 'principal-harmony', 'bass-skeleton']);
  for (const role of SIX_ROLES) assert.equal(empty.roles[role].status, 'EMPTY');

  const drumsOnly = run([note('d1', 36, '0', '1', 'track:9/channel:9', { metadata: { channel: 9 } })]);
  assert.equal(drumsOnly.lanes.length, 0, 'drum evidence never becomes a pitched lane');
  assert.equal(drumsOnly.unsupportedSourceMaterial.length, 1);
  assert.equal(drumsOnly.core3.status, 'INCOMPLETE');
  assert.equal(drumsOnly.coverage.complete, true);
});
