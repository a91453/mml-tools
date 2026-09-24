// A duplicate carried from an earlier revision is its own input event.
//
// The G11-D drift check compared every duplicate with the event it was derived
// from. Once the origin was omitted in a later revision, or the copy's role was
// transposed by Mobile Adaptation, every further application on that lineage
// threw "G11-D INVARIANT VIOLATED", reduction plans included, and the only
// application that still passed was omitting the last sounding copy.
import test from 'node:test';
import assert from 'node:assert/strict';

import { applyAcceptedArrangement } from '../backend/arrangement/decision-application.mjs';
import { suggestRoleCandidates } from '../backend/arrangement/role-candidates.mjs';
import { planFinalReduction } from '../backend/reduction/index.mjs';
import { roleDeclaredBaseline, acceptanceFor, CANONICAL_IDENTITY } from './fixtures/g11d-fixtures.mjs';

function duplicateThenOmitOrigin() {
  const baseline = roleDeclaredBaseline();
  const suggestion = suggestRoleCandidates(baseline);
  const accept = reviewedRevisionId => ({ ...acceptanceFor(baseline, { suggestion }), ...(reviewedRevisionId ? { reviewedRevisionId } : {}) });
  const apply = (parent, decisions) => applyAcceptedArrangement({ baseline, suggestion, canonicalIdentity: CANONICAL_IDENTITY, ...(parent ? { parent: { revision: parent.revision, candidate: parent.candidate } } : {}), decisions: decisions.map(decision => ({ ...decision, acceptance: accept(parent?.revision.id) })) });
  const first = apply(null, [{ id: 'd1', type: 'DUPLICATE_WITH_JUSTIFICATION', target: { eventIds: ['harm-1'] }, toRoles: ['Chord3'], reason: 'r', evidence: ['fixture:score'] }]);
  const second = apply(first, [{ id: 'o1', type: 'OMIT_FROM_SIX', target: { eventIds: ['harm-1'] }, reason: 'r', evidence: ['fixture:score'] }]);
  return { baseline, apply, first, second, copy: second.candidate.events.find(event => event.metadata?.g11d?.derivedFromEventId === 'harm-1') };
}

test('a later revision on a lineage whose duplicated origin was omitted still applies', () => {
  const { baseline, apply, first, second, copy } = duplicateThenOmitOrigin();
  assert.equal(first.status, 'PASS');
  assert.equal(second.status, 'PASS');
  assert.ok(copy, 'the copy survives its omitted origin');
  // An unrelated decision, a move of the surviving copy, and a reduction plan.
  assert.equal(apply(second, [{ id: 'k1', type: 'KEEP', target: { eventIds: ['tex-1'] }, reason: 'r', evidence: ['e'] }]).status, 'PASS');
  const moved = apply(second, [{ id: 'm1', type: 'MOVE_ROLE', target: { eventIds: [copy.id] }, fromRole: 'Chord3', toRole: 'Chord4', reason: 'r', evidence: ['e'] }]);
  assert.equal(moved.status, 'PASS');
  assert.equal(moved.candidate.events.find(event => event.id === copy.id).role, 'Chord4');
  const plan = planFinalReduction({ baseline, candidate: second.candidate, parent: second, parentOmittedEventIds: ['harm-1'], decisions: [{ id: 'k', action: 'KEEP', eventIds: ['tex-1'], reason: 'r' }] });
  assert.deepEqual(plan.blockers.map(blocker => blocker.code), []);
});

