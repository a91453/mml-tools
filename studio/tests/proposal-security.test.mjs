// The AI Proposal Protocol — what a caller may not state.
//
// Every input here arrives from outside, and the agent that writes it is the
// one party in the system with both a strong incentive to be convincing and no
// way to be held to account. So the boundary is closed rather than filtered:
// an unknown field is refused, a forged identity is refused, a field the
// server computes is refused, and a field that would collapse two kinds of
// evidence into one number is refused.
//
// Refused, not dropped, is the recurring point. A field silently ignored reads
// — to the agent that sent it and to a reviewer skimming the record — as a
// field this service accepted.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_REVIEW,
  COLLAPSED_SCORE_KEYS,
  LIMITS,
  PROPOSAL_KIND,
  createStudioApplication,
} from '../backend/application/index.mjs';
import { RUN_REVIEWER, projectWithSymbolicAsset, runDecisionsFor } from './fixtures/run-fixtures.mjs';

const OWNER = 'owner:proposal-security';
const OTHER_OWNER = 'owner:someone-else';
const AGENT = 'some-external-agent';

const proposable = project => runDecisionsFor(project, {}).map(({ acceptedBy, note, ...rest }) => rest);

async function prepared(app, owner = OWNER) {
  const fixture = await projectWithSymbolicAsset(app, owner);
  const started = await app.startRun(owner, fixture.projectId, { asset_ids: [fixture.assetId] });
  const targets = await app.proposalTargets(owner, fixture.projectId, started.run.run_id);
  const target = targets.targets.find(entry => entry.admissible_kinds.includes(PROPOSAL_KIND.ARRANGEMENT_DECISION));
  const events = await app.listBaselineEvents(owner, fixture.projectId, { limit: 3 });
  return { fixture, run: started.run, target, eventIds: events.events.map(entry => entry.event_id) };
}

const base = (context, overrides = {}) => ({
  run_id: context.run.run_id,
  request_key: context.target.request_key,
  kind: PROPOSAL_KIND.ARRANGEMENT_DECISION,
  proposed_by: AGENT,
  rationale: 'Keep every source-supported role.',
  action: { decisions: proposable(context.fixture.project) },
  cites: { event_ids: context.eventIds },
  ...overrides,
});

const refuses = async (app, projectId, input, expected, owner = OWNER) => {
  await assert.rejects(app.proposeDecision(owner, projectId, input), error => {
    assert.ok(['INVALID_REQUEST', 'PAYLOAD_TOO_LARGE', 'CANDIDATE_NOT_FOUND', 'ASSET_NOT_FOUND'].includes(error.code), `unexpected code ${error.code}: ${error.message}`);
    if (expected) assert.equal(error.details.refusal, expected, `expected ${expected}, got ${error.details.refusal}: ${error.message}`);
    return true;
  });
};

// ─── A. forged identities ───────────────────────────────────────────────────

test('a fabricated baseline event id is refused rather than believed', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);

  // Well-formed, plausible, and not an event this baseline holds. The service
  // resolves it through the same read-only projection an agent would use.
  const submitted = await app.proposeDecision(OWNER, context.fixture.projectId, base(context, {
    cites: { event_ids: [...context.eventIds, 'melody-9999'] },
  }));
  assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.INVALID);
  assert.ok(submitted.proposal.agent_review.refusals.includes('FABRICATED_EVENT_ID'));
  await assert.rejects(
    app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, { resolution: 'accept', accepted_by: RUN_REVIEWER }),
    error => error.code === 'PROPOSAL_REFUSED' && error.details.agent_review.verdict === AGENT_REVIEW.INVALID,
  );
});

test('a fabricated source id is refused, and a real one is resolved with its own authority', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);

  const invented = await app.proposeDecision(OWNER, context.fixture.projectId, base(context, {
    cites: { event_ids: context.eventIds, source_ids: ['fixture:a-score-nobody-uploaded'] },
  }));
  assert.equal(invented.proposal.agent_review.verdict, AGENT_REVIEW.INVALID);
  assert.ok(invented.proposal.agent_review.refusals.includes('FABRICATED_SOURCE_ID'));

  // The real one the fixture's baseline actually carries.
  const real = await app.proposeDecision(OWNER, context.fixture.projectId, base(context, {
    cites: { event_ids: context.eventIds, source_ids: ['fixture:official-midi'] },
  }));
  assert.equal(real.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
});

