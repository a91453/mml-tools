// The AI Proposal Protocol — the attacks that worked, before they were fixed.
//
// Every test here reproduces a real escalation found by an independent
// adversarial review of the Phase 2 code as first written. Each one is kept in
// the shape it was found in, because a regression written from the fix tests
// the fix, and a regression written from the attack tests the boundary.
//
// The first is the one worth reading. A well-formed Lead evidence record whose
// score citation literally read "I, the model, recall the score shows an inner
// voice here" moved BOTH Gate 3 axes to PASS, through an accepted proposal,
// with every other guard in this protocol working exactly as designed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_REVIEW, AGENT_REVIEW_ORDER, LIMITS, PROPOSAL_KIND, RUN_STEP, createStudioApplication } from '../backend/application/index.mjs';
import { RUN_REVIEWER, projectWithSymbolicAsset, runDecisionsFor } from './fixtures/run-fixtures.mjs';

const OWNER = 'owner:proposal-adversarial';
const AGENT = 'some-external-agent';

const proposable = project => runDecisionsFor(project, {}).map(({ acceptedBy, note, ...rest }) => rest);

const withDirectory = async body => {
  const directory = await mkdtemp(join(tmpdir(), 'mml-proposal-adversarial-'));
  try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};

async function prepared(app, owner = OWNER) {
  const fixture = await projectWithSymbolicAsset(app, owner);
  const started = await app.startRun(owner, fixture.projectId, { asset_ids: [fixture.assetId] });
  const targets = await app.proposalTargets(owner, fixture.projectId, started.run.run_id);
  const target = targets.targets.find(entry => entry.admissible_kinds.includes(PROPOSAL_KIND.ARRANGEMENT_DECISION));
  const events = (await app.listBaselineEvents(owner, fixture.projectId, { limit: 50 })).events;
  return { fixture, run: started.run, target, events };
}

// ─── A. a machine may not author the evidence for its own proposal ──────────

test('a proposal cannot author a Lead evidence record, however well formed it is', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);
  const promoted = context.events.find(entry => entry.role === 'Chord1' && entry.kind === 'note');
  const demoted = context.events.find(entry => entry.role === 'Melody' && entry.kind === 'note');

  // The record the attack used. It binds correctly: real source identities,
  // continuity checked, Core3 checked, a section role the grader accepts. The
  // grader can verify every one of those. What nothing can verify is the one
  // thing that matters — whether anybody read the source — and the citations
  // say outright that nobody did.
  const leadEvidence = (event, destination) => ({
    sourceIdentity: { sourceId: event.source_ids[0], sourceEventId: event.source_event_ids[0] },
    sectionRole: destination === 'Melody' ? 'instrumental-lead' : 'vocal-active',
    scoreEvidence: { availability: 'available', classification: destination === 'Melody' ? 'lead' : 'accompaniment', citation: 'I, the model, recall the score shows this line here.' },
    audioEvidence: { availability: 'available', classification: destination === 'Melody' ? 'foreground' : 'background', citation: 'I, the model, recall the recording places it there.' },
    continuity: { checked: true, createsLeadGap: false },
    core3: { checked: true, status: 'INTACT' },
    destinationReason: 'The agent is confident about this.',
  });

  for (const [event, fromRole, toRole] of [[promoted, 'Chord1', 'Melody'], [demoted, 'Melody', 'Chord1']]) {
    await assert.rejects(
      app.proposeDecision(OWNER, context.fixture.projectId, {
        run_id: context.run.run_id,
        request_key: context.target.request_key,
        kind: PROPOSAL_KIND.ARRANGEMENT_DECISION,
        proposed_by: AGENT,
        rationale: `Move ${event.event_id} from ${fromRole} to ${toRole}.`,
        action: {
          decisions: [...proposable(context.fixture.project), {
            id: `move:${event.event_id}`,
            type: 'MOVE_ROLE',
            target: { eventIds: [event.event_id] },
            fromRole,
            toRole,
            reason: 'Reviewed by the agent.',
            evidence: [`${event.source_ids[0]}#${event.event_id}`],
            leadEvidence: leadEvidence(event, toRole),
          }],
        },
        cites: { event_ids: [event.event_id] },
      }),
      error => {
        assert.equal(error.code, 'INVALID_REQUEST');
        assert.equal(error.details.refusal, 'REVIEWER_EVIDENCE_RECORD_SUPPLIED');
        return true;
      },
      `a ${fromRole} → ${toRole} move must not carry its own Lead evidence`,
    );
  }

  // Nothing was stored and nothing moved.
  assert.equal((await app.listProposals(OWNER, context.fixture.projectId)).proposals.length, 0);
  assert.deepEqual((await app.getProject(OWNER, context.fixture.projectId)).project.candidates, []);
});

