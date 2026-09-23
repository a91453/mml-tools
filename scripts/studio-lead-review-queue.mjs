// Deterministic Lead evidence audit and review queue for one candidate.
// Implementation notes, not Canonical policy.
//
// Inputs are service READ exports only (no network, no service write):
//   * `studio_baseline_events` pages and the applied arrangement_decision
//     proposal -- the candidate is rebuilt through the unchanged pipeline
//     (scripts/studio-microtiming-audit.mjs `reconstructFromExports`);
//   * optionally the candidate review's `review.lead_evidence_reviews` value.
//
// Output separates, per Melody (Lead) event, the evidence CLASSES that
// SOURCE_POLICY §2 requires to stay separate -- symbolic structure, score
// citation, audio citation and its basis, reviewer authority -- and never
// collapses them into one confidence score. It writes no decision, no review,
// no confirmation and no gate result, and it does not decide any Lead event.
//
// Committed outputs carry identities, positions and classifications only: no
// pitch sequence and no durations, so the queue cannot serve as a transcription
// of the source. A reviewer resolves pitches through `studio_baseline_events`.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { f } from '../studio/backend/mml/index.mjs';
import { splitProjectSourceVoices } from '../studio/backend/arrangement/voice-split.mjs';
import { reconstructFromExports } from './studio-microtiming-audit.mjs';
import { leadReviewAuthorityOf, LEAD_REVIEW_AUTHORITY } from '../studio/backend/application/lead-review-authority.mjs';

const HELP = `Lead evidence audit + review queue (no network, no service write)
  node scripts/studio-lead-review-queue.mjs --work-dir NEW_DIR --events p1.json[,p2.json...] --decisions proposal.json
       [--reviews lead_evidence_reviews.json] [--public] [--out queue.json]
--public   committable form: no raw citation text, shortened event ids.
`;

export const CLASSIFICATION = Object.freeze({
  SOURCE_SUPPORTED: 'sufficiently-source-supported',
  WEAK_MACHINE: 'weak-machine-evidence',
  F0_PITCH_CLASS_ONLY: 'f0-or-pitch-class-only',
  AUDIO_LOCATOR_ONLY: 'audio-locator-only',
  // A stored review states a direct review of the recording, by whoever made
  // it. Whether it proves the role is the grader's question: its citations
  // must still resolve to an official score or the recording the project holds.
  DIRECT_REVIEW_ON_RECORD: 'direct-review-on-record',
  MISSING: 'unresolved-missing-evidence',
  CONTRADICTORY: 'contradictory-evidence',
});

export const ALLOWED_DISPOSITIONS = Object.freeze([
  'KEEP_LEAD (positive Lead evidence: a direct review of the original recording or an official score, cited by project reference)',
  'DEMOTE_WITH_POSITIVE_EVIDENCE (names the destination role and the positive evidence; "not proven Vocal" is not evidence)',
  'MOVE (to another role, with the same positive-evidence requirement)',
  'PENDING (conflicting or incomplete evidence: the Source-Faithful Lead event stays in Melody)',
]);

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const shortId = id => id.split(':').slice(-2).join(':');

// Audio citation basis, read from the citation text. A diagnostic reading of a
// free-text record, reported as such -- not a verdict about the recording.
export function audioCitationKind(citation) {
  const text = String(citation ?? '');
  if (!text.trim()) return 'none';
  if (/\bpyin\b|\bf0\b|fundamental/i.test(text)) return 'f0';
  // Before pitch-class: the CQT citations also say "at candidate MIDI n pitch class".
  if (/\bcqt\b|salience|chroma|spectral/i.test(text)) return 'cqt-salience';
  if (/predominant[- ]pitch|pitch[- ]class/i.test(text)) return 'predominant-pitch-class';
  if (/alignment|dtw|onset|beat|window|\b\d+(\.\d+)?\s*s\b/i.test(text)) return 'locator';
  return 'unspecified';
}

// Every pitch a citation says it MEASURED ("approx MIDI 61.9", "approximately
// MIDI 45.1", "pYIN approx MIDI 50.1"). The candidate's own pitch, which the
// same citations also quote ("candidate MIDI 74"), is deliberately not matched.
export function citedMidiPitches(citation) {
  return [...String(citation ?? '').matchAll(/approx(?:imately)?\s+MIDI\s*(\d{1,3}(?:\.\d+)?)/gi)].map(match => Number(match[1]));
}

// A measured pitch two or more octaves from the event cannot be the same line;
// one octave is ordinary voice-versus-piano displacement and proves only the
// pitch class. Neither proves role (SOURCE_POLICY §6).
export const CONTRADICTION_SEMITONES = 23.5;