test('an evidence reference that resolves to nothing in this project is refused', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);

  for (const ref of [
    { kind: 'artifact', id: `art_${'0'.repeat(64)}`, truth_class: 'project_history' },
    { kind: 'asset', id: `ast_${'0'.repeat(32)}`, truth_class: 'symbolic' },
    { kind: 'candidate', id: `g11d:rev:${'0'.repeat(64)}`, truth_class: 'project_history' },
    { kind: 'run', id: `run_${'0'.repeat(32)}`, truth_class: 'project_history' },
    { kind: 'baseline', id: `bas:${'0'.repeat(64)}`, truth_class: 'symbolic' },
    { kind: 'report_reference', id: 'readiness.gates.somethingImadeUp', truth_class: 'project_history' },
  ]) {
    const submitted = await app.proposeDecision(OWNER, context.fixture.projectId, base(context, {
      cites: { event_ids: context.eventIds, evidence_refs: [ref] },
    }));
    assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.INVALID, `${ref.kind} must not resolve`);
    assert.ok(submitted.proposal.agent_review.refusals.includes('FABRICATED_EVIDENCE_REF'));
  }

  // A URL, a filename and a recollection are not references this service can
  // resolve, and are refused at the schema rather than resolved to nothing.
  await refuses(app, context.fixture.projectId, base(context, {
    cites: { event_ids: context.eventIds, evidence_refs: [{ kind: 'url', id: 'https://example.invalid/score.pdf', truth_class: 'symbolic' }] },
  }), 'FABRICATED_EVIDENCE_REF');

  // The real thing: a report reference the run itself handed the agent.
  const real = await app.proposeDecision(OWNER, context.fixture.projectId, base(context, {
    cites: { event_ids: context.eventIds, evidence_refs: [{ kind: 'report_reference', id: context.target.report_reference, truth_class: 'project_history' }] },
  }));
  assert.equal(real.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
});

test('an identity belonging to another project or another owner is out of reach', async () => {
  const app = createStudioApplication({});
  const mine = await prepared(app);
  const theirs = await prepared(app, OTHER_OWNER);

  // Another owner's run id, named from my project. Their record is loaded for
  // THEIR owner, so it is not that this is refused — it is that it is not
  // there to be found.
  await assert.rejects(
    app.proposeDecision(OWNER, mine.fixture.projectId, base(mine, { run_id: theirs.run.run_id })),
    error => error.code === 'RUN_NOT_FOUND',
  );
  // Another owner's project id, named by me.
  await assert.rejects(
    app.proposeDecision(OWNER, theirs.fixture.projectId, base(theirs)),
    error => error.code === 'PROJECT_NOT_FOUND',
  );
  // Their asset, cited as evidence in my proposal.
  const submitted = await app.proposeDecision(OWNER, mine.fixture.projectId, base(mine, {
    cites: { event_ids: mine.eventIds, evidence_refs: [{ kind: 'asset', id: theirs.fixture.assetId, truth_class: 'symbolic' }] },
  }));
  assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.INVALID);
  assert.ok(submitted.proposal.agent_review.refusals.includes('FABRICATED_EVIDENCE_REF'));
  // A request key identifies a request WITHIN a run and is deliberately not
  // globally unique: two runs over the same baseline, waiting on the same
  // thing, legitimately carry the same key. What makes that safe is that a key
  // is only ever resolved against the requests of the run the proposal NAMES.
  // So carrying their key across does not carry their run with it.
  assert.equal(mine.target.request_key, theirs.target.request_key, 'the same request over the same baseline really does key alike');
  const crossed = await app.proposeDecision(OWNER, mine.fixture.projectId, base(mine, { request_key: theirs.target.request_key }));
  assert.equal(crossed.proposal.run_id, mine.run.run_id, 'it bound to my run, not theirs');
  const applied = await app.resolveProposal(OWNER, mine.fixture.projectId, crossed.proposal.proposal_id, { resolution: 'accept', accepted_by: RUN_REVIEWER });
  assert.equal(applied.run.run_id, mine.run.run_id);
  const theirRun = (await app.getRun(OTHER_OWNER, theirs.fixture.projectId, theirs.run.run_id)).run;
  assert.equal(theirRun.revision, theirs.run.revision, 'their run did not move');
  assert.equal(theirRun.candidate_id, null, 'and nothing was applied to it');

  // And reading their proposal from my owner is a not-found, never a forbidden:
  // distinguishing the two is an existence oracle over another owner's records.
  const theirProposal = await app.proposeDecision(OTHER_OWNER, theirs.fixture.projectId, base(theirs));
  await assert.rejects(
    app.getProposal(OWNER, mine.fixture.projectId, theirProposal.proposal.proposal_id),
    error => error.code === 'PROPOSAL_NOT_FOUND',
  );
});