test('a reduction decision may not carry a Lead evidence record either', async () => {
  // `leadEvidence` is in the REDUCTION engine's decision key set as well as the
  // arrangement engine's, and a G12 REDISTRIBUTE into Melody is a Lead move.
  // One refusal covers both because both classes share the decision key check;
  // this pins that they do, so a later split of that branch cannot reopen the
  // hole on the path nobody was looking at.
  const { baselineWithUnassignedRole, FIXTURE_SOURCE_ID } = await import('./fixtures/g12-fixtures.mjs');
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER, { project: baselineWithUnassignedRole() });
  const started = await app.startRun(OWNER, fixture.projectId, {
    asset_ids: [fixture.assetId],
    decisions: runDecisionsFor(fixture.project, { exclude: ['Chord5'], acceptedBy: RUN_REVIEWER }),
    accepted_by: RUN_REVIEWER,
  });
  const target = (await app.proposalTargets(OWNER, fixture.projectId, started.run.run_id))
    .targets.find(entry => entry.code === 'REDUCTION_DECISIONS_REQUIRED');
  assert.ok(target, 'the run must be waiting on reduction decisions');

  await assert.rejects(
    app.proposeDecision(OWNER, fixture.projectId, {
      run_id: started.run.run_id,
      request_key: target.request_key,
      kind: PROPOSAL_KIND.FINAL_REDUCTION,
      proposed_by: AGENT,
      rationale: 'Redistribute the unassigned lane into Melody.',
      action: {
        decisions: [{
          id: 'redistribute-into-melody',
          action: 'REDISTRIBUTE',
          eventIds: ['chord5-1'],
          toRole: 'Melody',
          reason: 'The agent believes this is the lead.',
          evidence: [`${FIXTURE_SOURCE_ID}#Chord5`],
          leadEvidence: {
            sourceIdentity: { sourceId: FIXTURE_SOURCE_ID, sourceEventId: `${FIXTURE_SOURCE_ID}#chord5-1` },
            sectionRole: 'instrumental-lead',
            scoreEvidence: { availability: 'available', classification: 'lead', citation: 'I, the model, recall the score.' },
            audioEvidence: { availability: 'available', classification: 'foreground', citation: 'I, the model, recall the recording.' },
            continuity: { checked: true, createsLeadGap: false },
            core3: { checked: true, status: 'INTACT' },
            destinationReason: 'The agent is confident.',
          },
        }],
      },
      cites: { event_ids: ['chord5-1'], source_ids: [FIXTURE_SOURCE_ID] },
    }),
    error => error.code === 'INVALID_REQUEST' && error.details.refusal === 'REVIEWER_EVIDENCE_RECORD_SUPPLIED',
  );
});