export function classifyLeadDecision({ event, review }) {
  if (!review) {
    return { classification: CLASSIFICATION.MISSING, flags: ['no-stored-review'], authority: null };
  }
  const authority = leadReviewAuthorityOf({ attestation: review.attestation ?? null });
  const lead = review.leadEvidence ?? review.lead_evidence ?? {};
  const score = lead.scoreEvidence ?? {};
  const audio = lead.audioEvidence ?? {};
  const flags = [];
  const audioKind = audio.availability === 'unavailable' ? 'none' : audioCitationKind(audio.citation);
  flags.push(`audio:${audioKind}`);
  const scoreAvailable = score.availability === 'available' && score.classification && score.classification !== 'unknown';
  flags.push(scoreAvailable ? `score:${score.classification}` : 'score:none');
  if (lead.core3?.status === 'PASS') flags.push('core3-PASS-self-asserted-in-record-not-a-gate-result');
  if (lead.sectionRole) flags.push(`section-role-claim:${lead.sectionRole}`);
  flags.push(`authority:${authority}`);

  const cited = citedMidiPitches(audio.citation);
  const registerMismatch = cited.some(value => Math.abs(value - event.pitch) >= CONTRADICTION_SEMITONES);
  if (cited.length) {
    flags.push(registerMismatch
      ? 'measured-pitch-two-or-more-octaves-from-event (bass/low-register content, not this line)'
      : 'measured-pitch-matches-pitch-class-only');
  }
  const scoreConflicts = scoreAvailable && ['accompaniment', 'inner', 'counter', 'duplicate'].includes(score.classification)
    && audio.classification === 'foreground';

  let classification;
  if (authority === LEAD_REVIEW_AUTHORITY.GRADED_ON_EVIDENCE && review.attestation?.audio_basis === 'listening') classification = CLASSIFICATION.DIRECT_REVIEW_ON_RECORD;
  else if (registerMismatch || scoreConflicts) classification = CLASSIFICATION.CONTRADICTORY;
  else if (audioKind === 'f0' || audioKind === 'predominant-pitch-class') classification = CLASSIFICATION.F0_PITCH_CLASS_ONLY;
  else if (audioKind === 'cqt-salience' || audioKind === 'unspecified') classification = CLASSIFICATION.WEAK_MACHINE;
  else if (audioKind === 'locator') classification = CLASSIFICATION.AUDIO_LOCATOR_ONLY;
  else classification = CLASSIFICATION.MISSING;
  // "Sufficiently source-supported" needs a primary symbolic source bound to the
  // event (SOURCE_POLICY §1 A). It is never inferred from a free-text citation.
  return { classification, flags, authority };
}

// Committable form: no raw citation text (it quotes event pitches), and event ids
// shortened to their source-local suffix with the common prefix stated once.
export function publicLeadReviewQueue(queue) {
  const prefixes = [...new Set(queue.items.map(item => item.eventId.slice(0, item.eventId.lastIndexOf(':note:') + 1)))];
  const strip = id => { for (const prefix of prefixes) if (id.startsWith(prefix)) return id.slice(prefix.length); return id; };
  return {
    ...queue,
    notice: `${queue.notice} Public form: raw review citation text is omitted (it quotes event pitches); event ids are given as their suffix after eventIdPrefix. Run the script on the service exports for the full form.`,
    eventIdPrefix: prefixes.length === 1 ? prefixes[0] : prefixes,
    sections: queue.sections.map(section => ({ ...section, reason: queue.items.find(item => item.assignedBy?.decision === section.decision)?.assignedBy?.reason ?? null, eventIds: section.eventIds.map(strip) })),
    // Repeated per-item text is stated once: the reason per class is in
    // `whyAutomaticDecisionIsInsufficient`, the symbolic note and each
    // decision's reason in `sections`.
    symbolicNote: queue.items[0]?.symbolic.note ?? null,
    windows: queue.windows.map(({ reason: _reason, ...window }) => ({ ...window, eventIds: window.eventIds.map(strip) })),
    items: queue.items.map(({ storedReview, symbolic, assignedBy, ...item }) => ({
      ...item,
      eventId: strip(item.eventId),
      assignedBy: assignedBy?.decision ?? null,
      topSoundingPitchAtOnset: symbolic.topSoundingPitchAtOnset,
      storedReview: storedReview ? (({ audioCitation, scoreCitation, ...rest }) => rest)(storedReview) : null,
    })),
  };
}

