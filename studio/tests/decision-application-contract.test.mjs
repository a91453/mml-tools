import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAcceptedArrangement,
  createAcceptedDecision,
  canonicalJson,
  contentDigest,
  baselineIdentityOf,
  ACCEPTED_DECISION_TYPES,
  RECOGNIZED_UNSUPPORTED_DECISION_TYPES,
  DECISION_REJECTION,
  DECISION_APPLICATION_STATUS,
  DOWNSTREAM_CONTRACT,
} from '../backend/arrangement/decision-application.mjs';
import { suggestRoleCandidates } from '../backend/arrangement/role-candidates.mjs';
import { roleDeclaredBaseline, acceptanceFor, CANONICAL_IDENTITY, reverseKeys } from './fixtures/g11d-fixtures.mjs';

// G11-D contract layer.
//
// Before anything is applied, the accepted-decision schema has to be the thing
// that stops a suggestion, a heuristic or a half-filled form from becoming an
// accepted arrangement. These are the regressions for that layer: what a
// decision must carry, what it may never carry, and what the stage says about
// itself.

const baseline = roleDeclaredBaseline();
const suggestion = suggestRoleCandidates(roleDeclaredBaseline({ withRoles: false }));

const keepDecision = (overrides = {}) => ({
  id: 'd1',
  type: 'KEEP',
  target: { eventIds: ['lead-1'] },
  fromRole: 'Melody',
  reason: 'Fixture: the score keeps this on the lead staff.',
  evidence: ['fixture:score bar 1'],
  acceptance: acceptanceFor(baseline),
  ...overrides,
});

// ─── the stage describes itself honestly ────────────────────────────────────

test('G11-D names itself an implementation stage and certifies no Canonical gate', () => {
  assert.equal(DECISION_APPLICATION_STATUS.stageNameAuthority, 'IMPLEMENTATION_STAGE_NAME_NOT_CANONICAL_RULE_IDENTIFIER');
  for (const key of [
    'certifiesTechnicalPass', 'certifiesSourcePass', 'certifiesPlayerReadbackPass',
    'certifiesAudioAlignmentPass', 'certifiesMobileAdaptationPass', 'certifiesInGameAccepted',
    'certifiesCore3Complete', 'certifiesReadiness',
  ]) assert.equal(DECISION_APPLICATION_STATUS[key], false, `${key} must stay false`);

  // The shortcuts MASTER_RULES.md §4 forbids, and the conflict resolution this
  // stage must never perform, are recorded as facts rather than left implicit.
  for (const key of [
    'suggestionAutoAcceptance', 'highestPitchBecomesMelody', 'notProvenVocalDemotes',
    'lastDecisionWinsConflictResolution', 'sourceAuthorityBreaksTies', 'randomOrTimestampIdentity',
    'pitchRewrite', 'octaveShift', 'onsetRewrite', 'durationRewrite', 'prominenceRewrite',
    'tempoMapRewrite', 'meterMapRewrite', 'mmlEmission', 'mmlCompression', 'characterLimitReduction',
  ]) assert.equal(DECISION_APPLICATION_STATUS[key], false, `${key} must stay false`);

  assert.deepEqual([...DOWNSTREAM_CONTRACT.certifiesGates], []);
  assert.ok(DOWNSTREAM_CONTRACT.mustRerun.some(item => item.includes('readiness')));
  assert.ok(DOWNSTREAM_CONTRACT.mustRerun.some(item => item.includes('core3')));
  assert.ok(DOWNSTREAM_CONTRACT.mustRerun.some(item => item.includes('lead-demotion')));
  assert.ok(DOWNSTREAM_CONTRACT.mustRerun.some(item => item.includes('harmony')));
});

// ─── identity is content-derived and key-order independent ──────────────────