test('the Lead move itself stays proposable, and lands on PENDING rather than PASS', async () => {
  // Refusing the evidence record must not refuse the proposal. An agent can
  // still say "this belongs in Melody, and here is why"; what it cannot do is
  // also supply the reviewer's citation. Without one the engine holds the move
  // PENDING, which is the honest state and exactly what `SOURCE_POLICY.md` §4
  // requires of conflicting or incomplete Lead evidence.
  const app = createStudioApplication({});
  const context = await prepared(app);
  const event = context.events.find(entry => entry.role === 'Chord1' && entry.kind === 'note');

  const submitted = await app.proposeDecision(OWNER, context.fixture.projectId, {
    run_id: context.run.run_id,
    request_key: context.target.request_key,
    kind: PROPOSAL_KIND.ARRANGEMENT_DECISION,
    proposed_by: AGENT,
    rationale: 'This voice carries the foreground line through the instrumental window; a reviewer should check the score and supply the Lead citation.',
    action: {
      decisions: [...proposable(context.fixture.project), {
        id: `move:${event.event_id}`,
        type: 'MOVE_ROLE',
        target: { eventIds: [event.event_id] },
        fromRole: 'Chord1',
        toRole: 'Melody',
        reason: 'Proposed for review; the Lead citation is the reviewer\'s to supply.',
        evidence: [`${event.source_ids[0]}#${event.event_id}`],
      }],
    },
    cites: { event_ids: [event.event_id] },
  });
  assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);

  const accepted = await app.resolveProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id, {
    resolution: 'accept', accepted_by: RUN_REVIEWER,
  });
  // The engine refused the unevidenced promotion, exactly as it does for a
  // manual caller, and said so in its own words.
  const step = accepted.run.steps.find(entry => entry.step === RUN_STEP.APPLY_DECISIONS);
  assert.equal(step.status, 'blocked');
  assert.ok(accepted.run.blockers.includes('LEAD_PROMOTION_EVIDENCE_REQUIRED'), accepted.run.blockers.join(', '));
  assert.equal(accepted.run.candidate_id, null, 'no candidate was minted on an unevidenced Lead move');
});

// ─── B. an interrupted step is a marker, not a flag set later ───────────────

test('a run whose step may or may not have landed accepts no proposal', async () => {
  await withDirectory(async directory => {
  const app = createStudioApplication({
    dataDirectory: directory,
    durability: 'persistent',
    // Stop inside the effect of the run's own first advancement, so the run is
    // left carrying a pending marker: the step's effect may or may not exist,
    // and nothing has yet tried to settle it.
    runHooks: { afterEffect: ({ step }) => { if (step === RUN_STEP.APPLY_DECISIONS) throw Error('the process stopped after the effect'); } },
  });
  const fixture = await projectWithSymbolicAsset(app, OWNER);
  await app.startRun(OWNER, fixture.projectId, {
    asset_ids: [fixture.assetId],
    decisions: runDecisionsFor(fixture.project, { acceptedBy: RUN_REVIEWER }),
    accepted_by: RUN_REVIEWER,
  }).then(() => assert.fail('the injected fault must propagate'), error => error);

  // A fresh service over the same records, with no fault injected.
  const clean = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
  const runId = (await clean.getRun(OWNER, fixture.projectId)).runs[0].run_id;
  const run = (await clean.getRun(OWNER, fixture.projectId, runId)).run;

  // `needs_reconciliation` is a DERIVED flag the run writes only after a later
  // advancement has already failed to settle the effect. `pending_step` is the
  // marker written before the effect. Reading only the flag left exactly the
  // window that matters.
  assert.ok(run.pending_step, 'the marker is there');
  assert.equal(run.needs_reconciliation, false, 'and the derived flag is not set yet — this is the window');

  const targets = await clean.proposalTargets(OWNER, fixture.projectId, runId);
  assert.equal(targets.accepts_proposals, false, 'a run that may or may not have applied a step is not a place to apply one');

  // A proposal against it is STALE, and accepting it is refused.
  const target = targets.targets[0];
  if (target) {
    const events = (await clean.listBaselineEvents(OWNER, fixture.projectId, { limit: 2 })).events;
    const submitted = await clean.proposeDecision(OWNER, fixture.projectId, {
      run_id: runId,
      request_key: target.request_key,
      kind: PROPOSAL_KIND.EVIDENCE_NEEDED,
      proposed_by: AGENT,
      rationale: 'Describing what is missing while the run is unsettled.',
      missing_evidence: ['Whether the interrupted step landed.'],
    }).catch(error => ({ error }));
    if (!submitted.error) {
      const verdict = (await clean.getProposal(OWNER, fixture.projectId, submitted.proposal.proposal_id)).proposal.agent_review;
      assert.equal(verdict.verdict, AGENT_REVIEW.STALE);
      assert.ok(verdict.refusals.includes('RUN_NEEDS_RECONCILIATION'), verdict.refusals.join(', '));
      await assert.rejects(
        clean.resolveProposal(OWNER, fixture.projectId, submitted.proposal.proposal_id, { resolution: 'accept', accepted_by: RUN_REVIEWER }),
        error => error.code === 'PROPOSAL_REFUSED',
      );
    }
  }
  });
});

// ─── C. the ladder the policy actually walks ────────────────────────────────

