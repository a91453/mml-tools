// Shared synthetic fixture for the release representation regressions.
//
// The shape is the one the real 《怪獸之歌》 third-party MIDI has — a role-less
// Source-Faithful Baseline whose every note-off is one 480-tpq tick before the
// 1/64 grid, Melody reached by Lead promotions — but everything here is
// synthetic and proves nothing about that song. Nothing here fabricates a gate:
// the release decision is a test input a submitter would state, not a default.
import assert from 'node:assert/strict';
import { F, f } from '../../backend/mml/index.mjs';
import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalTempoEvent,
  createCanonicalMeterEvent,
  createCanonicalProject,
} from '../../backend/canonical/index.mjs';

export const OWNER = 'owner:alice';
export const SOURCE_ID = 'fixture:third-party-midi';
export const TICK = new F(1, 480);
export const early = beat => f(beat).sub(TICK).toString();

const note = (id, pitch, start, end) => createCanonicalNoteEvent({
  id, pitch, start: String(start), end: String(end), sourceIds: [SOURCE_ID], sourceEventIds: [`${SOURCE_ID}#${id}`],
  role: null, voice: id.split('-')[0], volume: null, metadata: { ticksPerQuarter: 480 },
});

export function oneTickEarlyBaseline() {
  return createCanonicalProject({
    id: 'fixture:one-tick-early',
    title: 'One-tick-early releases (synthetic)',
    sources: [createSource({ id: SOURCE_ID, label: 'Synthetic third-party piano MIDI', kind: 'third-party-midi', authority: 'supporting', sha256: 'c'.repeat(64) })],
    events: [
      note('lead-1', 72, 0, early(1)),
      note('lead-2', 74, 1, early(2)),
      // A same-pitch repeated attack right after lead-2: must stay two attacks.
      note('lead-3', 74, 2, early(3)),
      // A role end one tick early.
      note('lead-4', 76, 3, early(4)),
      note('harm-1', 64, 0, early(2)),
      note('harm-2', 65, 2, early(4)),
      // A real rest follows bass-1: it must survive, shorter by exactly one tick.
      note('bass-1', 48, 0, early(1)),
      note('bass-2', 43, 2, early(4)),
    ],
    tempoEvents: [createCanonicalTempoEvent({ id: 'tempo-1', beat: '0', bpm: 150, sourceIds: [SOURCE_ID] })],
    meterEvents: [createCanonicalMeterEvent({ id: 'meter-1', beat: '0', numerator: 4, denominator: 4, sourceIds: [SOURCE_ID] })],
    metadata: {},
  });
}

export const promotionEvidence = eventId => ({
  sourceIdentity: { sourceId: SOURCE_ID, sourceEventId: `${SOURCE_ID}#${eventId}` },
  sectionRole: 'instrumental',
  scoreEvidence: { availability: 'available', classification: 'lead', citation: 'fixture:score top line' },
  audioEvidence: { availability: 'available', classification: 'foreground', citation: 'fixture:audio foreground' },
  continuity: { checked: true, createsLeadGap: false, replacementEventIds: [] },
  core3: { checked: true, status: 'PASS' },
  positiveReason: 'Fixture: the top line carries the tune in front of the mix.',
});

export const assign = (eventId, toRole, extra = {}) => ({
  id: `assign:${eventId}`, type: 'ASSIGN_ROLE', target: { eventIds: [eventId] }, toRole,
  reason: `Fixture: ${eventId} is ${toRole} material.`, evidence: [`${SOURCE_ID}#${eventId}`], acceptedBy: 'reviewer:fixture', ...extra,
});

export const roleDecisions = () => [
  ...['lead-1', 'lead-2', 'lead-3', 'lead-4'].map(id => assign(id, 'Melody', { leadEvidence: promotionEvidence(id) })),
  ...['harm-1', 'harm-2'].map(id => assign(id, 'Chord1')),
  ...['bass-1', 'bass-2'].map(id => assign(id, 'Chord2')),
];

export async function candidateWithAudio(service, title = 'Release representation') {
  const baseline = oneTickEarlyBaseline();
  const created = (await service.createProject(OWNER, { title })).project;
  await service.uploadAsset(OWNER, created.project_id, { kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(baseline)) });
  const audio = (await service.uploadAsset(OWNER, created.project_id, { kind: 'original_audio', filename: 'song.m4a', mediaType: 'audio/mp4', bytes: new TextEncoder().encode('synthetic audio bytes') })).asset;
  await service.analyzeSources(OWNER, created.project_id);
  const applied = await service.applyDecisions(OWNER, created.project_id, { decisions: roleDecisions() });
  assert.equal(applied.decisions.applied, true);
  return { baseline, projectId: created.project_id, candidateId: applied.decisions.candidate_id, audioAssetId: audio.asset_id };
}

// Who submits a decision is provenance: the fixture defaults to a conversational
// AI so every path below proves that an AI-submitted, source-backed decision is
// graded like anyone else's. `basis` is how the finding was derived.
export const AGENT_SUBMITTER = Object.freeze({ reviewer: 'agent:assistant', reviewer_kind: 'agent' });
export const HUMAN_SUBMITTER = Object.freeze({ reviewer: 'user:listener', reviewer_kind: 'human' });
export const audioReviewDecision = (audioAssetId, eventIds, { id = 'rr:legato', submitter = AGENT_SUBMITTER, basis = 'direct-source-review' } = {}) => ({
  id, eventIds, representation: 'EXTEND_TO_NEXT_GRID',
  reason: 'The recording sustains through each of these boundaries; the one-tick gap has no counterpart in it.',
  attestation: { ...submitter },
  evidence: [{ class: 'primary-audio', ref: audioAssetId, basis, locator: '0:00-0:02 (bars 1-2)', finding: 'Legato; no separation before any following attack in this window.' }],
});

export const ALL_RELEASE_EVENTS = Object.freeze(['lead-1', 'lead-2', 'lead-3', 'lead-4', 'harm-1', 'harm-2', 'bass-1', 'bass-2']);
