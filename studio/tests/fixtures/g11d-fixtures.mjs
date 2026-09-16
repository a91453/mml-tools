// Shared fixtures for the G11-D accepted-decision application regressions.
//
// Two baselines, deliberately different in kind:
//
//   * `roleDeclaredBaseline()` -- a hand-built Canonical project whose events
//     already carry accepted roles. Lead demotion, Core3 continuity and role
//     moves are only expressible against a baseline that declares roles, so the
//     gate regressions use this one.
//   * the raw-SMF pipeline fixture in `g11d-pipeline.test.mjs` -- roles are
//     null, exactly as G11-A leaves them, so the end-to-end run has to reach
//     every role through explicit accepted decisions.
//
// Nothing here fabricates acceptance. `acceptanceFor()` only computes the
// bindings a reviewer's decision must carry; a test that wants an accepted
// decision has to state the type, target, roles, reason and evidence itself.

import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalTempoEvent,
  createCanonicalMeterEvent,
  createCanonicalProject,
} from '../../backend/canonical/index.mjs';
import { baselineIdentityOf, laneDecompositionDigestOf } from '../../backend/arrangement/decision-application.mjs';
import { EFFECTIVE_RULESET } from '../../backend/rules/index.mjs';

export const CANONICAL_IDENTITY = EFFECTIVE_RULESET.canonical;

export const SOURCE_ID = 'fixture:symbolic';
export const SECOND_SOURCE_ID = 'fixture:third-party';

const note = (id, pitch, start, end, { role = null, voice = null, sourceId = SOURCE_ID, volume = null } = {}) =>
  createCanonicalNoteEvent({
    id,
    pitch,
    start,
    end,
    sourceIds: [sourceId],
    sourceEventIds: [`${sourceId}#${id}`],
    role,
    voice,
    volume,
    metadata: {},
  });

/**
 * A four-bar, four-voice Canonical project whose roles are already accepted.
 *
 * `withRoles: false` returns the identical events with every role null, which
 * is what an unassigned baseline looks like; the two share event ids so a test
 * can compare the same material with and without declared roles.
 */
export function roleDeclaredBaseline({ withRoles = true, id = 'fixture:baseline', extraSource = false, multiProvenance = false } = {}) {
  const role = value => (withRoles ? value : null);
  const events = [
    note('lead-1', 72, '0', '1', { role: role('Melody'), voice: 'lead' }),
    note('lead-2', 74, '1', '2', { role: role('Melody'), voice: 'lead' }),
    note('lead-3', 76, '2', '3', { role: role('Melody'), voice: 'lead' }),
    note('lead-4', 77, '3', '4', { role: role('Melody'), voice: 'lead' }),

    note('harm-1', 64, '0', '2', { role: role('Chord1'), voice: 'harmony' }),
    note('harm-2', 65, '2', '4', { role: role('Chord1'), voice: 'harmony' }),

    note('bass-1', 48, '0', '2', { role: role('Chord2'), voice: 'bass' }),
    note('bass-2', 43, '2', '4', { role: role('Chord2'), voice: 'bass' }),

    note('tex-1', 60, '0', '1', { voice: 'texture' }),
    note('tex-2', 62, '1', '2', { voice: 'texture' }),
  ];
  if (extraSource) {
    events.push(note('alt-1', 64, '0', '2', { voice: 'alt', sourceId: SECOND_SOURCE_ID }));
  }
  // An event two sources both attest. Identity binding is membership, not
  // equality, so a citation naming either source and either source event must
  // still bind -- and a citation naming neither must not.
  if (multiProvenance) {
    events.push(createCanonicalNoteEvent({
      id: 'multi-1',
      pitch: 67,
      start: '0',
      end: '1',
      sourceIds: [SOURCE_ID, SECOND_SOURCE_ID],
      sourceEventIds: [`${SOURCE_ID}#multi-1`, `${SECOND_SOURCE_ID}#multi-1`],
      role: role('Chord3'),
      voice: 'multi',
      metadata: {},
    }));
  }
  const sources = [
    createSource({ id: SOURCE_ID, label: 'Fixture official score', kind: 'official-musicxml', authority: 'primary-symbolic' }),
    ...(extraSource || multiProvenance ? [createSource({ id: SECOND_SOURCE_ID, label: 'Fixture third-party MIDI', kind: 'third-party-midi', authority: 'supporting' })] : []),
  ];
  return createCanonicalProject({
    id,
    title: 'G11-D fixture',
    sources,
    events,
    tempoEvents: [createCanonicalTempoEvent({ id: 'tempo-1', beat: '0', bpm: 120, sourceIds: [SOURCE_ID] })],
    meterEvents: [createCanonicalMeterEvent({ id: 'meter-1', beat: '0', numerator: 4, denominator: 4, sourceIds: [SOURCE_ID] })],
    metadata: {},
  });
}

