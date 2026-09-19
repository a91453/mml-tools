// The AI Proposal Protocol — identity and staleness.
//
// A proposal is written against material an agent read at one moment. Between
// that moment and an acceptance, everything it describes can move: the
// published rules, the sources, the baseline, the candidate, the accepted
// decision set, the run, the very request it answers.
//
// The rule is fail closed, and the shape of the rule matters as much as the
// rule. Nothing here expires a proposal by walking records when something
// changes — there is no sweeper, and a sweeper would be one more thing that
// can be wrong. Instead the bindings are re-read from scratch on every read and
// again under the lock immediately before an acceptance, so a stale proposal is
// one that has never been anything else since the moment it went stale.
//
// Two halves are tested here and both are needed: the proposal against the RUN
// (what the run recorded), and the proposal against the PROJECT (what is
// actually stored now). A run holds what it wrote down, so re-ingesting under
// new sources or applying a revision outside the run moves the material without
// moving anything the run recorded.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_REVIEW, PROPOSAL_KIND, PROPOSAL_STATE, RUN_STATE, createStudioApplication } from '../backend/application/index.mjs';
import { FIXTURE_CONFIRMATIONS, RUN_REVIEWER, canonicalProjectBytes, projectWithSymbolicAsset, runDecisionsFor, sixRoleBaseline } from './fixtures/run-fixtures.mjs';
import { enginesWith } from './support/real-engines.mjs';

const OWNER = 'owner:proposal-staleness';
const AGENT = 'some-external-agent';

const proposable = project => runDecisionsFor(project, {}).map(({ acceptedBy, note, ...rest }) => rest);

const withDirectory = async body => {
  const directory = await mkdtemp(join(tmpdir(), 'mml-proposal-staleness-'));
  try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};

async function proposedAgainstDecisions(app, owner = OWNER) {
  const fixture = await projectWithSymbolicAsset(app, owner);
  const started = await app.startRun(owner, fixture.projectId, { asset_ids: [fixture.assetId] });
  const targets = await app.proposalTargets(owner, fixture.projectId, started.run.run_id);
  const target = targets.targets.find(entry => entry.admissible_kinds.includes(PROPOSAL_KIND.ARRANGEMENT_DECISION));
  const events = await app.listBaselineEvents(owner, fixture.projectId, { limit: 3 });
  const submitted = await app.proposeDecision(owner, fixture.projectId, {
    run_id: started.run.run_id,
    expected_run_revision: started.run.revision,
    request_key: target.request_key,
    kind: PROPOSAL_KIND.ARRANGEMENT_DECISION,
    proposed_by: AGENT,
    rationale: 'Keep every source-supported role.',
    action: { decisions: proposable(fixture.project) },
    cites: { event_ids: events.events.map(entry => entry.event_id) },
  });
  assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE, 'the proposal must start applicable');
  return { fixture, run: started.run, target, proposal: submitted.proposal };
}

/** Accepting must refuse, with the verdict and cause the reader is owed. */
const refusesAcceptance = async (app, projectId, proposalId, cause, owner = OWNER) => {
  await assert.rejects(
    app.resolveProposal(owner, projectId, proposalId, { resolution: 'accept', accepted_by: RUN_REVIEWER }),
    error => {
      assert.equal(error.code, 'PROPOSAL_REFUSED', error.message);
      assert.equal(error.details.agent_review.verdict, AGENT_REVIEW.STALE);
      assert.ok(error.details.agent_review.refusals.includes(cause), `expected ${cause}, got ${error.details.agent_review.refusals.join(', ')}`);
      return true;
    },
  );
};

// ─── A. the material moved ──────────────────────────────────────────────────

