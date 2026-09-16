import test from 'node:test';
import assert from 'node:assert/strict';
import {
  intakeMidi,
  newWorkspace,
  analyzeWorkspace,
  invalidate,
  importWorkspace,
  recordAcceptedDecision,
  clearAcceptedDecisions,
  acceptedDecisionBindings,
  readCanonical,
  WORKSPACE_SCHEMA,
} from '../web/model.mjs';
import { deriveArrangement } from '../web/midi-source.mjs';
import {
  ACCEPTED_ARRANGEMENT_PIPELINE,
  acceptedArrangementBinding,
  acceptedDecisionsAt,
  decisionContentDigest,
  deriveAcceptedArrangement,
} from '../web/arrangement-decisions.mjs';
import { createAcceptedDecision } from '../backend/arrangement/decision-application.mjs';
import * as fixtures from './fixtures/midi-fixtures.mjs';

// The minimum Web integration for G11-D, and the ways it must fail closed.
//
// The whole question here is whether a persisted or imported record can ever
// present itself as a current, accepted result. It must not: decisions are
// re-validated against what is loaded now, the application is re-derived, and a
// stored application is reported against its binding rather than displayed.

const settings = { meterText: '0 4/4', recording: 'synthetic', offset: '0', end: '2', audioRequired: 'no', preview: 'none' };
const workspaceWith = record => ({ ...newWorkspace(), title: 'fixture', settings, assets: { candidate: record } });
const persist = workspace => structuredClone(workspace);

function fixtureWorkspace(bytes = fixtures.sixSourceVoices()) {
  const workspace = workspaceWith(intakeMidi({ name: 'song.mid', bytes }));
  const project = readCanonical(workspace.assets.candidate.project);
  const arrangement = deriveArrangement(project, { sourceSha256: workspace.assets.candidate.source.sha256 });
  return { workspace, project, suggestion: arrangement.candidate };
}

function decisionFor({ project, suggestion }, overrides = {}) {
  const lane = suggestion.lanes[0];
  return {
    id: 'web-d1',
    type: 'ASSIGN_ROLE',
    target: { laneId: lane.id },
    toRole: 'Chord3',
    reason: 'Reviewed in Studio: this voice is accepted as enrichment.',
    evidence: ['fixture:web review note'],
    acceptance: { ...acceptedDecisionBindings({ project, suggestion }), acceptedBy: 'fixture-reviewer' },
    ...overrides,
  };
}

// ─── recording ──────────────────────────────────────────────────────────────

test('a decision is recorded only with bindings computed from what is loaded', () => {
  const context = fixtureWorkspace();
  const next = recordAcceptedDecision(context.workspace, decisionFor(context));
  assert.equal(next.acceptedDecisions.length, 1);
  assert.equal(next.acceptedDecisions[0].revision, context.workspace.revision);
  assert.equal(next.acceptedDecisions[0].decision.acceptance.state, 'ACCEPTED');
  // The original workspace is not mutated.
  assert.equal(context.workspace.acceptedDecisions.length, 0);
});

test('a decision whose bindings describe other inputs is refused at record time', () => {
  const context = fixtureWorkspace();
  const base = decisionFor(context);
  for (const [field, value] of [
    ['baselineContentDigest', 'f'.repeat(64)],
    ['sourceIdentityDigest', 'a'.repeat(64)],
    ['laneDecompositionDigest', 'b'.repeat(64)],
    ['canonicalRulesSnapshotSha', 'c'.repeat(40)],
    ['reviewedRevisionId', 'g11d:rev:somewhere-else'],
  ]) {
    assert.throws(
      () => recordAcceptedDecision(context.workspace, { ...base, acceptance: { ...base.acceptance, [field]: value } }),
      /STALE_ACCEPTED_DECISION/,
      `${field} must be checked at record time, not only at apply time`,
    );
  }
});

test('a decision that is not accepted cannot be recorded at all', () => {
  const context = fixtureWorkspace();
  const base = decisionFor(context);
  assert.throws(() => recordAcceptedDecision(context.workspace, { ...base, acceptance: { ...base.acceptance, state: 'SUGGESTED' } }), /ACCEPTED/);
  assert.throws(() => recordAcceptedDecision(context.workspace, { ...base, acceptance: undefined }), /acceptance is required/);
});

