// Shared fixtures for the Studio Application Interface regressions.
//
// Nothing here fabricates a gate. The Canonical project below declares roles,
// because a source whose roles are already accepted is what makes a KEEP-only
// decision set expressible — and a KEEP-only set is the smallest complete run
// through intake, suggestion, acceptance, review and Final emission. Source
// completeness, version-drift review, player readback and audio evidence are
// deliberately absent: a test that wants one states it.

import { createCanonicalProject, createCanonicalMeterEvent, createCanonicalNoteEvent, createCanonicalTempoEvent, createSource } from '../../backend/canonical/index.mjs';

export const FIXTURE_SOURCE_ID = 'fixture:official-midi';
export const FIXTURE_SHA256 = 'a'.repeat(64);
export const SIX_ROLE_NAMES = Object.freeze(['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5']);

const note = (id, pitch, start, end, role) => createCanonicalNoteEvent({
  id,
  pitch,
  start,
  end,
  sourceIds: [FIXTURE_SOURCE_ID],
  sourceEventIds: [`${FIXTURE_SOURCE_ID}#${id}`],
  role,
  voice: role.toLowerCase(),
  volume: null,
  metadata: {},
});

/**
 * A two-bar, six-role Canonical project whose roles are already accepted.
 *
 * Every duration is on the safe grid and every role is non-empty, so the Final
 * emitter has something to serialize in all six slots and micro-gap enforcement
 * has no technical residue to reject.
 */
export function sixRoleBaseline({ id = 'fixture:application-baseline', title = 'Application fixture' } = {}) {
  const pitches = { Melody: 72, Chord1: 67, Chord2: 64, Chord3: 60, Chord4: 55, Chord5: 48 };
  const events = SIX_ROLE_NAMES.flatMap(role => [
    note(`${role.toLowerCase()}-1`, pitches[role], '0', '1', role),
    note(`${role.toLowerCase()}-2`, pitches[role], '1', '2', role),
    note(`${role.toLowerCase()}-3`, pitches[role], '2', '4', role),
  ]);

  return createCanonicalProject({
    id,
    title,
    sources: [createSource({
      id: FIXTURE_SOURCE_ID,
      label: 'Fixture official MIDI',
      kind: 'official-midi',
      authority: 'primary-symbolic',
      sha256: FIXTURE_SHA256,
      metadata: { format: 'fixture' },
    })],
    events,
    tempoEvents: [createCanonicalTempoEvent({
      id: 'tempo-1',
      beat: '0',
      bpm: 120,
      sourceIds: [FIXTURE_SOURCE_ID],
      sourceEventIds: [`${FIXTURE_SOURCE_ID}#tempo-1`],
    })],
    meterEvents: [createCanonicalMeterEvent({
      id: 'meter-1',
      beat: '0',
      numerator: 4,
      denominator: 4,
      sourceIds: [FIXTURE_SOURCE_ID],
      sourceEventIds: [`${FIXTURE_SOURCE_ID}#meter-1`],
    })],
    metadata: {},
  });
}

export const canonicalProjectBytes = (project = sixRoleBaseline()) =>
  new TextEncoder().encode(JSON.stringify(project));

/**
 * A KEEP decision per role lane, with a stated reason and evidence.
 *
 * KEEP changes no role, so it needs no Lead promotion or demotion evidence: it
 * records that the reviewer looked at material whose role the source already
 * declares and accepted it unchanged.
 */
export function keepEveryRole(project = sixRoleBaseline(), { acceptedBy = 'fixture-reviewer' } = {}) {
  return SIX_ROLE_NAMES.map(role => ({
    id: `keep:${role}`,
    type: 'KEEP',
    target: { eventIds: project.events.filter(event => event.role === role).map(event => event.id) },
    fromRole: role,
    reason: `The official source declares this material as ${role}; it is accepted unchanged.`,
    evidence: [`${FIXTURE_SOURCE_ID}#${role}`],
    acceptedBy,
  }));
}

/** A minimal, schema-valid audio alignment report for one candidate. */
export function audioAlignmentReport(candidateProject, { sha256 = 'b'.repeat(64), confidence = 0.9 } = {}) {
  return {
    schema: 'mabinogi-mobile-mml-studio/audio-alignment@1',
    audio: { sha256, filename: 'fixture.m4a' },
    symbolic: { project_id: candidateProject.id },
    evidence_policy: { changes_symbolic_truth: false },
    alignment: {
      control_points: [{ beat: 0, seconds: 0 }, { beat: 4, seconds: 2 }],
      metrics: { confidence, score_frame_coverage: 0.99, audio_frame_coverage: 0.95 },
      tempo_drift: {},
    },
  };
}

/** Walk a fresh project from upload through an applied candidate. */
export async function applyKeepOnlyCandidate(app, owner, { title = 'Fixture project' } = {}) {
  const project = sixRoleBaseline();
  const created = (await app.createProject(owner, { title })).project;
  await app.uploadAsset(owner, created.project_id, {
    kind: 'canonical_project',
    filename: 'baseline.json',
    mediaType: 'application/json',
    bytes: canonicalProjectBytes(project),
  });
  const intake = await app.analyzeSources(owner, created.project_id);
  const applied = await app.applyDecisions(owner, created.project_id, { decisions: keepEveryRole(project) });
  return { project, created, intake, applied, projectId: created.project_id, candidateId: applied.decisions.candidate_id };
}
