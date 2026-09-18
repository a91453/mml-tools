// Gate 3 — a Lead swap the baseline diff cannot see.
//
// Found by an adversarial review of the Lead evidence re-review work, and
// reproduced before it was fixed. `compare/version-drift.mjs` aligns notes
// STRUCTURALLY -- same role then same onset -- and never by event id. So a
// candidate that swaps a Lead event with an inner voice at the same onset:
//
//   melody-1  Melody @0  pitch 72   ->  Chord3
//   chord3-1  Chord3 @0  pitch 60   ->  Melody
//
// is aligned as "the Melody slot at onset 0 changed pitch 60->72" plus "the
// Chord3 slot at onset 0 changed pitch 72->60". `roleMoved` comes back EMPTY.
//
// The readiness Lead gates derived their required-event-id sets only from
// `added` / `removed` / `roleMoved`, so both sets were empty, and an empty
// required set with no reports falls through to `N/A` -- which is PASS-like.
// Observed before the fix: a Lead swap with ZERO evidence, and neither
// `leadDemotion` nor `leadPromotion` among the blockers.
//
// MASTER_RULES §4 requires positive role evidence to demote a source-supported
// Lead, and ACCEPTANCE_CRITERIA Gate 3 requires the evidence chain for any Lead
// demotion. Neither is conditional on a diff being able to pair the notes, so
// the gates now also read Melody membership by event id.

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateProjectReadiness } from '../backend/final/index.mjs';
import { compareCandidateLineage } from '../backend/compare/version-drift.mjs';
import { createCanonicalProject } from '../backend/canonical/index.mjs';
import { sixRoleBaseline } from './fixtures/application-fixtures.mjs';

const baseline = sixRoleBaseline();
const candidateOf = events => createCanonicalProject({
  ...baseline, id: 'fixture:swap-candidate',
  metadata: { sourceFaithfulBaseline: { snapshot: baseline } },
  events,
});
const readinessOf = (candidate, reports = {}) => evaluateProjectReadiness({
  project: candidate,
  lineageReport: compareCandidateLineage({ sourceBaseline: baseline, acceptedPrevious: null, candidate }),
  leadDemotionReports: reports.demotion ?? [],
  leadPromotionReports: reports.promotion ?? [],
});

const swapped = () => candidateOf(baseline.events.map(event => (
  event.id === 'melody-1' ? { ...event, role: 'Chord3' }
    : event.id === 'chord3-1' ? { ...event, role: 'Melody' }
      : event)));

test('a Lead swap the structural diff reports as two pitch changes still requires evidence', () => {
  const candidate = swapped();
  const lineage = compareCandidateLineage({ sourceBaseline: baseline, acceptedPrevious: null, candidate });

  // The premise: the diff genuinely does not see this as a role move.
  assert.deepEqual([...lineage.sourceToCandidate.notes.roleMoved], [], 'the diff pairs the swap structurally');
  assert.deepEqual([...lineage.sourceToCandidate.notes.added], []);
  assert.deepEqual([...lineage.sourceToCandidate.notes.removed], []);

  const readiness = readinessOf(candidate);
  assert.equal(readiness.gates.leadDemotion.status, 'PENDING', 'a demotion the diff missed still needs evidence');
  assert.deepEqual([...readiness.gates.leadDemotion.pendingEventIds], ['melody-1']);
  assert.ok(readiness.gates.leadDemotion.blockers.includes('LEAD_DEMOTION_EVIDENCE_REQUIRED'));

  assert.equal(readiness.gates.leadPromotion.status, 'PENDING');
  assert.deepEqual([...readiness.gates.leadPromotion.pendingEventIds], ['chord3-1']);
  assert.ok(readiness.gates.leadPromotion.blockers.includes('LEAD_PROMOTION_EVIDENCE_REQUIRED'));

  assert.ok(readiness.preGameBlocking.includes('leadDemotion'));
  assert.ok(readiness.preGameBlocking.includes('leadPromotion'));
  assert.equal(readiness.candidateReady, false);
});

test('the swap is answerable: a PASS report for each named event clears both gates', () => {
  const pass = (eventId, destinationRole) => ({ status: 'PASS', pass: true, eventId, destinationRole, blockers: [], warnings: [] });
  const readiness = readinessOf(swapped(), {
    demotion: [pass('melody-1', 'Chord3')],
    promotion: [pass('chord3-1', 'Melody')],
  });
  assert.equal(readiness.gates.leadDemotion.status, 'PASS');
  assert.equal(readiness.gates.leadPromotion.status, 'PASS');
  // The evidence has to name the swapped events, not merely exist.
  const wrong = readinessOf(swapped(), {
    demotion: [pass('melody-2', 'Chord3')],
    promotion: [pass('chord3-2', 'Melody')],
  });
  assert.equal(wrong.gates.leadDemotion.status, 'PENDING');
  assert.equal(wrong.gates.leadPromotion.status, 'PENDING');
});

test('membership is read only for ids present on both sides, so unrelated id spaces are not a swap', () => {
  // An unchanged candidate asks for nothing.
  const unchanged = readinessOf(candidateOf(baseline.events));
  assert.equal(unchanged.gates.leadDemotion.status, 'N/A');
  assert.equal(unchanged.gates.leadPromotion.status, 'N/A');

  // A candidate whose notes carry entirely different ids -- the Studio Web
  // shape, where baseline and candidate can be separately imported assets with
  // independently generated ids even when the music is identical. Every Melody
  // id would look demoted AND promoted if membership ignored the other side, so
  // the same-music case must stay quiet here. What the notes genuinely are --
  // arrivals and departures -- is the `added`/`removed` derivation's job.
  const renamed = candidateOf(baseline.events.map(event => ({ ...event, id: `re:${event.id}` })));
  const readiness = readinessOf(renamed);
  const diff = compareCandidateLineage({ sourceBaseline: baseline, acceptedPrevious: null, candidate: renamed });
  assert.deepEqual([...diff.sourceToCandidate.notes.roleMoved], []);
  assert.equal(readiness.gates.leadDemotion.status, 'N/A', 'identical music under other ids is not a demotion');
  assert.equal(readiness.gates.leadPromotion.status, 'N/A');
});