test('a decision cannot be recorded against a source whose integrity does not verify', () => {
  const context = fixtureWorkspace();
  const tampered = structuredClone(context.workspace);
  tampered.assets.candidate.source.sha256 = 'd'.repeat(64);
  assert.throws(() => recordAcceptedDecision(tampered, decisionFor(context)), /SOURCE_INTEGRITY_UNVERIFIED|STALE_ACCEPTED_DECISION/);
});

// ─── analysis re-derives, never restores ────────────────────────────────────

test('the applied candidate is re-derived from the stored bytes on every analysis', () => {
  const context = fixtureWorkspace();
  const workspace = recordAcceptedDecision(context.workspace, decisionFor(context));

  const before = analyzeWorkspace(workspace);
  const after = analyzeWorkspace(persist(workspace));
  const applied = report => report.rawMidi[0].acceptedArrangement;

  assert.equal(applied(before).status, 'PASS');
  assert.equal(applied(before).decisionCount, 1);
  assert.equal(
    applied(after).application.revision.id,
    applied(before).application.revision.id,
    'a reload reproduces the same content-addressed revision',
  );
  assert.equal(JSON.stringify(applied(after)), JSON.stringify(applied(before)));
  assert.equal(applied(before).pipeline, ACCEPTED_ARRANGEMENT_PIPELINE);
});

test('with no accepted decision the G11-C suggestion stays a suggestion', () => {
  const context = fixtureWorkspace();
  const report = analyzeWorkspace(context.workspace);
  const applied = report.rawMidi[0].acceptedArrangement;
  assert.equal(applied.status, 'NOT_REQUESTED');
  assert.equal(applied.application, null);
  assert.equal(report.rawMidi[0].arrangement.accepted, false);
  assert.equal(report.rawMidi[0].arrangement.stage, 'G11-C');
});

test('an accepted application never makes the workspace ready', () => {
  const context = fixtureWorkspace();
  const workspace = recordAcceptedDecision(context.workspace, decisionFor(context));
  const report = analyzeWorkspace(workspace);
  assert.equal(report.rawMidi[0].acceptedArrangement.status, 'PASS');
  assert.notEqual(report.state, 'VALIDATED');
  assert.ok(report.blockers.length > 0);
  assert.deepEqual([...report.rawMidi[0].acceptedArrangement.application.downstream.certifiesGates], []);
});

// ─── revision safety ────────────────────────────────────────────────────────

test('a revision bump drops accepted decisions the way it drops every other review record', () => {
  const context = fixtureWorkspace();
  const workspace = recordAcceptedDecision(context.workspace, decisionFor(context));
  const next = invalidate(workspace);
  assert.equal(next.revision, workspace.revision + 1);
  assert.deepEqual(next.acceptedDecisions, []);
  assert.equal(analyzeWorkspace(next).rawMidi[0].acceptedArrangement.status, 'NOT_REQUESTED');
});

test('a record left behind at an older revision is not applied', () => {
  const context = fixtureWorkspace();
  const workspace = recordAcceptedDecision(context.workspace, decisionFor(context));
  // A record that survived a revision bump -- the shape a partially migrated or
  // hand-edited stored workspace has.
  const smuggled = { ...persist(workspace), revision: workspace.revision + 1 };
  assert.deepEqual(acceptedDecisionsAt(smuggled.acceptedDecisions, smuggled.revision).decisions, []);
  assert.equal(analyzeWorkspace(smuggled).rawMidi[0].acceptedArrangement.status, 'NOT_REQUESTED');
});

test('clearing accepted decisions leaves the source and the suggestion untouched', () => {
  const context = fixtureWorkspace();
  const workspace = recordAcceptedDecision(context.workspace, decisionFor(context));
  const cleared = clearAcceptedDecisions(workspace);
  assert.deepEqual(cleared.acceptedDecisions, []);
  assert.equal(JSON.stringify(cleared.assets.candidate), JSON.stringify(workspace.assets.candidate));
});