test('a proposal whose baseline was replaced underneath it is refused', async () => {
  const app = createStudioApplication({});
  const context = await proposedAgainstDecisions(app);

  // A second symbolic source, and a real re-intake over both. The project's
  // baseline is now a different content-addressed identity, and every decision
  // written against the old one describes sources that are no longer the
  // project's.
  const second = (await app.uploadAsset(OWNER, context.fixture.projectId, {
    kind: 'canonical_project',
    filename: 'second.json',
    mediaType: 'application/json',
    bytes: canonicalProjectBytes(sixRoleBaseline({ id: 'fixture:second-baseline', title: 'Second source' })),
  })).asset;
  const reingested = await app.analyzeSources(OWNER, context.fixture.projectId, { assetIds: [context.fixture.assetId, second.asset_id] });
  assert.notEqual(reingested.baseline.baseline_id, context.run.baseline_id, 'the baseline really changed');

  const reread = await app.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id);
  assert.equal(reread.proposal.agent_review.verdict, AGENT_REVIEW.STALE);
  assert.ok(reread.proposal.agent_review.refusals.includes('BASELINE_CHANGED'));
  await refusesAcceptance(app, context.fixture.projectId, context.proposal.proposal_id, 'BASELINE_CHANGED');
});

test('a proposal whose selected source bytes no longer match what the run recorded is refused', async () => {
  // An upload mints a NEW asset id, so a selected asset's bytes cannot change
  // through the public surface -- which is the point of content-addressing
  // them. What this pins is the restored-record case: a stored record whose
  // asset no longer matches the digest the run snapshotted, which is what a
  // partial restore, an out-of-band edit or a corrupted volume leaves behind.
  // The durability regressions reach the same class of state the same way.
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const context = await proposedAgainstDecisions(app);

    const records = join(directory, 'records');
    const [name] = await readdir(records);
    const stored = JSON.parse(await readFile(join(records, name), 'utf8'));
    stored.assets = stored.assets.map(asset => (asset.asset_id === context.fixture.assetId ? { ...asset, sha256: 'e'.repeat(64) } : asset));
    await writeFile(join(records, name), JSON.stringify(stored));

    const restarted = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const reread = await restarted.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id);
    assert.equal(reread.proposal.agent_review.verdict, AGENT_REVIEW.STALE);
    assert.ok(reread.proposal.agent_review.refusals.includes('ASSET_SELECTION_CHANGED'), reread.proposal.agent_review.refusals.join(', '));
    await refusesAcceptance(restarted, context.fixture.projectId, context.proposal.proposal_id, 'ASSET_SELECTION_CHANGED');
  });
});

test('a proposal is refused once a revision is applied from outside the run', async () => {
  const app = createStudioApplication({});
  const context = await proposedAgainstDecisions(app);

  // A direct `applyDecisions`, which the run knows nothing about. The run's own
  // recorded candidate has not moved; the PROJECT has. A proposal that only
  // compared itself against the run would still read as applicable here.
  const applied = await app.applyDecisions(OWNER, context.fixture.projectId, {
    decisions: runDecisionsFor(context.fixture.project, { acceptedBy: RUN_REVIEWER }),
  });
  assert.equal(applied.decisions.applied, true);

  // The proposal is still applicable, because a sibling candidate changed
  // nothing it is bound to — and that is correct, not a hole: the run is still
  // waiting for exactly the decisions this proposal carries.
  const reread = await app.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id);
  assert.equal(reread.proposal.agent_review.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE);

  // What DOES expire it is the run advancing, which is the next test.
  assert.equal(reread.proposal.binding.candidate_id, null);
});

// ─── B. the run moved ───────────────────────────────────────────────────────

test('a proposal is refused once the run advances past the revision it was written against', async () => {
  const app = createStudioApplication({});
  const context = await proposedAgainstDecisions(app);

  const resumed = await app.resumeRun(OWNER, context.fixture.projectId, context.run.run_id, {
    decisions: runDecisionsFor(context.fixture.project, { acceptedBy: RUN_REVIEWER }),
  });
  assert.ok(resumed.run.revision > context.run.revision, 'the run advanced');

  const reread = await app.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id);
  assert.equal(reread.proposal.agent_review.verdict, AGENT_REVIEW.STALE);
  const refusals = reread.proposal.agent_review.refusals;
  assert.ok(refusals.includes('RUN_REVISION_CHANGED'), refusals.join(', '));
  // The request it answered is not open any more either, so its key addresses
  // nothing — and a key that addresses nothing is never resolved to whatever
  // looks closest.
  assert.ok(refusals.includes('REQUEST_NO_LONGER_OPEN'), refusals.join(', '));
  assert.ok(refusals.includes('CANDIDATE_CHANGED'), refusals.join(', '));
  await refusesAcceptance(app, context.fixture.projectId, context.proposal.proposal_id, 'RUN_REVISION_CHANGED');
});