// ─── B. unknown and inherited fields ────────────────────────────────────────

test('an unknown field is refused at every level, not ignored', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);

  await refuses(app, context.fixture.projectId, base(context, { confidence_level: 'high' }), 'UNKNOWN_FIELD');
  await refuses(app, context.fixture.projectId, base(context, { action: { decisions: proposable(context.fixture.project), apply: true } }), 'UNKNOWN_FIELD');
  await refuses(app, context.fixture.projectId, base(context, { cites: { event_ids: context.eventIds, urls: ['https://example.invalid'] } }), 'UNKNOWN_FIELD');
  await refuses(app, context.fixture.projectId, base(context, {
    cites: { event_ids: context.eventIds, evidence_refs: [{ kind: 'baseline', id: 'x', truth_class: 'symbolic', weight: 0.8 }] },
  }), 'UNKNOWN_FIELD');
  await refuses(app, context.fixture.projectId, base(context, {
    unresolved_conflicts: [{ summary: 'x', resolution: 'trust the audio' }],
  }), 'UNKNOWN_FIELD');
  // And the resolve side has its own closed set, not a union with this one.
  const submitted = await app.proposeDecision(OWNER, context.fixture.projectId, base(context));
  await assert.rejects(
    app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, { resolution: 'accept', accepted_by: RUN_REVIEWER, decisions: [] }),
    error => error.code === 'INVALID_REQUEST' && error.details.refusal === 'UNKNOWN_FIELD',
  );
});

test('a field stated only on a prototype is stated nowhere', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);

  // `Object.keys` says own; property access says own-or-inherited. A caller who
  // knows that could otherwise state a field where the key check cannot see it
  // and have it read where it counts. Every request object is REBUILT from its
  // own enumerable fields, so the two readings cannot disagree.
  const inherited = Object.create({ kind: PROPOSAL_KIND.EVIDENCE_NEEDED, action: { decisions: [] } });
  Object.assign(inherited, base(context));
  const viaPrototype = await app.proposeDecision(OWNER, context.fixture.projectId, inherited);
  assert.equal(viaPrototype.proposal.kind, PROPOSAL_KIND.ARRANGEMENT_DECISION, 'the stated kind wins; the inherited one is invisible');

  // An action whose fields are inherited states no action at all, and an
  // arrangement proposal with no action is refused rather than accepted empty.
  await refuses(app, context.fixture.projectId, base(context, { action: Object.create({ decisions: proposable(context.fixture.project) }) }), 'ACTION_KIND_MISMATCH');

  // A decision whose dangerous fields are inherited does not carry them.
  const stealth = proposable(context.fixture.project).map((decision, index) => (index ? decision : Object.assign(Object.create({ acceptedBy: 'the-agent', acceptance: { state: 'ACCEPTED' } }), decision)));
  const accepted = await app.proposeDecision(OWNER, context.fixture.projectId, base(context, { action: { decisions: stealth } }));
  assert.equal(accepted.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
  assert.ok(!JSON.stringify(accepted.proposal.action).includes('the-agent'), 'nothing inherited was stored');
  const applied = await app.resolveProposal(OWNER, context.fixture.projectId, accepted.proposal.proposal_id, { resolution: 'accept', accepted_by: RUN_REVIEWER });
  const candidate = (await app.getProject(OWNER, context.fixture.projectId)).project.candidates.find(entry => entry.candidate_id === applied.run.candidate_id);
  assert.deepEqual(candidate.accepted_by, [RUN_REVIEWER], 'the inherited acceptor never reached the acceptance binding');
});

test('a prototype-polluting key is refused wherever free-form structure is accepted', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);

  // `JSON.parse` creates a REAL own property named `__proto__`, which a plain
  // `rebuilt[key] = value` would turn into a prototype write rather than a
  // field. Refused by name, and structurally impossible besides.
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const decisions = proposable(context.fixture.project);
    const poisoned = JSON.parse(JSON.stringify(decisions[0]).replace(/^\{/, `{${JSON.stringify(key)}:{"polluted":true},`));
    await refuses(app, context.fixture.projectId, base(context, {
      action: { decisions: [poisoned, ...decisions.slice(1)] },
    }), 'PROTOTYPE_POLLUTING_KEY');
  }
  assert.equal({}.polluted, undefined, 'nothing reached Object.prototype');
});

// ─── C. fields the server computes, and evidence that must not be collapsed ─

