// The AI Proposal Protocol's vocabulary, and the one identity an agent uses to
// address a review request.
//
// These are contract regressions, not behaviour regressions: they assert the
// shape of the vocabulary a later change could widen without noticing. The
// dangerous widenings are all of one kind — something that was refused becomes
// admissible — so each test here names the closure it is protecting.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCEPTABLE_AGENT_REVIEW,
  AGENT_REVIEW,
  AGENT_REVIEW_NAMES,
  AGENT_REVIEW_ORDER,
  CITATION_REQUIRED,
  PROPOSAL_ACTION_KEYS,
  PROPOSAL_KIND,
  PROPOSAL_KIND_NAMES,
  PROPOSAL_KIND_OPERATION,
  PROPOSAL_TARGETS,
  REQUEST_KEY_FIELDS,
  UNKNOWN_REQUEST_TARGETS,
  isRequestKey,
  requestKeyOf,
} from '../backend/application/proposal-contracts.mjs';
import { RUN_REVIEW_REQUEST } from '../backend/application/run-contracts.mjs';
import { ID_PREFIX, isProposalId, isRunId } from '../backend/application/contracts.mjs';

// ─── A. the request key is derived, not positional ──────────────────────────

test('a request key is derived from the request identity and nothing else', () => {
  const request = {
    code: RUN_REVIEW_REQUEST.ARRANGEMENT_DECISIONS_REQUIRED,
    step: 'apply_decisions',
    gate: null,
    report_reference: 'suggestArrangement.pending',
    baseline_id: `bas:${'a'.repeat(64)}`,
    candidate_id: null,
  };
  const key = requestKeyOf(request);
  assert.ok(isRequestKey(key), 'a request key is req:<64 hex>');

  // The request's CONTENTS are not its identity: an upstream report re-derived
  // over the same candidate legitimately produces different blockers, missing
  // text and bounded event ids, and expiring an open request for that would
  // make an agent chase a key that moves under it.
  assert.equal(requestKeyOf({ ...request, blockers: ['ANYTHING'], missing: ['x'], detail: { a: 1 } }), key);

  // Every identity field DOES move it. This is the staleness property: a
  // proposal written against the old candidate cannot address the new request.
  for (const field of REQUEST_KEY_FIELDS) {
    assert.notEqual(requestKeyOf({ ...request, [field]: 'moved' }), key, `${field} is part of the request identity`);
  }
});

test('a request key cannot be reached through a prototype', () => {
  // `Object.keys` says own; property access says own-or-inherited. A caller who
  // knows that could otherwise hand over a request whose identity is stated
  // nowhere a key-based guard can see it.
  const forged = Object.create({ code: 'ARRANGEMENT_DECISIONS_REQUIRED', candidate_id: 'g11d:rev:beef' });
  const empty = requestKeyOf({ code: null, step: null, gate: null, report_reference: null, baseline_id: null, candidate_id: null });
  assert.equal(requestKeyOf(forged), empty, 'an inherited field contributes nothing to a request key');
});

test('a request key is stable across two spellings of the same absence', () => {
  const stated = { code: 'X', step: 'y', gate: null, report_reference: 'r', baseline_id: null, candidate_id: null };
  const omitted = { code: 'X', step: 'y', report_reference: 'r' };
  assert.equal(requestKeyOf(stated), requestKeyOf(omitted));
  // …but a real value is never the same as its absence.
  assert.notEqual(requestKeyOf({ ...stated, gate: 'null' }), requestKeyOf(stated));
});

// ─── B. the target table is closed ──────────────────────────────────────────

test('every run review request code has an entry, and an unknown code describes only', () => {
  for (const code of Object.values(RUN_REVIEW_REQUEST)) {
    assert.ok(Object.hasOwn(PROPOSAL_TARGETS, code), `${code} must state which proposal classes may answer it`);
    for (const kind of PROPOSAL_TARGETS[code]) {
      assert.ok(PROPOSAL_KIND_NAMES.includes(kind), `${code} admits an unknown proposal class ${kind}`);
    }
    assert.ok(PROPOSAL_TARGETS[code].includes(PROPOSAL_KIND.EVIDENCE_NEEDED), `${code} must always admit evidence_needed: describing what is missing is never out of scope`);
  }
  // Fail closed. A request code added upstream and not added here admits a
  // description and nothing else, rather than becoming settlable by omission.
  assert.deepEqual([...UNKNOWN_REQUEST_TARGETS], [PROPOSAL_KIND.EVIDENCE_NEEDED]);
});

test('no readiness gate, blocked finalize, changed input or interrupted step is settlable by a proposal', () => {
  // The whole point of the protocol's boundary. Answering any of these is a
  // reviewer's confirmation, approval, evidence record or inspection — none of
  // which a proposal is, however detailed it is.
  for (const code of [
    RUN_REVIEW_REQUEST.READINESS_GATE_BLOCKED,
    RUN_REVIEW_REQUEST.FINALIZE_BLOCKED,
    RUN_REVIEW_REQUEST.RUN_INPUT_CHANGED,
    RUN_REVIEW_REQUEST.RECONCILIATION_REQUIRED,
  ]) {
    assert.deepEqual([...PROPOSAL_TARGETS[code]], [PROPOSAL_KIND.EVIDENCE_NEEDED], `${code} must admit evidence_needed alone`);
  }
});