test('a proposal cannot be submitted against a run revision the agent did not read', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER);
  const started = await app.startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId] });
  const targets = await app.proposalTargets(OWNER, fixture.projectId, started.run.run_id);
  const target = targets.targets[0];
  const events = await app.listBaselineEvents(OWNER, fixture.projectId, { limit: 2 });

  await assert.rejects(
    app.proposeDecision(OWNER, fixture.projectId, {
      run_id: started.run.run_id,
      expected_run_revision: started.run.revision + 5,
      request_key: target.request_key,
      kind: PROPOSAL_KIND.ARRANGEMENT_DECISION,
      proposed_by: AGENT,
      rationale: 'Written against a run state that does not exist.',
      action: { decisions: proposable(fixture.project) },
      cites: { event_ids: events.events.map(entry => entry.event_id) },
    }),
    error => error.code === 'RUN_CONFLICT',
  );
});

test('a request key that no open request carries addresses nothing and is refused outright', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER);
  const started = await app.startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId] });
  const events = await app.listBaselineEvents(OWNER, fixture.projectId, { limit: 2 });

  // Well-formed, and belonging to no request on this run. The service does not
  // pick the closest one, the first one, or the only one.
  await assert.rejects(
    app.proposeDecision(OWNER, fixture.projectId, {
      run_id: started.run.run_id,
      request_key: `req:${'c'.repeat(64)}`,
      kind: PROPOSAL_KIND.ARRANGEMENT_DECISION,
      proposed_by: AGENT,
      rationale: 'Addressed at nothing.',
      action: { decisions: proposable(fixture.project) },
      cites: { event_ids: events.events.map(entry => entry.event_id) },
    }),
    error => {
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.equal(error.details.refusal, 'REQUEST_NO_LONGER_OPEN');
      assert.equal(error.details.open_request_keys.length, 1, 'the open keys are named, so a caller can recover');
      return true;
    },
  );

  // A malformed one never gets that far.
  await assert.rejects(
    app.proposeDecision(OWNER, fixture.projectId, {
      run_id: started.run.run_id,
      request_key: 'the-first-one',
      kind: PROPOSAL_KIND.EVIDENCE_NEEDED,
      proposed_by: AGENT,
      rationale: 'Addressed by position.',
    }),
    error => error.details.refusal === 'FABRICATED_REQUEST_KEY',
  );
});

// ─── C. the published rules moved ───────────────────────────────────────────

test('a proposal bound to one rules snapshot will not be applied under another', async () => {
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const context = await proposedAgainstDecisions(app);
    const boundSnapshot = context.proposal.binding.rules_snapshot_sha;
    assert.match(boundSnapshot, /^[0-9a-f]{40}$/);

    // A second service over the same records, reporting a different published
    // release. Everything else about the load is real.
    const relabelled = createStudioApplication({
      dataDirectory: directory,
      durability: 'persistent',
      loadEngines: enginesWith(engines => ({
        rules: {
          ...engines.rules,
          PUBLISHED_CANONICAL: {
            ...engines.rules.PUBLISHED_CANONICAL,
            metadata: { ...engines.rules.PUBLISHED_CANONICAL.metadata, rules_snapshot_sha: 'f'.repeat(40) },
          },
        },
      })),
    });

    const reread = await relabelled.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id);
    assert.equal(reread.proposal.agent_review.verdict, AGENT_REVIEW.STALE);
    assert.ok(reread.proposal.agent_review.refusals.includes('CANONICAL_SNAPSHOT_CHANGED'));
    await refusesAcceptance(relabelled, context.fixture.projectId, context.proposal.proposal_id, 'CANONICAL_SNAPSHOT_CHANGED');

    // The Canonical identity and the implementation identity stay separate
    // records: a code change is not a release change and vice versa.
    assert.equal(reread.proposal.implementation.proposal_schema, 'mabinogi-mobile-mml-studio/application-proposal@1');
    assert.match(reread.proposal.implementation.notice, /not a new Canonical release/);
    assert.equal(reread.proposal.canonical.rules_snapshot_sha, boundSnapshot);
  });
});