export async function buildLeadReviewQueue({ workDir, eventPaths, decisionsPath, reviewsPath = null }) {
  const { app, owner, projectId, candidateId, candidate, proposal } = await reconstructFromExports({ workDir, eventPaths, decisionsPath });
  const review = (await app.reviewCandidate(owner, projectId, { candidateId })).review;
  const promotion = review.lead_promotion;
  const byId = new Map(candidate.events.map(event => [event.id, event]));
  const reviewsText = reviewsPath ? readFileSync(reviewsPath, 'utf8') : null;
  const stored = reviewsText ? JSON.parse(reviewsText) : [];
  // Later entries supersede earlier ones for the same event and axis.
  const latest = new Map();
  for (const entry of stored) if (entry.axis === 'promotion') latest.set(entry.eventId ?? entry.event_id, entry);

  // Which accepted decision put each event in Melody, and its section.
  const decisions = proposal.action.decisions;
  const melodyDecisions = decisions.map((decision, index) => ({ ...decision, index })).filter(decision => decision.toRole === 'Melody');
  // Lane membership exactly as the suggestion derived it: the source-voice split
  // of the role-less Source-Faithful Baseline (lane id `lane:<voice>#<index>`).
  const laneOf = new Map();
  const roleless = { ...candidate, events: candidate.events.map(event => ({ ...event, role: null })) };
  for (const decomposition of splitProjectSourceVoices(roleless)) {
    const voiceKey = decomposition.sourceVoice ?? 'voice:null';
    for (const lane of decomposition.lanes) for (const note of lane.notes) laneOf.set(note.eventId, `lane:${voiceKey}#${lane.index}`);
  }
  const decisionFor = event => melodyDecisions.find(decision => decision.target?.laneId === laneOf.get(event.id)
    && f(event.start).cmp(decision.section.start) >= 0 && f(event.start).cmp(decision.section.end) < 0);

  // Symbolic structure only: is the event the highest pitch sounding at its onset?
  const all = candidate.events.filter(event => event.kind === 'note');
  const topAtOnset = event => all.every(other => other.id === event.id || !(f(other.start).cmp(event.start) <= 0 && f(other.end).cmp(event.start) > 0) || other.pitch <= event.pitch);

  const items = promotion.map(report => {
    const event = byId.get(report.eventId);
    const stored = latest.get(report.eventId) ?? null;
    const classified = classifyLeadDecision({ event, review: stored });
    const decision = decisionFor(event);
    return {
      eventId: event.id,
      sourceEventIds: [...event.sourceEventIds],
      voice: event.voice,
      laneId: laneOf.get(event.id) ?? null,
      onsetBeat: event.start,
      currentRole: event.role,
      proposedRole: null,
      assignedBy: decision ? { decision: `decisions[${decision.index}]`, section: decision.section, reason: decision.reason } : null,
      gradedStatus: report.status,
      gradedBlockers: [...report.blockers],
      symbolic: { topSoundingPitchAtOnset: topAtOnset(event), note: 'structural observation from a third-party MIDI; "highest note" is not Lead evidence (MASTER_RULES §4)' },
      storedReview: stored ? {
        at: stored.at ?? null,
        authority: classified.authority,
        audioCitationKind: audioCitationKind(stored.leadEvidence?.audioEvidence?.citation),
        measuredMinusEventSemitones: citedMidiPitches(stored.leadEvidence?.audioEvidence?.citation).map(value => Math.round((value - event.pitch) * 10) / 10),
        scoreCitationAvailable: stored.leadEvidence?.scoreEvidence?.availability === 'available',
        audioCitation: stored.leadEvidence?.audioEvidence?.citation ?? null,
        scoreCitation: stored.leadEvidence?.scoreEvidence?.citation ?? null,
      } : null,
      classification: classified.classification,
      flags: classified.flags,
    };
  });

  // Windows: consecutive items assigned by the same decision section and sharing
  // one classification. Every event id stays listed inside its window.
  const windows = [];
  for (const item of items.sort((a, b) => f(a.onsetBeat).cmp(b.onsetBeat) || (a.eventId < b.eventId ? -1 : 1))) {
    const key = `${item.assignedBy?.decision ?? 'none'}|${item.classification}`;
    const last = windows.at(-1);
    if (last && last.key === key) { last.eventIds.push(item.eventId); last.endOnsetBeat = item.onsetBeat; continue; }
    windows.push({ key, decision: item.assignedBy?.decision ?? null, section: item.assignedBy?.section ?? null, classification: item.classification, startOnsetBeat: item.onsetBeat, endOnsetBeat: item.onsetBeat, eventIds: [item.eventId] });
  }

  const count = (list, key) => list.reduce((acc, item) => { acc[item[key]] = (acc[item[key]] ?? 0) + 1; return acc; }, {});

  // The reader-facing entry point: one row per accepted Melody decision section,
  // with every event id still listed and the class mix shown, never averaged.
  const sections = [];
  for (const item of items) {
    const key = item.assignedBy?.decision ?? 'none';
    let section = sections.find(entry => entry.decision === key);
    if (!section) {
      section = { decision: key, laneId: item.laneId, section: item.assignedBy?.section ?? null, firstOnsetBeat: item.onsetBeat, lastOnsetBeat: item.onsetBeat, byClassification: {}, eventIds: [] };
      sections.push(section);
    }
    section.byClassification[item.classification] = (section.byClassification[item.classification] ?? 0) + 1;
    section.eventIds.push(item.eventId);
    if (f(item.onsetBeat).cmp(section.lastOnsetBeat) > 0) section.lastOnsetBeat = item.onsetBeat;
  }
  sections.sort((a, b) => f(a.firstOnsetBeat).cmp(b.firstOnsetBeat));
  const why = {
    [CLASSIFICATION.MISSING]: 'No stored review. The only symbolic source is a third-party MIDI (SOURCE_POLICY §1 C); top-line position is not Lead evidence; no direct review of the recording and no official score is on record.',
    [CLASSIFICATION.F0_PITCH_CLASS_ONLY]: 'The stored review rests on an F0/predominant-pitch or pitch-class match. SOURCE_POLICY §6: a metric is a locator and cannot alone prove role, Vocal identity, exact pitch or octave, whoever submits it.',
    [CLASSIFICATION.WEAK_MACHINE]: 'The stored review rests on CQT salience or an unspecified machine reading with no reproducible method. A metric is a locator whoever submits it (SOURCE_POLICY §6).',
    [CLASSIFICATION.AUDIO_LOCATOR_ONLY]: 'The stored review cites only a time/alignment locator; a locator is not a finding.',
    [CLASSIFICATION.CONTRADICTORY]: 'The stored review\'s own measured pitch lies two or more octaves below the event (bass/low-register content), so its "foreground" claim contradicts itself; or score and audio disagree. Conflicting evidence stays PENDING (SOURCE_POLICY §4).',
    [CLASSIFICATION.DIRECT_REVIEW_ON_RECORD]: 'A review stating a direct review of the recording is on record; the grader decides from its cited sources whether it proves the role.',
  };
  return {
    schema: 'mml-studio/lead-review-queue@1',
    notice: 'Deterministic audit/queue from service read exports. Not a decision, not a review, not a gate result. Nothing here demotes, moves or keeps any event.',
    exports: { reviews_sha256: reviewsText ? sha(reviewsText) : null, stored_reviews: stored.length, stored_promotion_reviews_latest: latest.size },
    candidate: { local_candidate_id: candidateId, melody_events: items.length },
    previousAcceptedVersion: 'N/A — the candidate has no accepted previous version (parent_candidate_id null); no accepted-version Lead evidence exists.',
    counts: { byClassification: count(items, 'classification'), byGradedStatusWithoutLegacyReviews: count(items, 'gradedStatus') },
    whyAutomaticDecisionIsInsufficient: why,
    allowedDispositions: ALLOWED_DISPOSITIONS,
    sections: sections.map(section => ({ ...section, eventCount: section.eventIds.length })),
    windows: windows.map(({ key, ...window }) => ({ ...window, eventCount: window.eventIds.length, reason: why[window.classification] })),
    items,
  };
}

async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    'work-dir': { type: 'string' }, events: { type: 'string' }, decisions: { type: 'string' }, reviews: { type: 'string' }, out: { type: 'string' }, public: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help || !values['work-dir'] || !values.events || !values.decisions) { process.stdout.write(HELP); return values.help ? 0 : 1; }
  const queue = await buildLeadReviewQueue({
    workDir: resolve(values['work-dir']), eventPaths: values.events.split(',').map(path => resolve(path)),
    decisionsPath: resolve(values.decisions), reviewsPath: values.reviews ? resolve(values.reviews) : null,
  });
  const text = values.public ? JSON.stringify(publicLeadReviewQueue(queue)) + '\n' : JSON.stringify(queue, null, 2) + '\n';
  if (values.out) writeFileSync(resolve(values.out), text, { flag: 'wx' });
  else process.stdout.write(text);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try { process.exitCode = await main(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