test('canonical serialization ignores object key order', () => {
  const left = { b: 1, a: [{ y: 2, x: 3 }] };
  const right = { a: [{ x: 3, y: 2 }], b: 1 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(contentDigest(left), contentDigest(right));
  // ...and still separates structurally different values.
  assert.notEqual(contentDigest(left), contentDigest({ b: 1, a: [{ y: 2, x: 4 }] }));
});

test('baseline identity is derived from content, not from order or presentation', () => {
  const identity = baselineIdentityOf(baseline);
  const reordered = { ...baseline, events: [...baseline.events].reverse() };
  assert.equal(baselineIdentityOf(reordered).eventIdDigest, identity.eventIdDigest);
  assert.equal(baselineIdentityOf(reordered).sourceIdentityDigest, identity.sourceIdentityDigest);
  assert.equal(baselineIdentityOf(reverseKeys(baseline)).contentDigest, identity.contentDigest);
  assert.equal(identity.eventCount, baseline.events.length);
  assert.equal(identity.noteEventCount, baseline.events.length);
});

// ─── acceptance is required, and cannot be defaulted ────────────────────────

test('a decision without an explicit acceptance record cannot be constructed', () => {
  assert.throws(() => createAcceptedDecision({ ...keepDecision(), acceptance: undefined }), /acceptance is required/);
  for (const state of ['SUGGESTED', 'PENDING', 'accepted', 'ACCEPTED ', true, 1, null]) {
    assert.throws(
      () => createAcceptedDecision(keepDecision({ acceptance: { ...acceptanceFor(baseline), state } })),
      /state must be exactly "ACCEPTED"/,
      `acceptance.state ${JSON.stringify(state)} must not be read as acceptance`,
    );
  }
  assert.throws(() => createAcceptedDecision(keepDecision({ acceptance: { ...acceptanceFor(baseline), acceptedBy: '  ' } })), /acceptedBy/);
});

test('every binding a decision needs to be replay-safe is mandatory', () => {
  for (const key of ['baselineContentDigest', 'sourceIdentityDigest', 'canonicalRulesSnapshotSha']) {
    const acceptance = { ...acceptanceFor(baseline) };
    delete acceptance[key];
    assert.throws(() => createAcceptedDecision(keepDecision({ acceptance })), new RegExp(key));
  }
  // `reviewedRevisionId: null` is meaningful -- "reviewed against the
  // Source-Faithful Baseline" -- so it is allowed, while an omitted binding is
  // not silently treated as null.
  assert.doesNotThrow(() => createAcceptedDecision(keepDecision()));
});

// ─── a G11-C suggestion is never an acceptance ──────────────────────────────

test('a G11-C ledger entry cannot be handed to G11-D as an accepted decision', () => {
  const entry = suggestion.ledger.find(item => item.decision === 'ASSIGN_ROLE' || item.decision === 'OMIT_FROM_SIX');
  assert.ok(entry, 'the fixture must actually produce a suggestion ledger');
  // The G11-C entry shape carries a decision name, a role and a reason, and is
  // still refused: none of its fields is an acceptance record.
  assert.throws(() => createAcceptedDecision(entry), /unsupported field|acceptance is required/);
  const result = applyAcceptedArrangement({
    baseline, suggestion, decisions: [entry], canonicalIdentity: CANONICAL_IDENTITY,
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.candidate, null);
  assert.ok(result.rejected.some(item => item.code === DECISION_REJECTION.DECISION_MALFORMED));
});

test('no export turns a suggestion into decisions', async () => {
  const module = await import('../backend/arrangement/decision-application.mjs');
  const suspicious = Object.keys(module).filter(name => /accept(All|From)|fromSuggestion|autoApply|applySuggest/i.test(name));
  assert.deepEqual(suspicious, [], 'G11-D must expose no suggestion-to-acceptance shortcut');
});

// ─── the schema refuses to carry an edit ────────────────────────────────────

test('a role decision cannot smuggle a pitch, register, timing or prominence edit', () => {
  for (const field of ['pitch', 'pitchShift', 'octave', 'octaveShift', 'transpose', 'semitones', 'start', 'end', 'onset', 'duration', 'volume', 'prominence', 'tempo', 'bpm', 'meter', 'sourceIds', 'sourceEventIds']) {
    assert.throws(
      () => createAcceptedDecision({ ...keepDecision(), [field]: 1 }),
      /unsupported field/,
      `decision.${field} must be refused, not ignored`,
    );
  }
  assert.throws(() => createAcceptedDecision(keepDecision({ target: { eventIds: ['lead-1'], pitch: 60 } })), /unsupported field/);
  assert.throws(() => createAcceptedDecision(keepDecision({ acceptance: { ...acceptanceFor(baseline), status: 'PASS' } })), /unsupported field/);
});

test('an unknown decision type fails, and a recognized-but-deferred one says so', () => {
  assert.throws(() => createAcceptedDecision(keepDecision({ type: 'MAKE_IT_BETTER' })), /unknown decision.type/);

  for (const type of Object.keys(RECOGNIZED_UNSUPPORTED_DECISION_TYPES)) {
    const decision = createAcceptedDecision(keepDecision({ id: `u-${type}`, type }));
    assert.equal(decision.supported, false);
    const result = applyAcceptedArrangement({ baseline, decisions: [decision], canonicalIdentity: CANONICAL_IDENTITY });
    assert.equal(result.status, 'UNSUPPORTED', `${type} must report UNSUPPORTED, not be applied or silently dropped`);
    assert.equal(result.candidate, null);
    const rejection = result.rejected.find(item => item.decisionId === `u-${type}`);
    assert.equal(rejection.code, DECISION_REJECTION.UNSUPPORTED_DECISION_TYPE);
    assert.ok(rejection.detail.length > 0, 'a deferred type must say why it is deferred');
  }
});

// ─── per-type structural obligations ────────────────────────────────────────

test('each decision type demands the fields that make it reviewable', () => {
  // MOVE_ROLE must state where the event is moving from, so a stale move
  // cannot be replayed onto a role the reviewer never saw.
  assert.throws(() => createAcceptedDecision(keepDecision({ type: 'MOVE_ROLE', toRole: 'Chord1', fromRole: undefined })), /requires decision.fromRole/);
  assert.throws(() => createAcceptedDecision(keepDecision({ type: 'MOVE_ROLE', fromRole: 'Melody' })), /decision.toRole must be one of/);
  assert.throws(() => createAcceptedDecision(keepDecision({ type: 'ASSIGN_ROLE', toRole: 'Chord9' })), /decision.toRole must be one of/);
  assert.throws(() => createAcceptedDecision(keepDecision({ type: 'OMIT_FROM_SIX', toRole: 'Chord1' })), /takes no destination role/);
  assert.throws(() => createAcceptedDecision(keepDecision({ type: 'DUPLICATE_WITH_JUSTIFICATION', toRoles: ['Chord3'], evidence: [] })), /requires explicit evidence/);
  assert.throws(() => createAcceptedDecision(keepDecision({ type: 'DUPLICATE_WITH_JUSTIFICATION', toRole: 'Chord3' })), /uses decision.toRoles/);
  assert.throws(() => createAcceptedDecision(keepDecision({ reason: '   ' })), /positive reason/);
});

test('a decision must name exactly one target', () => {
  assert.throws(() => createAcceptedDecision(keepDecision({ target: {} })), /must name a laneId or eventIds/);
  assert.throws(() => createAcceptedDecision(keepDecision({ target: { laneId: 'lane:lead#0', eventIds: ['lead-1'] } })), /never both/);
  assert.throws(() => createAcceptedDecision(keepDecision({ target: { eventIds: ['lead-1', 'lead-1'] } })), /duplicates/);
  assert.throws(() => createAcceptedDecision(keepDecision({ target: { eventIds: [] } })), /must not be empty/);
});

test('a section window must be an exact rational range', () => {
  assert.doesNotThrow(() => createAcceptedDecision(keepDecision({ section: { start: '1/3', end: '2/3' } })));
  assert.throws(() => createAcceptedDecision(keepDecision({ section: { start: '2', end: '1' } })), /greater than/);
  assert.throws(() => createAcceptedDecision(keepDecision({ section: { start: 0, end: 4, bars: 2 } })), /unsupported field/);
});

// ─── Canonical identity binding ─────────────────────────────────────────────

test('an application must be bound to a PUBLISHED Canonical release', () => {
  assert.throws(() => applyAcceptedArrangement({ baseline, decisions: [], canonicalIdentity: undefined }), /canonicalIdentity is required/);
  assert.throws(
    () => applyAcceptedArrangement({ baseline, decisions: [], canonicalIdentity: { ...CANONICAL_IDENTITY, canonical_status: 'DRAFT' } }),
    /canonical_status must be PUBLISHED/,
  );
  assert.throws(
    () => applyAcceptedArrangement({ baseline, decisions: [], canonicalIdentity: { ...CANONICAL_IDENTITY, rules_snapshot_sha: 'main' } }),
    /must be a full Git commit SHA/,
  );
});

test('an empty decision set does not mint a revision', () => {
  const result = applyAcceptedArrangement({ baseline, decisions: [], canonicalIdentity: CANONICAL_IDENTITY });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.candidate, null);
  assert.equal(result.revision, null);
  assert.ok(result.rejected.some(item => item.code === 'DECISION_SET_EMPTY'));
});

test('the accepted-decision vocabulary is exactly the five applicable types', () => {
  assert.deepEqual(Object.keys(ACCEPTED_DECISION_TYPES).sort(), [
    'ASSIGN_ROLE', 'DUPLICATE_WITH_JUSTIFICATION', 'KEEP', 'MOVE_ROLE', 'OMIT_FROM_SIX',
  ]);
});