test('a proposal that names no rules snapshot is never applicable, whatever is published now', async () => {
  // Reachable with no fault injection beyond the one this repository already
  // uses for an unavailable Published Canonical, and with no record editing:
  // the deployment comes up without its Canonical source -- a missing bootstrap
  // token, an unreachable snapshot -- and an agent submits while it is down.
  //
  // `bindingOf` then records `rules_snapshot_sha: null`, because that is
  // honestly what was loaded. The defect was what happened next: the staleness
  // check read a null binding as "no snapshot to disagree with" and skipped
  // itself, so the proposal was `REQUIRES_EXPLICIT_ACCEPTANCE` while Canonical
  // judgment was stopped, and stayed applicable under every release published
  // afterwards. Unknown is not a wildcard anywhere else in this protocol, and
  // the rules release is the last place it could be one.
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await projectWithSymbolicAsset(app, OWNER);
    const started = await app.startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId] });
    const applied = await app.resumeRun(OWNER, fixture.projectId, started.run.run_id, {
      decisions: runDecisionsFor(fixture.project, { acceptedBy: RUN_REVIEWER }), accepted_by: RUN_REVIEWER,
    });
    const candidateId = applied.run.candidate_id;

    const second = await app.startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId] });
    const targets = await app.proposalTargets(OWNER, fixture.projectId, second.run.run_id);
    const target = targets.targets.find(entry => entry.admissible_kinds.includes(PROPOSAL_KIND.CANDIDATE_SELECTION));

    const down = createStudioApplication({
      dataDirectory: directory,
      durability: 'persistent',
      loadEngines: async () => { throw Error('Published Manifest is unavailable'); },
    });
    assert.equal((await down.capabilities()).canonical.status, 'CANONICAL_NOT_LOADED');

    const submitted = await down.proposeDecision(OWNER, fixture.projectId, {
      run_id: second.run.run_id,
      request_key: target.request_key,
      kind: PROPOSAL_KIND.CANDIDATE_SELECTION,
      proposed_by: AGENT,
      rationale: 'Adopt the candidate that already exists.',
      action: { candidate_id: candidateId },
    });
    assert.equal(submitted.proposal.binding.rules_snapshot_sha, null, 'it honestly records that it knows of none');
    // While Canonical is down nothing may read as applicable: the published
    // rules are what an acceptance would be judged under, and there are none.
    assert.equal(submitted.proposal.agent_review.verdict, AGENT_REVIEW.STALE);
    assert.ok(submitted.proposal.agent_review.refusals.includes('CANONICAL_SNAPSHOT_UNKNOWN'));

    // And it does not become applicable when a release is published again. The
    // proposal was written under rules this service cannot name; naming one now
    // does not retroactively bind it to that one.
    const up = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const reread = await up.getProposal(OWNER, fixture.projectId, submitted.proposal.proposal_id);
    assert.match(reread.canonical.rules_snapshot_sha, /^[0-9a-f]{40}$/);
    assert.equal(reread.proposal.agent_review.verdict, AGENT_REVIEW.STALE);
    assert.equal(reread.proposal.agent_review.acceptable, false);
    await refusesAcceptance(up, fixture.projectId, submitted.proposal.proposal_id, 'CANONICAL_SNAPSHOT_UNKNOWN');
  });
});

test('a stored binding that predates the snapshot field is not a binding to every snapshot', async () => {
  // The restore half of the same rule. A record written by a schema without the
  // field comes back with the field absent, and an absent field must not read
  // as "matches whatever is loaded now".
  await withDirectory(async directory => {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const context = await proposedAgainstDecisions(app);

    const files = await readdir(join(directory, 'records'));
    let patched = false;
    for (const name of files) {
      const path = join(directory, 'records', name);
      const body = await readFile(path, 'utf8');
      if (!body.includes(context.proposal.proposal_id)) continue;
      const record = JSON.parse(body);
      const stored = record.proposals.find(entry => entry.proposal_id === context.proposal.proposal_id);
      delete stored.binding.rules_snapshot_sha;
      await writeFile(path, JSON.stringify(record));
      patched = true;
    }
    assert.ok(patched, 'the stored proposal record was found and downgraded');

    const restored = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const reread = await restored.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id);
    assert.equal(reread.proposal.agent_review.verdict, AGENT_REVIEW.STALE);
    assert.ok(reread.proposal.agent_review.refusals.includes('CANONICAL_SNAPSHOT_UNKNOWN'));
    await refusesAcceptance(restored, context.fixture.projectId, context.proposal.proposal_id, 'CANONICAL_SNAPSHOT_UNKNOWN');
  });
});