test('a proposal may not supply the acceptance binding this service computes', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);

  // The binding is computed by the arrangement service from the baseline, the
  // suggestion and the Canonical snapshot loaded at APPLY time. A caller who
  // could supply one could make a decision claim to have been accepted against
  // material it never saw.
  const forged = proposable(context.fixture.project).map((decision, index) => (index ? decision : {
    ...decision,
    acceptance: { state: 'ACCEPTED', acceptedBy: 'the-agent', baselineContentDigest: '0'.repeat(64), canonicalRulesSnapshotSha: 'f'.repeat(40) },
  }));
  await refuses(app, context.fixture.projectId, base(context, { action: { decisions: forged } }), 'SERVER_COMPUTED_FIELD_SUPPLIED');
});

test('the run-internal provenance keys are unreachable through a proposal', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);

  // `effectAttemptId` is how an interrupted run identifies the record its own
  // attempt produced. A caller who could set it could make an unrelated record
  // claim to be an interrupted step's effect.
  //
  // The public Application Service STRIPS the internal provenance keys from
  // every operation input before the operation sees them -- that is the
  // boundary itself, not a property of how a transport happens to be written,
  // and the proposal operations go through it like every other. So the
  // guarantee to pin is that the field does not reach anything, on either the
  // submit side or the acceptance side.
  const forged = `eff_${'0'.repeat(32)}`;
  const submitted = await app.proposeDecision(OWNER, context.fixture.projectId, base(context, { effectAttemptId: forged, inputFingerprint: '0'.repeat(64) }));
  assert.ok(!JSON.stringify(submitted.proposal).includes(forged), 'the internal key did not reach the stored proposal');
  assert.ok(!JSON.stringify(submitted.proposal).includes('effectAttemptId'));

  const applied = await app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, {
    resolution: 'accept', accepted_by: RUN_REVIEWER, effectAttemptId: forged,
  });
  assert.equal(applied.applied, true);
  const candidate = (await app.getProject(OWNER, context.fixture.projectId)).project.candidates.find(entry => entry.candidate_id === applied.run.candidate_id);
  assert.notEqual(candidate.effect_attempt_id, forged, 'the run minted its own attempt id; the caller did not supply one');
  assert.ok(!JSON.stringify(applied.run).includes(forged), 'nothing the run recorded carries the forged attempt');
});

test('a single collapsed confidence score is refused wherever it is written', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);

  // SOURCE_POLICY.md §2 keeps symbolic and audio truth in separate evidence
  // fields precisely so one number cannot hide their disagreement.
  // The same mistake gets the same answer at every level, top-level request and
  // nested metadata alike. An adversarial pass found these two disagreeing --
  // one said COLLAPSED_CONFIDENCE_SCORE with the evidence-separation notice,
  // the other a bare UNKNOWN_FIELD -- which defeats the point of having the
  // codes at all: a caller is meant to tell one problem from another without
  // parsing prose.
  for (const key of COLLAPSED_SCORE_KEYS) {
    await refuses(app, context.fixture.projectId, base(context, { [key]: 0.92 }), 'COLLAPSED_CONFIDENCE_SCORE');
    await refuses(app, context.fixture.projectId, base(context, { cites: { event_ids: context.eventIds, [key]: 0.92 } }), 'COLLAPSED_CONFIDENCE_SCORE');
    const decisions = proposable(context.fixture.project);
    await refuses(app, context.fixture.projectId, base(context, {
      action: { decisions: [{ ...decisions[0], metadata: { [key]: 0.92 } }, ...decisions.slice(1)] },
    }), 'COLLAPSED_CONFIDENCE_SCORE');
  }
});

test('an own __proto__ key from a parsed body is refused by name, not consumed as a prototype write', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);

  // `JSON.parse` creates a REAL own property named `__proto__`, unlike an
  // object literal. The shared `statedFields` primitive used to assign it --
  // invoking the inherited setter and retargeting the rebuilt object's
  // prototype -- so `withoutInternalProvenance` built the forged object it
  // exists to prevent, and a service destructuring `{ effectAttemptId }` read
  // the caller's value. It now survives as ordinary data and is refused here by
  // name, which is what "refused, not ignored" has to mean for it to mean
  // anything.
  const body = JSON.parse(JSON.stringify(base(context)).replace(/^\{/, '{"__proto__":{"effectAttemptId":"eff_00000000000000000000000000000000"},'));
  assert.ok(Object.keys(body).includes('__proto__'), 'the parsed body really carries the own key');
  await refuses(app, context.fixture.projectId, body, 'PROTOTYPE_POLLUTING_KEY');

  // And the primitive itself no longer manufactures the forgery.
  const { withoutInternalProvenance } = await import('../backend/application/contracts.mjs');
  const rebuilt = withoutInternalProvenance(JSON.parse('{"__proto__":{"effectAttemptId":"eff_1","inputFingerprint":"f"},"decisions":[1]}'));
  assert.equal(rebuilt.effectAttemptId, undefined, 'internal provenance is unreachable, which is this function\'s entire purpose');
  assert.equal(rebuilt.inputFingerprint, undefined);
  assert.equal({}.effectAttemptId, undefined, 'and Object.prototype was never in play');
});

