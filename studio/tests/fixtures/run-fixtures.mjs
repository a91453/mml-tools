// Shared fixtures for the One-Click Orchestrator regressions.
//
// Nothing here fabricates a gate, and nothing here is a production default.
//
// `FIXTURE_CONFIRMATIONS` below is the set of statements a *reviewer* would
// make about this synthetic fixture: the fixture is the whole material, no
// preview or verification assets exist for it, and the Gate 4 / 8 / 9 reviews
// were performed. They are test inputs and they are stated here once so every
// run regression states them identically. They are NOT an automatic
// confirmation policy, they are not copied into the run service, and the run
// service has no default of its own: a run given no confirmations leaves
// `player_readback` at `NOT_RUN`, leaves `original_audio_required` true, and
// blocks — which `application-run-blocking.test.mjs` asserts directly.

import { createCanonicalNoteEvent, createCanonicalProject } from '../../backend/canonical/index.mjs';
import { canonicalProjectBytes, keepEveryRole, sixRoleBaseline } from './application-fixtures.mjs';

export const RUN_REVIEWER = 'fixture-run-reviewer';

/**
 * A reviewer's answers for the synthetic fixture.
 *
 * Every `true` carries the reason the service requires, and the three
 * candidate-bound gate reviews carry the evidence reference the service
 * requires on top of it. `player_readback: N/A` and
 * `original_audio_required: false` are explicit fixture declarations with
 * stated reasons — this fixture has no recording and no player — and the run
 * service will never write either of them on its own.
 */
export const FIXTURE_CONFIRMATIONS = Object.freeze({
  source_complete: { value: true, reason: 'The fixture project is the complete material for this synthetic cue.' },
  version_drift_reviewed: { value: true, reason: 'The role decisions this candidate carries are the ones the fixture reviewer accepted.' },
  player_readback: { value: 'N/A', reason: 'No preview or verification assets are used for this synthetic cue, so no player readback exists to report.' },
  core3_completeness_reviewed: { value: true, reason: 'Core3 stands up as a one-player arrangement without Chord3-Chord5 for this fixture.', evidence: ['fixture:gate-4/core3-completeness'] },
  mobile_adaptation_reviewed: { value: true, reason: 'The candidate was reviewed against Acceptance Gate 8 for this fixture.', evidence: ['fixture:gate-8/mobile-adaptation'] },
  regression_reviewed: { value: true, reason: 'The candidate was compared against the Source-Faithful Baseline for this fixture.', evidence: ['fixture:gate-9/regression'] },
  original_audio_required: { value: false, reason: 'The fixture workflow has no official recording, so original-audio evidence is not applicable to it.' },
});

/** A project holding one Canonical IR asset, with nothing analyzed yet. */
export async function projectWithSymbolicAsset(app, owner, { project = sixRoleBaseline(), title = 'Run fixture' } = {}) {
  const created = (await app.createProject(owner, { title })).project;
  const asset = (await app.uploadAsset(owner, created.project_id, {
    kind: 'canonical_project',
    filename: 'baseline.json',
    mediaType: 'application/json',
    bytes: canonicalProjectBytes(project),
  })).asset;
  return { project, projectId: created.project_id, assetId: asset.asset_id };
}

/** The accepted arrangement decision set for a fixture, as run input. */
export const runDecisionsFor = (project, { acceptedBy = RUN_REVIEWER, exclude = [] } = {}) =>
  keepEveryRole(project, { acceptedBy }).filter(decision => !exclude.includes(decision.fromRole));

/** A cited Mobile target profile. Synthetic, and labelled as such. */
export const mobileProfile = (roles, { id = 'fixture-run-target' } = {}) => ({
  schema: 'mml-studio/mobile-adaptation-profile@1',
  id,
  reason: 'Synthetic target register for the fixture candidate; not an instrument recommendation and not calibration evidence.',
  evidence: ['fixture:target-client/register'],
  roles,
});

/**
 * The six-role fixture with an explicit volume on every note.
 *
 * A relative `volumeDelta` needs something to be relative to, so a regression
 * about not stacking an offset needs a baseline that states its volumes rather
 * than leaving them unset.
 */
export const sixRoleBaselineWithVolumes = (volume = 10) => {
  const source = sixRoleBaseline();
  return createCanonicalProject({
    ...source,
    events: source.events.map(event => (event.kind === 'note' ? createCanonicalNoteEvent({ ...event, volume }) : event)),
  });
};

export { canonicalProjectBytes, keepEveryRole, sixRoleBaseline };