test('a proposal is not stored bound to a run that moved while it was being prepared', async () => {
  // `propose` reads the run, builds the binding and runs the Agent Review
  // Policy all BEFORE it takes the project lock -- deliberately, because the
  // policy resolves citations through the Canonical engines and holding the
  // lock across a score decode would shut out every other writer.
  //
  // Nothing re-read the run once the lock was taken. So a resume committing in
  // that window left the proposal stored against a revision and a request that
  // had both moved, while the answer handed back said
  // REQUIRES_EXPLICIT_ACCEPTANCE -- born stale, and told otherwise. The very
  // next read of the same record said STALE.
  //
  // The interleave is deterministic rather than timed: the engine call the
  // citation resolution makes is wrapped, and it commits the resume from inside
  // that call, so the resume reaches the serializer first by construction.
  let app = null;
  let armed = false;
  let raced = null;
  let context = null;

  app = createStudioApplication({
    loadEngines: enginesWith(engines => ({
      arrangement: {
        ...engines.arrangement,
        baselineIdentityOf: project => {
          const identity = engines.arrangement.baselineIdentityOf(project);
          if (armed) {
            armed = false;
            raced = app.resumeRun(OWNER, context.fixture.projectId, context.run.run_id, {
              decisions: runDecisionsFor(context.fixture.project, { acceptedBy: RUN_REVIEWER }),
              accepted_by: RUN_REVIEWER,
            });
          }
          return identity;
        },
      },
    })),
  });

  const fixture = await projectWithSymbolicAsset(app, OWNER);
  const started = await app.startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId] });
  const targets = await app.proposalTargets(OWNER, fixture.projectId, started.run.run_id);
  const target = targets.targets.find(entry => entry.admissible_kinds.includes(PROPOSAL_KIND.ARRANGEMENT_DECISION));
  const events = await app.listBaselineEvents(OWNER, fixture.projectId, { limit: 3 });
  context = { fixture, run: started.run };

  armed = true;
  const submitted = await app.proposeDecision(OWNER, fixture.projectId, {
    run_id: started.run.run_id,
    request_key: target.request_key,
    kind: PROPOSAL_KIND.ARRANGEMENT_DECISION,
    proposed_by: AGENT,
    rationale: 'Keep every source-supported role.',
    action: { decisions: proposable(fixture.project) },
    cites: { event_ids: events.events.map(entry => entry.event_id) },
  }).then(result => ({ ok: true, result }), error => ({ ok: false, error }));
  await raced;
  assert.ok(raced, 'the interleave must actually have fired');

  // Refused, rather than stored bound to material that had already moved.
  assert.equal(submitted.ok, false, 'a submission whose run moved under it must not be stored');
  assert.equal(submitted.error.code, 'RUN_CONFLICT');
  assert.equal((await app.listProposals(OWNER, fixture.projectId)).proposals.length, 0, 'and nothing was stored');
});

// ─── D. the run is not a place a proposal may be applied ────────────────────

test('a completed run is audit-closed and accepts no proposal', async () => {
  const app = createStudioApplication({});
  const context = await proposedAgainstDecisions(app);

  // Drive the run to completion by the ordinary path, then try to apply the
  // proposal that was written before any of it.
  await app.resumeRun(OWNER, context.fixture.projectId, context.run.run_id, {
    decisions: runDecisionsFor(context.fixture.project, { acceptedBy: RUN_REVIEWER }),
  });
  const finished = await app.resumeRun(OWNER, context.fixture.projectId, context.run.run_id, { confirmations: FIXTURE_CONFIRMATIONS });
  assert.equal(finished.run.state, RUN_STATE.COMPLETED);

  const reread = await app.getProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id);
  assert.equal(reread.proposal.agent_review.verdict, AGENT_REVIEW.STALE);
  assert.ok(reread.proposal.agent_review.refusals.includes('RUN_AUDIT_CLOSED'), reread.proposal.agent_review.refusals.join(', '));
  await refusesAcceptance(app, context.fixture.projectId, context.proposal.proposal_id, 'RUN_AUDIT_CLOSED');

  // And the targets operation says so before an agent writes anything at all.
  const targets = await app.proposalTargets(OWNER, context.fixture.projectId, context.run.run_id);
  assert.equal(targets.accepts_proposals, false);
});