test('a citation may not mislabel which class of truth it is', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);

  // Mechanical, from the Canonical source authority the intake adapters
  // recorded. It arbitrates nothing about what either class may prove; it only
  // refuses to let the two be swapped.
  const mislabelled = await app.proposeDecision(OWNER, context.fixture.projectId, base(context, {
    cites: {
      event_ids: context.eventIds,
      source_ids: ['fixture:official-midi'],
      evidence_refs: [{ kind: 'source', id: 'fixture:official-midi', truth_class: 'audio', note: 'claimed as recording evidence' }],
    },
  }));
  // The reference resolves, and the symbolic source it names is declared audio.
  assert.equal(mislabelled.proposal.agent_review.verdict, AGENT_REVIEW.INVALID);
  assert.ok(mislabelled.proposal.agent_review.refusals.includes('COLLAPSED_CONFIDENCE_SCORE'));

  const honest = await app.proposeDecision(OWNER, context.fixture.projectId, base(context, {
    cites: {
      event_ids: context.eventIds,
      source_ids: ['fixture:official-midi'],
      evidence_refs: [{ kind: 'source', id: 'fixture:official-midi', truth_class: 'symbolic' }],
    },
  }));
  assert.equal(honest.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
  assert.deepEqual(honest.proposal.agent_review.resolved_citations.truth_classes, ['symbolic']);

  // A source nobody uploaded is a fabricated reference, whatever class it claims.
  const invented = await app.proposeDecision(OWNER, context.fixture.projectId, base(context, {
    cites: { event_ids: context.eventIds, evidence_refs: [{ kind: 'source', id: 'fixture:a-recording-nobody-has', truth_class: 'audio' }] },
  }));
  assert.equal(invented.proposal.agent_review.verdict, AGENT_REVIEW.INVALID);
  assert.ok(invented.proposal.agent_review.refusals.includes('FABRICATED_EVIDENCE_REF'));
});

// ─── D. bounds, and replay ──────────────────────────────────────────────────

test('a proposal is bounded in every direction a caller controls', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);

  await refuses(app, context.fixture.projectId, base(context, { rationale: 'x'.repeat(LIMITS.maxProposalRationaleLength + 1) }));
  await refuses(app, context.fixture.projectId, base(context, { proposed_by: 'x'.repeat(121) }));
  await refuses(app, context.fixture.projectId, base(context, {
    cites: { event_ids: Array.from({ length: LIMITS.maxProposalCitations + 1 }, (_, index) => `melody-${index}`) },
  }));
  await refuses(app, context.fixture.projectId, base(context, {
    missing_evidence: Array.from({ length: LIMITS.maxProposalConflicts + 1 }, () => 'more'),
  }));
  // Deeply nested free-form structure is spent against a budget here rather
  // than discovered by a recursion limit on the way to disk.
  let deep = { leaf: true };
  for (let level = 0; level < 20; level += 1) deep = { nested: deep };
  const decisions = proposable(context.fixture.project);
  await refuses(app, context.fixture.projectId, base(context, {
    action: { decisions: [{ ...decisions[0], metadata: deep }, ...decisions.slice(1)] },
  }));
  // And a project cannot be filled without limit.
  assert.equal(typeof LIMITS.maxProposalsPerProject, 'number');
});

test('the same idempotency key replays a proposal rather than storing a second one', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);
  const input = base(context, { idempotency_key: 'agent-attempt-1' });

  const first = await app.proposeDecision(OWNER, context.fixture.projectId, input);
  const replay = await app.proposeDecision(OWNER, context.fixture.projectId, input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.proposal.proposal_id, first.proposal.proposal_id);
  assert.equal((await app.listProposals(OWNER, context.fixture.projectId)).proposals.length, 1);

  // The same key with a different payload is refused rather than resolved in
  // favour of either: the first request already bound the key.
  await assert.rejects(
    app.proposeDecision(OWNER, context.fixture.projectId, base(context, { idempotency_key: 'agent-attempt-1', rationale: 'A different argument entirely.' })),
    error => error.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.equal((await app.listProposals(OWNER, context.fixture.projectId)).proposals.length, 1);
});