/**
 * The bindings a reviewer's accepted decision must carry to be applied against
 * this exact baseline / revision / lane decomposition / Canonical release.
 *
 * This is not an acceptance factory: it computes identities that already exist.
 * Everything that makes a decision a decision -- the type, the target, the
 * destination role, the reason, the evidence -- is supplied by the caller.
 */
export function acceptanceFor(baseline, {
  acceptedBy = 'fixture-reviewer',
  reviewedRevisionId = null,
  suggestion = null,
  canonicalIdentity = CANONICAL_IDENTITY,
} = {}) {
  const identity = baselineIdentityOf(baseline);
  return {
    state: 'ACCEPTED',
    acceptedBy,
    reviewedRevisionId,
    baselineContentDigest: identity.contentDigest,
    sourceIdentityDigest: identity.sourceIdentityDigest,
    laneDecompositionDigest: laneDecompositionDigestOf(suggestion),
    canonicalRulesSnapshotSha: canonicalIdentity.rules_snapshot_sha,
  };
}

// A complete Lead Demotion Gate evidence chain. Tests that want the gate to
// pass state it explicitly; tests that want it to fail closed omit or weaken it.
export function leadDemotionEvidence({
  sectionRole = 'instrumental',
  scoreClassification = 'inner',
  audioClassification = 'background',
  createsLeadGap = false,
  core3Status = 'PASS',
  sourceEventId = `${SOURCE_ID}#lead-1`,
} = {}) {
  return {
    sourceIdentity: { sourceId: SOURCE_ID, sourceEventId },
    sectionRole,
    scoreEvidence: { availability: 'available', classification: scoreClassification, citation: 'fixture:score bar 1, inner staff' },
    audioEvidence: { availability: 'available', classification: audioClassification, citation: 'fixture:audio 0:00-0:02 background' },
    continuity: { checked: true, createsLeadGap, replacementEventIds: [] },
    core3: { checked: true, status: core3Status },
    positiveReason: 'Fixture: the score places this material on the inner staff and the mix keeps it behind the lead.',
  };
}

export function leadPromotionEvidence({
  sectionRole = 'instrumental',
  scoreClassification = 'lead',
  audioClassification = 'foreground',
  sourceEventId = `${SOURCE_ID}#tex-1`,
} = {}) {
  return {
    sourceIdentity: { sourceId: SOURCE_ID, sourceEventId },
    sectionRole,
    scoreEvidence: { availability: 'available', classification: scoreClassification, citation: 'fixture:score bar 1, top staff' },
    audioEvidence: { availability: 'available', classification: audioClassification, citation: 'fixture:audio 0:00-0:01 foreground' },
  };
}

// Deterministically shuffles an array with a fixed permutation, so an
// order-independence assertion is reproducible rather than flaky.
export function rotate(items, by) {
  const list = [...items];
  const offset = ((by % list.length) + list.length) % list.length;
  return [...list.slice(offset), ...list.slice(0, offset)];
}

// Rebuilds an object with its keys in reverse order. Two structurally equal
// inputs must produce one result whatever order their keys were written in.
export function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).reverse()) out[key] = reverseKeys(value[key]);
  return out;
}
