// Shared fixtures for the G12 Final Six-Role Reduction regressions.
//
// Nothing here fabricates a gate. Each fixture states exactly the condition the
// test needs -- unassigned material, a full six roles, a Lead move, leaked drum
// material -- and nothing else.

import { createCanonicalProject, createCanonicalNoteEvent } from '../../backend/canonical/index.mjs';
import { sixRoleBaseline, FIXTURE_SOURCE_ID } from './application-fixtures.mjs';

export { FIXTURE_SOURCE_ID };

const rebuild = (project, mapper) => createCanonicalProject({ ...project, events: project.events.map(mapper) });

/** The six-role fixture with one role's material carrying no role at all. */
export function baselineWithUnassignedRole(role = 'Chord5') {
  return rebuild(sixRoleBaseline(), event =>
    event.role === role ? createCanonicalNoteEvent({ ...event, role: null, voice: null }) : event);
}

/**
 * Six occupied roles plus a seventh lane with no role: material that cannot be
 * placed without displacing something already delivered.
 */
export function baselineWithOverflowLane() {
  const source = sixRoleBaseline();
  const extra = [0, 1, 2].map(index => createCanonicalNoteEvent({
    id: `overflow-${index + 1}`,
    pitch: [53, 55, 57][index],
    start: String(index),
    end: String(index + 1),
    sourceIds: [FIXTURE_SOURCE_ID],
    sourceEventIds: [`${FIXTURE_SOURCE_ID}#overflow-${index + 1}`],
    role: null,
    voice: null,
    volume: null,
  }));
  return createCanonicalProject({ ...source, events: [...source.events, ...extra] });
}

/** A baseline carrying General MIDI drum material on channel 9, with no role. */
export function baselineWithPercussion({ role = null } = {}) {
  const source = sixRoleBaseline();
  const drums = [0, 1].map(index => createCanonicalNoteEvent({
    id: `drum-${index + 1}`,
    pitch: [36, 38][index],
    start: String(index),
    end: String(index + 1),
    sourceIds: [FIXTURE_SOURCE_ID],
    sourceEventIds: [`${FIXTURE_SOURCE_ID}#drum-${index + 1}`],
    role,
    voice: null,
    volume: null,
    metadata: { channel: 9 },
  }));
  return createCanonicalProject({ ...source, events: [...source.events, ...drums] });
}

/** Melody removed entirely: a Core3 with no Lead, whatever Chord3-Chord5 hold. */
export function baselineWithoutLead() {
  const source = sixRoleBaseline();
  return createCanonicalProject({ ...source, events: source.events.filter(event => event.role !== 'Melody') });
}

/** A complete Lead evidence record for one baseline event. */
export const leadEvidenceFor = (event, { sectionRole = 'instrumental', classification = 'accompaniment', audio = 'background', core3 = 'PASS' } = {}) => ({
  sourceIdentity: { sourceId: event.sourceIds[0], sourceEventId: event.sourceEventIds[0] },
  sectionRole,
  scoreEvidence: { availability: 'available', classification, citation: `${FIXTURE_SOURCE_ID}#score/${event.id}` },
  audioEvidence: { availability: 'available', classification: audio, citation: `${FIXTURE_SOURCE_ID}#audio/${event.id}` },
  continuity: { checked: true, createsLeadGap: false, replacementEventIds: [] },
  core3: { checked: true, status: core3 },
  positiveReason: `The source classifies ${event.id} as ${classification} in this window.`,
});

/** One reduction decision, with the shape the stage expects. */
export const reductionDecision = (input) => ({
  reason: 'Fixture reduction decision with a stated positive reason.',
  evidence: [`${FIXTURE_SOURCE_ID}#reduction`],
  ...input,
});