test('a stale proposal that is rejected or withdrawn is still recorded, because refusal is the point', async () => {
  const app = createStudioApplication({});
  const context = await proposedAgainstDecisions(app);
  await app.resumeRun(OWNER, context.fixture.projectId, context.run.run_id, {
    decisions: runDecisionsFor(context.fixture.project, { acceptedBy: RUN_REVIEWER }),
  });

  // Staleness blocks an ACCEPTANCE. It does not stop a reviewer from closing
  // the record: a proposal nobody can act on is exactly the one worth marking.
  const rejected = await app.resolveProposal(OWNER, context.fixture.projectId, context.proposal.proposal_id, {
    resolution: 'reject', reason: 'The run moved on before anybody looked at this.',
  });
  assert.equal(rejected.proposal.state, PROPOSAL_STATE.REJECTED);
  assert.equal(rejected.applied, false);
  assert.equal(rejected.proposal.agent_review.verdict, AGENT_REVIEW.STALE);
  assert.equal(rejected.proposal.agent_review_at_submission.verdict, AGENT_REVIEW.REQUIRES_EXPLICIT_ACCEPTANCE,
    'the verdict it was written under is kept as history beside the one recomputed now');
});

test('a proposal is never resolved by position, a timestamp, or the newest record', async () => {
  const app = createStudioApplication({});
  const fixture = await projectWithSymbolicAsset(app, OWNER);
  const started = await app.startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId] });
  const targets = await app.proposalTargets(OWNER, fixture.projectId, started.run.run_id);
  const target = targets.targets.find(entry => entry.admissible_kinds.includes(PROPOSAL_KIND.ARRANGEMENT_DECISION));
  const events = await app.listBaselineEvents(OWNER, fixture.projectId, { limit: 3 });

  // Three competing proposals against the SAME request, from three agents.
  const submitted = [];
  for (const agent of ['agent-a', 'agent-b', 'agent-c']) {
    submitted.push((await app.proposeDecision(OWNER, fixture.projectId, {
      run_id: started.run.run_id,
      request_key: target.request_key,
      kind: PROPOSAL_KIND.ARRANGEMENT_DECISION,
      proposed_by: agent,
      rationale: `Proposed by ${agent}: keep every source-supported role.`,
      action: { decisions: proposable(fixture.project) },
      cites: { event_ids: events.events.map(entry => entry.event_id) },
    })).proposal);
  }
  assert.equal(new Set(submitted.map(entry => entry.proposal_id)).size, 3, 'three distinct records');

  // Accepting the FIRST one applies the first one — not the newest, and the
  // other two are left exactly as they were rather than being closed by
  // implication.
  const accepted = await app.resolveProposal(OWNER, fixture.projectId, submitted[0].proposal_id, {
    resolution: 'accept', accepted_by: RUN_REVIEWER,
  });
  assert.equal(accepted.proposal.proposal_id, submitted[0].proposal_id);
  assert.equal(accepted.proposal.proposed_by, 'agent-a');

  const listed = (await app.listProposals(OWNER, fixture.projectId)).proposals;
  assert.equal(listed.find(entry => entry.proposal_id === submitted[0].proposal_id).state, PROPOSAL_STATE.APPLIED);
  for (const other of submitted.slice(1)) {
    const entry = listed.find(item => item.proposal_id === other.proposal_id);
    assert.equal(entry.state, PROPOSAL_STATE.SUBMITTED, 'an unrelated proposal is not closed by somebody else being accepted');
    // But it is now unapplicable, because the run it answered has moved.
    const verdict = (await app.getProposal(OWNER, fixture.projectId, other.proposal_id)).proposal.agent_review.verdict;
    assert.equal(verdict, AGENT_REVIEW.STALE);
  }
});