// ─── tampering ──────────────────────────────────────────────────────────────

test('a stored decision edited after it was accepted is refused, not replayed', () => {
  const context = fixtureWorkspace();
  const workspace = recordAcceptedDecision(context.workspace, decisionFor(context));

  // The destination role is rewritten in storage while the acceptance block --
  // who accepted it, and against what -- is left alone. The record no longer
  // agrees with its own content digest, so nothing is applied.
  const forged = persist(workspace);
  forged.acceptedDecisions[0].decision.toRole = 'Melody';
  const applied = analyzeWorkspace(forged).rawMidi[0].acceptedArrangement;
  assert.equal(applied.status, 'FAIL');
  assert.equal(applied.application, null);
  assert.deepEqual(applied.invalidRecords.map(item => item.reason), ['DECISION_RECORD_CONTENT_DIGEST_MISMATCH']);

  // Recomputing the digest beside it does not buy authority either: a forged
  // promotion into Melody still has to satisfy the Lead interlock.
  const resigned = persist(workspace);
  resigned.acceptedDecisions[0].decision.toRole = 'Melody';
  resigned.acceptedDecisions[0].contentDigest = decisionContentDigest(
    createAcceptedDecision(resigned.acceptedDecisions[0].decision),
  );
  const resignedApplied = analyzeWorkspace(resigned).rawMidi[0].acceptedArrangement;
  assert.equal(resignedApplied.status, 'PENDING');
  assert.equal(resignedApplied.application.candidate, null);
  assert.ok(resignedApplied.application.rejected.some(item => item.code === 'LEAD_PROMOTION_EVIDENCE_REQUIRED'));

  // An entirely invented decision type cannot be smuggled in either.
  const invented = persist(workspace);
  invented.acceptedDecisions[0].decision.type = 'MAKE_IT_BETTER';
  const inventedReport = analyzeWorkspace(invented);
  assert.equal(inventedReport.rawMidi[0].acceptedArrangement.status, 'FAIL');
  assert.match(inventedReport.rawMidi[0].acceptedArrangement.invalidRecords[0].reason, /DECISION_RECORD_MALFORMED/);

  // And neither can a pitch edit dressed as a role decision.
  const repitched = persist(workspace);
  repitched.acceptedDecisions[0].decision.octaveShift = -1;
  const repitchedReport = analyzeWorkspace(repitched);
  assert.equal(repitchedReport.rawMidi[0].acceptedArrangement.status, 'FAIL');
  assert.match(repitchedReport.rawMidi[0].acceptedArrangement.invalidRecords[0].reason, /DECISION_RECORD_MALFORMED/);
});

test('a stored decision whose bindings were rewritten to look fresh is still refused', () => {
  const context = fixtureWorkspace();
  const workspace = recordAcceptedDecision(context.workspace, decisionFor(context));
  const forged = persist(workspace);
  // Pretend the decision was reviewed against a revision that does not exist.
  // The acceptance block is outside the content digest on purpose, so this
  // record is self-consistent and still has to be caught by its binding.
  forged.acceptedDecisions[0].decision.acceptance.reviewedRevisionId = 'g11d:rev:invented';
  const applied = analyzeWorkspace(forged).rawMidi[0].acceptedArrangement;
  assert.equal(applied.status, 'FAIL');
  assert.equal(applied.application.requiresFreshReview, true);
  assert.ok(applied.application.stale.some(item => item.code === 'STALE_DECISION_REVISION_MISMATCH'));
});

test('a decision accepted against one file is not applied to another', () => {
  const first = fixtureWorkspace(fixtures.format1());
  const recorded = recordAcceptedDecision(first.workspace, decisionFor(first));

  // The same workspace with different bytes in the candidate slot: exactly what
  // re-picking a file produces if the decisions were not dropped.
  const swapped = persist(recorded);
  swapped.assets.candidate = intakeMidi({ name: 'other.mid', bytes: fixtures.format1Variant() });
  const applied = analyzeWorkspace(swapped).rawMidi[0].acceptedArrangement;
  assert.equal(applied.status, 'FAIL');
  assert.ok(applied.application.stale.length > 0);
  assert.equal(applied.application.candidate, null);
});