test('a proposal that is both stale and forged is reported stale, because staleness explains the forgery', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);
  const submitted = await app.proposeDecision(OWNER, context.fixture.projectId, {
    run_id: context.run.run_id,
    request_key: context.target.request_key,
    kind: PROPOSAL_KIND.ARRANGEMENT_DECISION,
    proposed_by: AGENT,
    rationale: 'Keep every source-supported role.',
    action: { decisions: proposable(context.fixture.project) },
    cites: { event_ids: [context.events[0].event_id] },
  });
  assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);

  // Move the run, which also moves the request key and the candidate.
  await app.resumeRun(OWNER, context.fixture.projectId, context.run.run_id, {
    decisions: runDecisionsFor(context.fixture.project, { acceptedBy: RUN_REVIEWER }),
  });

  const reread = await app.getProposal(OWNER, context.fixture.projectId, submitted.proposal.proposal_id);
  assert.equal(reread.proposal.agent_review.verdict, AGENT_REVIEW.STALE);
  assert.ok(!reread.proposal.agent_review.refusals.includes('FABRICATED_EVENT_ID'),
    'an honest proposal whose material moved must not be accused of fabricating a citation');

  // And the exported ladder says the same thing the policy does, so a caller
  // that ranks refusals by it is not ranking them by the wrong order.
  assert.equal(AGENT_REVIEW_ORDER[0], AGENT_REVIEW.STALE);
  assert.equal(AGENT_REVIEW_ORDER[1], AGENT_REVIEW.INVALID);
});

// ─── D. colliding request keys are refused, never resolved ──────────────────

test('two open requests that share a key are refused as ambiguous rather than resolved to either', async () => {
  const { requestKeyOf } = await import('../backend/application/proposal-contracts.mjs');

  // The run really does produce these: `stalenessRequest` projects every
  // non-meter reason onto one fixed shape — same code, same step, no gate, one
  // report reference, no baseline, no candidate — so an asset change and a
  // Canonical snapshot change on one run key alike.
  const shape = {
    code: 'RUN_INPUT_CHANGED',
    step: 'review',
    gate: null,
    report_reference: 'run.inputs versus the committed project record',
    baseline_id: null,
    candidate_id: null,
  };
  assert.equal(
    requestKeyOf({ ...shape, blockers: ['RUN_INPUT_CHANGED'], detail: { asset_id: 'ast_a', reason: 'ASSET_REMOVED' } }),
    requestKeyOf({ ...shape, blockers: ['RUN_CANONICAL_SNAPSHOT_CHANGED'], detail: { loaded_rules_snapshot_sha: 'f'.repeat(40) } }),
    'the collision is real, and the code must not claim otherwise',
  );

  // It costs nothing, and that is why refusing is the right answer: the
  // requests that can collide admit only a description of what is missing,
  // which reaches no operation at all.
  const { PROPOSAL_TARGETS, PROPOSAL_KIND: KIND } = await import('../backend/application/proposal-contracts.mjs');
  assert.deepEqual([...PROPOSAL_TARGETS.RUN_INPUT_CHANGED], [KIND.EVIDENCE_NEEDED]);
});

// ─── E. a bound that is only a shape is not a bound ─────────────────────────