// ─── C. the agent review ladder ─────────────────────────────────────────────

test('exactly one agent review verdict is actionable, and it is the one that says so', () => {
  assert.equal(typeof ACCEPTABLE_AGENT_REVIEW, 'string', 'one value, never a list a later change can append to');
  assert.equal(ACCEPTABLE_AGENT_REVIEW, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
  assert.deepEqual([...AGENT_REVIEW_ORDER].sort(), [...AGENT_REVIEW_NAMES].sort(), 'every verdict has a place in the ladder');
  assert.equal(new Set(AGENT_REVIEW_ORDER).size, AGENT_REVIEW_ORDER.length, 'the ladder lists each verdict once');
  // The refusing verdicts come first, so "which problem does this have" has one
  // answer rather than a set a caller has to rank. STALE is ahead of INVALID
  // and the order is load-bearing: every INVALID check is evaluated AGAINST the
  // bindings, so when those have moved a forgery verdict would accuse an honest
  // proposal of fabricating citations that a re-ingested baseline simply no
  // longer holds. This ladder is what the policy actually evaluates, asserted
  // here so the constant cannot drift from it again.
  assert.equal(AGENT_REVIEW_ORDER[0], AGENT_REVIEW.STALE);
  assert.equal(AGENT_REVIEW_ORDER[1], AGENT_REVIEW.INVALID);
  assert.equal(AGENT_REVIEW_ORDER.at(-1), ACCEPTABLE_AGENT_REVIEW);
});

test('every proposal class states its downstream operation and its citation requirement', () => {
  for (const kind of PROPOSAL_KIND_NAMES) {
    assert.ok(Object.hasOwn(PROPOSAL_KIND_OPERATION, kind), `${kind} must name the existing operation it reaches, or null`);
    assert.ok(Object.hasOwn(PROPOSAL_ACTION_KEYS, kind), `${kind} must declare a closed action key set`);
    assert.ok(Object.hasOwn(CITATION_REQUIRED, kind), `${kind} must state whether it needs a resolvable citation`);
  }
  // The one class that reaches nothing is the one that applies nothing.
  assert.equal(PROPOSAL_KIND_OPERATION[PROPOSAL_KIND.EVIDENCE_NEEDED], null);
  assert.deepEqual([...PROPOSAL_ACTION_KEYS[PROPOSAL_KIND.EVIDENCE_NEEDED]], []);
  for (const kind of PROPOSAL_KIND_NAMES.filter(name => name !== PROPOSAL_KIND.EVIDENCE_NEEDED)) {
    assert.equal(typeof PROPOSAL_KIND_OPERATION[kind], 'string', `${kind} reaches an existing operation`);
  }
});

test('every declared evidence reference kind can actually be resolved', async () => {
  // A kind declared in the vocabulary but missing from the service's resolver
  // table would be a TypeError at read time rather than a refusal — and it
  // would be reached only by a proposal that cited it, which is to say by an
  // agent rather than by this suite. So the two are compared directly.
  const { EVIDENCE_REF_KIND_NAMES } = await import('../backend/application/proposal-contracts.mjs');
  const { createStudioApplication } = await import('../backend/application/index.mjs');
  const { projectWithSymbolicAsset } = await import('./fixtures/run-fixtures.mjs');
  const { PROPOSAL_KIND: KIND } = await import('../backend/application/proposal-contracts.mjs');

  const app = createStudioApplication({});
  const owner = 'owner:evidence-kinds';
  const fixture = await projectWithSymbolicAsset(app, owner);
  const started = await app.startRun(owner, fixture.projectId, { asset_ids: [fixture.assetId] });
  const target = (await app.proposalTargets(owner, fixture.projectId, started.run.run_id)).targets[0];

  for (const kind of EVIDENCE_REF_KIND_NAMES) {
    // A deliberately unresolvable id of each kind. Every one must come back as
    // a REFUSAL — never a crash, and never silently accepted.
    const submitted = await app.proposeDecision(owner, fixture.projectId, {
      run_id: started.run.run_id,
      request_key: target.request_key,
      kind: KIND.EVIDENCE_NEEDED,
      proposed_by: 'agent',
      rationale: `Citing an unresolvable ${kind} reference.`,
      cites: { evidence_refs: [{ kind, id: 'nothing-this-project-holds', truth_class: 'project_history' }] },
    });
    assert.equal(submitted.proposal.agent_review.verdict, 'INVALID', `${kind} must resolve to a refusal`);
    assert.ok(submitted.proposal.agent_review.refusals.includes('FABRICATED_EVIDENCE_REF'), kind);
  }
});

// ─── D. proposal identity is its own family ─────────────────────────────────

test('a proposal id is its own opaque identity and is not a run id', () => {
  assert.equal(ID_PREFIX.proposal, 'pro_');
  const proposalId = `pro_${'0'.repeat(32)}`;
  assert.ok(isProposalId(proposalId));
  assert.ok(!isRunId(proposalId), 'a proposal is not a workflow instance');
  assert.ok(!isProposalId(`run_${'0'.repeat(32)}`));
  // Not content-addressed, and not derived from anything a caller holds.
  assert.ok(!isProposalId('pro_not-hex'));
  assert.ok(!isProposalId(`pro_${'0'.repeat(31)}`));
});