// ─── import ─────────────────────────────────────────────────────────────────

test('a backup cannot import a ready-made accepted arrangement', () => {
  const context = fixtureWorkspace();
  const workspace = recordAcceptedDecision(context.workspace, decisionFor(context));
  const applied = analyzeWorkspace(workspace).rawMidi[0].acceptedArrangement;
  assert.equal(applied.status, 'PASS');

  // A backup that claims both the decisions and the application they produced.
  const backup = JSON.stringify({
    ...workspace,
    schema: WORKSPACE_SCHEMA,
    assets: { candidate: { ...workspace.assets.candidate, acceptedArrangement: { ...applied, status: 'PASS' } } },
  });
  const imported = importWorkspace(backup);

  assert.deepEqual(imported.acceptedDecisions, [], 'imported decisions are never current');
  assert.ok(imported.importedHistory.acceptedDecisions, 'they are kept as history');
  const report = analyzeWorkspace(imported);
  assert.equal(report.rawMidi[0].acceptedArrangement.status, 'NOT_REQUESTED');
  assert.equal(report.rawMidi[0].persistedAcceptedArrangement, null, 'the asset\'s claimed application does not survive re-ingest');
  assert.notEqual(report.state, 'VALIDATED');
});

test('a persisted application is reported against its binding, never displayed as current', () => {
  const context = fixtureWorkspace();
  const workspace = recordAcceptedDecision(context.workspace, decisionFor(context));
  const applied = analyzeWorkspace(workspace).rawMidi[0].acceptedArrangement;

  const stored = persist(workspace);
  stored.assets.candidate.acceptedArrangement = { ...applied, status: 'PASS' };
  const report = analyzeWorkspace(stored);
  const binding = report.rawMidi[0].persistedAcceptedArrangement;
  assert.ok(binding, 'a stored application is reported');
  assert.equal(binding.current, true, 'and here it really does describe what is loaded');
  assert.equal(binding.claimedStatus, 'PASS');

  // Change the source and the same stored application is no longer current.
  const moved = persist(stored);
  moved.assets.candidate = { ...intakeMidi({ name: 'other.mid', bytes: fixtures.format1Variant() }), acceptedArrangement: stored.assets.candidate.acceptedArrangement };
  const movedBinding = analyzeWorkspace(moved).rawMidi[0].persistedAcceptedArrangement;
  assert.equal(movedBinding.current, false);
  assert.ok(movedBinding.reasons.includes('ACCEPTED_ARRANGEMENT_SOURCE_BYTES_CHANGED'));
  assert.ok(movedBinding.reasons.includes('ACCEPTED_ARRANGEMENT_BASELINE_CHANGED'));
});

test('acceptedArrangementBinding refuses a record from an older derivation', () => {
  const context = fixtureWorkspace();
  const stored = { pipeline: 'studio-web/accepted-arrangement@0', status: 'PASS', derivation: {} };
  const binding = acceptedArrangementBinding({ stored, project: context.project, revision: 0 });
  assert.equal(binding.current, false);
  assert.ok(binding.reasons.includes('ACCEPTED_ARRANGEMENT_PIPELINE_VERSION_CHANGED'));
});

test('deriveAcceptedArrangement never mutates the project it is handed', () => {
  const context = fixtureWorkspace();
  const before = JSON.stringify(context.project);
  const decision = createAcceptedDecision(
    decisionFor(context, { acceptance: { ...acceptedDecisionBindings(context), acceptedBy: 'fixture-reviewer' } }),
  );
  const records = [{
    schema: 'mml-studio-web/accepted-arrangement-decision@1',
    revision: 0,
    contentDigest: decisionContentDigest(decision),
    decision: JSON.parse(JSON.stringify(decision)),
  }];
  const result = deriveAcceptedArrangement({ project: context.project, suggestion: context.suggestion, records, revision: 0 });
  assert.equal(result.status, 'PASS');
  assert.equal(JSON.stringify(context.project), before);
  assert.equal(result.application.immutability.baselineUnchanged, true);
});
