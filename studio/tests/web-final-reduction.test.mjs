import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newWorkspace,
  analyzeWorkspace,
  previewFinalReduction,
  applyWorkspaceFinalReduction,
  clearFinalReduction,
  previewMobileAdaptation,
  applyWorkspaceMobileAdaptation,
  importWorkspace,
  invalidate,
} from '../web/model.mjs';
import { baselineWithUnassignedRole, baselineWithOverflowLane, FIXTURE_SOURCE_ID } from './fixtures/g12-fixtures.mjs';

const assetFor = project => ({ name: 'reduction.json', content: JSON.stringify(project), project, format: 'Canonical IR', complete: true, warnings: [], errors: [], unsupported: [] });

// A workspace that already carries reviews, an acceptance and a delivery, so a
// reduction has something it must invalidate.
function workspace(project = baselineWithUnassignedRole()) {
  const asset = assetFor(project);
  return {
    ...newWorkspace(),
    assets: { candidate: structuredClone(asset), baseline: structuredClone(asset) },
    reviews: { core3: { revision: 0, note: 'old', evidence: 'old' }, adaptation: { revision: 0, note: 'old', evidence: 'old' } },
    acceptance: { outcome: 'accepted' },
    deliveryMml: 'old',
    finalDelivery: { status: 'PASS' },
  };
}

const PLACE_CHORD5 = {
  id: 'web:place-chord5',
  action: 'REDISTRIBUTE',
  eventIds: ['chord5-1', 'chord5-2', 'chord5-3'],
  toRole: 'Chord5',
  reason: 'The source declares this lane as secondary bass reinforcement; it is placed in the one free enrichment role.',
  evidence: [`${FIXTURE_SOURCE_ID}#Chord5`],
};

test('Web previews a reduction read-only and reports every accounting bucket', () => {
  const w = workspace();
  const snapshot = structuredClone(w);
  const plan = previewFinalReduction(w);
  assert.equal(plan.status, 'PASS');
  assert.equal(plan.accounting.total, 18);
  assert.equal(plan.accounting.pending, 3);
  assert.equal(plan.accounting.retained, 15);
  // Read-only: the workspace is untouched by a preview.
  assert.deepEqual(w, snapshot);
  // The pending material is presented as pending, with its reason, never as settled.
  const pending = plan.items.filter(item => item.outcome === 'PENDING');
  assert.equal(pending.length, 3);
  for (const item of pending) {
    assert.equal(item.reasonCode, 'ROLE_DECISION_REQUIRED');
    assert.equal(item.proposedRole, null);
  }
});

test('Web applies a reduction, invalidates reviews, re-derives on reload and rolls back', () => {
  const w = workspace();
  const plan = previewFinalReduction(w, [PLACE_CHORD5], { acceptedBy: 'local-workspace-user' });
  assert.equal(plan.status, 'PASS', JSON.stringify(plan.blockers));
  const result = applyWorkspaceFinalReduction(w, { decisions: [PLACE_CHORD5], expectedPlanId: plan.id, acceptedBy: 'local-workspace-user' });
  assert.equal(result.applied, true);
  const next = result.workspace;

  // The sources survive; the reviews, the acceptance and the delivery do not.
  assert.deepEqual(next.assets, w.assets);
  assert.deepEqual(next.reviews, {});
  assert.equal(next.acceptance, null);
  assert.equal(next.finalDelivery, undefined);
  assert.equal(next.deliveryMml, undefined);
  // Inputs are persisted, not a derived candidate and not a PASS.
  assert.deepEqual(next.finalReduction.decisions.map(decision => decision.id), ['web:place-chord5']);
  assert.equal(next.finalReduction.expectedPlanId, plan.id);
  assert.equal(next.finalReduction.candidate, undefined);

  const report = analyzeWorkspace(next);
  assert.equal(report.finalReduction.plan.accounting.redistributed, 3);
  assert.equal(report.finalReduction.plan.accounting.pending, 0);
  assert.equal(report.gates.finalReductionIntegrity, undefined);
  // Reload: the same workspace through JSON produces the same report.
  assert.deepEqual(analyzeWorkspace(JSON.parse(JSON.stringify(next))), report);

  // Rollback returns to the pre-reduction candidate.
  const rollback = clearFinalReduction(next);
  assert.equal(rollback.finalReduction, undefined);
  assert.deepEqual(rollback.assets, w.assets);
  assert.equal(analyzeWorkspace(rollback).finalReduction, null);
  assert.equal(invalidate(next).finalReduction, undefined);
});

test('Web fails closed on a stale stored reduction and treats a backup reduction as history', () => {
  const w = workspace();
  const plan = previewFinalReduction(w, [PLACE_CHORD5], { acceptedBy: 'local-workspace-user' });
  const next = applyWorkspaceFinalReduction(w, { decisions: [PLACE_CHORD5], expectedPlanId: plan.id, acceptedBy: 'local-workspace-user' }).workspace;

  // A stored plan id that no longer describes these inputs is refused, visibly.
  const tampered = { ...next, finalReduction: { ...next.finalReduction, expectedPlanId: `${plan.id}x` } };
  const report = analyzeWorkspace(tampered);
  // A refusal is reported as a refusal. The recomputed plan is not smuggled
  // into the report where the UI would render its status as the reduction's.
  assert.equal(report.finalReduction, null);
  assert.equal(report.gates.finalReductionIntegrity.status, 'PENDING');
  assert.match(report.gates.finalReductionIntegrity.reason, /STALE_FINAL_REDUCTION_PLAN/);

  // A backup's reduction record is history, never restored as current.
  const imported = importWorkspace(JSON.stringify(next));
  assert.equal(imported.finalReduction, undefined);
  assert.ok(imported.importedHistory.finalReduction);
  assert.equal(analyzeWorkspace(imported).finalReduction, null);
});