test('a proposal is bounded in BYTES, not only in nodes, depth and string length', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);
  const decisions = proposable(context.fixture.project);
  const submit = metadata => app.proposeDecision(OWNER, context.fixture.projectId, {
    run_id: context.run.run_id,
    request_key: context.target.request_key,
    kind: PROPOSAL_KIND.ARRANGEMENT_DECISION,
    proposed_by: AGENT,
    rationale: 'Keep every source-supported role.',
    action: { decisions: [{ ...decisions[0], metadata }, ...decisions.slice(1)] },
    cites: { event_ids: [context.events[0].event_id] },
  });

  // The payload the adversarial pass used, and the one that matters: it breaks
  // NO declared bound. 1850 values, each a string of exactly maxStringLength,
  // is 1851 of 4000 nodes at depth 3 — and 7 MB. The node, depth and string
  // budgets bound the SHAPE of a proposal's free-form structure; none of them
  // bounds its size, and 4000 nodes times a 4000-character string is 15 MB
  // inside every one of them. It was stored verbatim in the project record,
  // while that record's own comment called a proposal "small by construction".
  await assert.rejects(
    submit({ notes: Array.from({ length: 1850 }, () => 'x'.repeat(4000)) }),
    error => {
      assert.equal(error.code, 'PAYLOAD_TOO_LARGE');
      assert.equal(error.details.max_proposal_bytes, LIMITS.maxProposalBytes);
      assert.ok(error.details.received_bytes > LIMITS.maxProposalBytes);
      return true;
    },
  );

  // A long KEY is bounded too. It costs no node, so 75 keys of 100,000
  // characters spent 75 of 4000 — a separate gap from the one above, and not
  // the one that made a 7 MB proposal storable.
  const fatKeys = {};
  for (let index = 0; index < 75; index += 1) fatKeys[`k${index}${'A'.repeat(100000)}`] = 1;
  await assert.rejects(submit(fatKeys), error => error.code === 'PAYLOAD_TOO_LARGE' && /field name longer than/.test(error.message));

  // And an ordinary proposal is unaffected.
  const ordinary = await submit({ note: 'an ordinary amount of structure' });
  assert.equal(ordinary.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);
  assert.ok(LIMITS.maxProposalBytes <= 131072, 'the ceiling must not exceed what MCP will carry, or HTTP admits what MCP cannot');
});

test('the proposal cap refuses with a remedy that actually works', async () => {
  const app = createStudioApplication({});
  const context = await prepared(app);
  const describe = index => ({
    run_id: context.run.run_id,
    request_key: context.target.request_key,
    kind: PROPOSAL_KIND.EVIDENCE_NEEDED,
    proposed_by: AGENT,
    rationale: `Statement ${index}: what is missing here.`,
    missing_evidence: ['A score covering this section.'],
  });

  const ids = [];
  for (let index = 0; index < LIMITS.maxProposalsPerProject; index += 1) {
    ids.push((await app.proposeDecision(OWNER, context.fixture.projectId, describe(index))).proposal.proposal_id);
  }

  // At the cap, and the read side says so. It used to answer `true` here while
  // every submission was refused — a capability advertised by the read side
  // that the write side could never honour.
  assert.equal((await app.proposalTargets(OWNER, context.fixture.projectId, context.run.run_id)).accepts_proposals, false);
  await assert.rejects(
    app.proposeDecision(OWNER, context.fixture.projectId, describe(999)),
    error => {
      assert.equal(error.code, 'STORAGE_FULL');
      assert.match(error.message, /Resolve or withdraw one/);
      return true;
    },
  );

  // Following the stated remedy works. It did not: the cap counted every
  // proposal the project had ever held, resolving removes nothing, and the
  // project was locked out of the protocol permanently at the cap. An
  // adversarial pass followed the instruction exactly and got the same
  // refusal back — a refusal naming a remedy that does not exist is the same
  // defect as a stated field that binds nothing.
  await app.resolveProposal(OWNER, context.fixture.projectId, ids[0], { resolution: 'reject', reason: 'Freeing a slot, as the refusal says to.' });
  assert.equal((await app.proposalTargets(OWNER, context.fixture.projectId, context.run.run_id)).accepts_proposals, true,
    'the slot is free, and the read side says so before anything is written into it');
  const after = await app.proposeDecision(OWNER, context.fixture.projectId, describe(1000));
  assert.equal(after.proposal.agent_review.verdict, AGENT_REVIEW.PROPOSABLE, 'resolving one really freed a slot');
  // And filling it again puts the project back at the cap, which is the point:
  // the slot was freed, not the cap raised.
  assert.equal((await app.proposalTargets(OWNER, context.fixture.projectId, context.run.run_id)).accepts_proposals, false);

  // The resolved one is still on the record: nothing is evicted, which is why
  // the lifetime total has its own ceiling and its own refusal — one that
  // promises no remedy, because there is none but a new project.
  const listed = (await app.listProposals(OWNER, context.fixture.projectId)).proposals;
  assert.equal(listed.length, LIMITS.maxProposalsPerProject + 1);
  assert.ok(listed.some(entry => entry.proposal_id === ids[0] && entry.state === 'rejected'));
  assert.ok(LIMITS.maxProposalsRetainedPerProject > LIMITS.maxProposalsPerProject);
});