test('Web keeps reduction and Mobile adaptation as two ordered layers', () => {
  const w = workspace();
  const plan = previewFinalReduction(w, [PLACE_CHORD5], { acceptedBy: 'local-workspace-user' });
  const reduced = applyWorkspaceFinalReduction(w, { decisions: [PLACE_CHORD5], expectedPlanId: plan.id, acceptedBy: 'local-workspace-user' }).workspace;

  // Mobile adaptation now plans against the reduced candidate: the role the
  // reduction placed is a role adaptation can address.
  const profile = { schema: 'mml-studio/mobile-adaptation-profile@1', id: 'fixture', reason: 'Synthetic target for the reduced candidate.', evidence: ['fixture:client'], roles: { Chord5: { defaultVolume: 9 } } };
  const mobilePlan = previewMobileAdaptation(reduced, profile);
  assert.equal(mobilePlan.status, 'PASS', JSON.stringify(mobilePlan.blockers));
  const applied = applyWorkspaceMobileAdaptation(reduced, { profile, expectedPlanId: mobilePlan.id, acceptedBy: 'local-workspace-user' });
  assert.equal(applied.applied, true);
  // Applying the adaptation keeps the reduction it was planned on top of.
  assert.deepEqual(applied.workspace.finalReduction, reduced.finalReduction);

  // Both layers survive together, and the reduction is still the earlier one.
  const report = analyzeWorkspace(applied.workspace);
  assert.equal(report.finalReduction.plan.accounting.redistributed, 3);
  assert.equal(report.mobileAdaptation.plan.changes.length, 3);
  // The reduction changed no pitch or volume; the adaptation changed no role.
  for (const change of report.mobileAdaptation.plan.changes) {
    assert.equal(change.role, 'Chord5');
    assert.equal(change.before.pitch, change.after.pitch);
  }
});

test('Web reports overflow material as retained and outside the six roles', () => {
  const w = workspace(baselineWithOverflowLane());
  const plan = previewFinalReduction(w);
  assert.equal(plan.accounting.overflow, 3);
  assert.deepEqual(plan.roleCapacity.free, []);
  for (const item of plan.items.filter(entry => entry.outcome === 'OVERFLOW')) {
    assert.equal(item.reasonCode, 'SIX_ROLE_CAPACITY_EXCEEDED');
    assert.equal(item.proposedRole, null);
    assert.ok(item.candidateEventIds.length, 'overflow material is still in the candidate');
  }
  // Accepting the overflow records the review and still removes nothing.
  const accept = { id: 'web:accept-overflow', action: 'ACCEPT_OVERFLOW', eventIds: ['overflow-1', 'overflow-2', 'overflow-3'], reason: 'The reviewer accepts that this lane stays outside the six roles for this delivery.', evidence: [] };
  const accepted = previewFinalReduction(w, [accept], { acceptedBy: 'local-workspace-user' });
  const applied = applyWorkspaceFinalReduction(w, { decisions: [accept], expectedPlanId: accepted.id, acceptedBy: 'local-workspace-user' });
  assert.equal(applied.applied, true);
  const report = analyzeWorkspace(applied.workspace);
  assert.equal(report.finalReduction.plan.accounting.overflow, 3);
});

test('a stored adaptation is not replayed onto the unreduced candidate when the reduction fails', () => {
  const w = workspace();
  const plan = previewFinalReduction(w, [PLACE_CHORD5], { acceptedBy: 'local-workspace-user' });
  const reduced = applyWorkspaceFinalReduction(w, { decisions: [PLACE_CHORD5], expectedPlanId: plan.id, acceptedBy: 'local-workspace-user' }).workspace;
  const profile = { schema: 'mml-studio/mobile-adaptation-profile@1', id: 'fixture', reason: 'Synthetic target for the reduced candidate.', evidence: ['fixture:client'], roles: { Chord5: { defaultVolume: 9 } } };
  const mobilePlan = previewMobileAdaptation(reduced, profile);
  const both = applyWorkspaceMobileAdaptation(reduced, { profile, expectedPlanId: mobilePlan.id, acceptedBy: 'local-workspace-user' }).workspace;

  // Break the reduction the adaptation was built on. Neither layer is replayed.
  const broken = { ...both, finalReduction: { ...both.finalReduction, expectedPlanId: `${plan.id}x` } };
  const report = analyzeWorkspace(broken);
  assert.equal(report.finalReduction, null);
  assert.equal(report.mobileAdaptation, null);
  assert.match(report.gates.finalReductionIntegrity.reason, /STALE_FINAL_REDUCTION_PLAN/);
  assert.match(report.gates.mobileAdaptationIntegrity.reason, /MOBILE_ADAPTATION_NOT_REPLAYED/);
});
