import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestMIDI, midiFragmentToProject } from '../backend/source/index.mjs';
import {
  splitProjectSourceVoices,
  suggestRoleCandidates,
  applyAcceptedArrangement,
  baselineIdentityOf,
  laneDecompositionDigestOf,
  reviewAppliedCandidate,
  leadDemotionReportsFromApplication,
} from '../backend/arrangement/index.mjs';
import { f } from '../backend/mml/index.mjs';
import { EFFECTIVE_RULESET } from '../backend/rules/index.mjs';

// G11-A -> G11-B -> G11-C -> explicit accepted decisions -> G11-D -> diff ->
// readiness, over real Standard MIDI File bytes.
//
// Hand-building a Canonical project would prove nothing about the contract
// between the stages, which is the point of this file: the baseline really is
// the one G11-A produced, the lane ids really are the ones G11-C published, the
// decisions really are bound to those exact identities, and the candidate
// G11-D returns really is consumable by the existing readiness pipeline.

// ─── raw SMF construction ───────────────────────────────────────────────────

const vlq = value => {
  const out = [value & 0x7f];
  let rest = Math.floor(value / 128);
  while (rest > 0) { out.unshift(0x80 | (rest & 0x7f)); rest = Math.floor(rest / 128); }
  return out;
};
const be = (value, bytes) => Array.from({ length: bytes }, (_, i) => (value >> ((bytes - 1 - i) * 8)) & 0xff);
const chunk = (type, body) => [...Array.from(type, c => c.charCodeAt(0)), ...be(body.length, 4), ...body];
const buildTrack = entries => {
  const body = entries.flatMap(([delta, ...bytes]) => [...vlq(delta), ...bytes]);
  body.push(...vlq(0), 0xff, 0x2f, 0x00);
  return chunk('MTrk', body);
};
const buildMidi = ({ format = 1, division, tracks }) => new Uint8Array([
  ...chunk('MThd', [...be(format, 2), ...be(tracks.length, 2), ...be(division, 2)]),
  ...tracks.flat(),
]);
const meta = (type, data) => [0xff, type, data.length, ...data];
const setTempo = us => meta(0x51, [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]);
const timeSig = (num, denPow2) => meta(0x58, [num, denPow2, 24, 8]);
const trackName = name => meta(0x03, Array.from(name, c => c.charCodeAt(0)));
const programChange = (channel, program) => [0xc0 | channel, program];
const notesToEntries = notes => {
  const events = [];
  for (const [channel, pitch, onTick, offTick] of notes) {
    events.push({ tick: onTick, bytes: [0x90 | channel, pitch, 96] });
    events.push({ tick: offTick, bytes: [0x80 | channel, pitch, 0x40] });
  }
  events.sort((a, b) => a.tick - b.tick);
  let last = 0;
  return events.map(event => { const delta = event.tick - last; last = event.tick; return [delta, ...event.bytes]; });
};

// PPQ 360 so a beat divides exactly into thirds and sixths: the fixture carries
// genuine 1/3 and 2/3 rational onsets that a float projection would smear.
const PPQ = 360;
const LEAD_VOICE = 'track:1/channel:0';
const HARMONY_VOICE = 'track:2/channel:1';
const BASS_VOICE = 'track:3/channel:2';
const PAD_VOICE = 'track:4/channel:3';

const leadNotes = [
  [0, 72, 0, 120], [0, 74, 120, 240], [0, 76, 240, 360],
  [0, 77, 360, 720], [0, 76, 720, 1080], [0, 74, 1080, 1440],
];
const harmonyNotes = [[0, 1440, [60, 64, 67]]].flatMap(([on, off, pitches]) => pitches.map(pitch => [1, pitch, on, off]));
const bassNotes = [[2, 48, 0, 720], [2, 43, 720, 1440]];
const padNotes = [[3, 55, 0, 1440]];
const drumNotes = [[9, 36, 0, 180], [9, 38, 720, 900]];

const PIPELINE_MIDI = buildMidi({
  format: 1,
  division: PPQ,
  tracks: [
    buildTrack([[0, ...trackName('Conductor')], [0, ...setTempo(500000)], [0, ...timeSig(4, 2)]]),
    buildTrack([[0, ...trackName('Lead')], [0, ...programChange(0, 73)], ...notesToEntries(leadNotes)]),
    buildTrack([[0, ...trackName('Harmony')], [0, ...programChange(1, 0)], ...notesToEntries(harmonyNotes)]),
    buildTrack([[0, ...trackName('Bass')], [0, ...programChange(2, 33)], ...notesToEntries(bassNotes)]),
    buildTrack([[0, ...trackName('Pad')], [0, ...programChange(3, 89)], ...notesToEntries(padNotes)]),
    buildTrack([[0, ...trackName('Drums')], ...notesToEntries(drumNotes)]),
  ],
});

const CANONICAL_IDENTITY = EFFECTIVE_RULESET.canonical;

function pipeline() {
  const fragment = ingestMIDI(PIPELINE_MIDI, { sourceId: 'g11d-e2e', label: 'G11-D pipeline fixture' });
  const baseline = midiFragmentToProject(fragment);
  const decompositions = splitProjectSourceVoices(baseline);
  const suggestion = suggestRoleCandidates(baseline, { decompositions });
  return { fragment, baseline, decompositions, suggestion };
}

const { fragment, baseline, suggestion } = pipeline();
const identity = baselineIdentityOf(baseline);
const laneDigest = laneDecompositionDigestOf(suggestion);

const acceptance = (reviewedRevisionId = null) => ({
  state: 'ACCEPTED',
  acceptedBy: 'pipeline-fixture-reviewer',
  reviewedRevisionId,
  baselineContentDigest: identity.contentDigest,
  sourceIdentityDigest: identity.sourceIdentityDigest,
  laneDecompositionDigest: laneDigest,
  canonicalRulesSnapshotSha: CANONICAL_IDENTITY.rules_snapshot_sha,
});

const laneId = voice => `lane:${voice}#0`;
// A polyphonic source voice decomposes into several G11-B lanes, so a decision
// about "the accompaniment" is a decision about every lane that voice produced.
const lanesOfVoice = voice => suggestion.lanes.filter(lane => lane.sourceVoice === voice).map(lane => lane.id).sort();
const eventsOfVoice = voice => suggestion.lanes
  .filter(lane => lane.sourceVoice === voice)
  .flatMap(lane => [...lane.eventIds])
  .sort();

// The reviewer's decisions. Every role in the candidate is here because a
// reviewer put it here: nothing is inherited from the G11-C ranking.
const ACCEPTED = [
  {
    id: 'acc-lead',
    type: 'ASSIGN_ROLE',
    target: { laneId: laneId(LEAD_VOICE) },
    toRole: 'Melody',
    reason: 'Reviewed: the flute line is the lead throughout this excerpt.',
    evidence: ['fixture:score lead staff bars 1-2'],
    leadEvidence: {
      sourceIdentity: { sourceId: fragment.source.id, sourceEventId: 'track:1/channel:0/note:72@0' },
      sectionRole: 'instrumental',
      scoreEvidence: { availability: 'available', classification: 'lead', citation: 'fixture:score lead staff' },
      audioEvidence: { availability: 'available', classification: 'foreground', citation: 'fixture:audio 0:00-0:02 foreground' },
    },
    acceptance: acceptance(),
  },
  ...lanesOfVoice(HARMONY_VOICE).map((lane, index) => ({
    id: `acc-harmony-${index}`,
    type: 'ASSIGN_ROLE',
    target: { laneId: lane },
    toRole: 'Chord1',
    reason: 'Reviewed: the block triad is the principal accompaniment.',
    evidence: ['fixture:score accompaniment staff'],
    acceptance: acceptance(),
  })),
  {
    id: 'acc-bass',
    type: 'ASSIGN_ROLE',
    target: { laneId: laneId(BASS_VOICE) },
    toRole: 'Chord2',
    reason: 'Reviewed: the bass skeleton carries the one-player low end.',
    evidence: ['fixture:score bass staff'],
    acceptance: acceptance(),
  },
  {
    id: 'acc-pad',
    type: 'ASSIGN_ROLE',
    target: { laneId: laneId(PAD_VOICE) },
    toRole: 'Chord3',
    reason: 'Reviewed: the pad is texture and belongs outside Core3.',
    evidence: ['fixture:score pad staff'],
    acceptance: acceptance(),
  },
];

// ─── the chain holds end to end ─────────────────────────────────────────────

test('the accepted decisions target the lane ids G11-C actually published', () => {
  const published = new Set(suggestion.lanes.map(lane => lane.id));
  for (const decision of ACCEPTED) {
    assert.ok(published.has(decision.target.laneId), `${decision.target.laneId} must be a real G11-C lane`);
  }
  // The polyphonic accompaniment really did decompose into three lanes, so the
  // fixture exercises a multi-lane role rather than a convenient single lane.
  assert.equal(lanesOfVoice(HARMONY_VOICE).length, 3);
  // G11-A assigns no role, so every role below arrives through a decision.
  for (const event of baseline.events) assert.equal(event.role, null);
});

test('raw MIDI bytes reach an accepted six-role candidate with no identity loss', () => {
  const result = applyAcceptedArrangement({
    baseline, suggestion, decisions: ACCEPTED, canonicalIdentity: CANONICAL_IDENTITY,
  });
  assert.equal(result.status, 'PASS', JSON.stringify(result.rejected));

  // Every source note is still exactly one candidate event, with its identity,
  // its provenance and its exact rational timing intact.
  assert.equal(result.candidate.events.length, baseline.events.length);
  const before = new Map(baseline.events.map(event => [event.id, event]));
  for (const event of result.candidate.events) {
    const source = before.get(event.id);
    assert.ok(source, `${event.id} must come from a baseline event`);
    assert.equal(event.pitch, source.pitch);
    assert.equal(f(event.start).cmp(source.start), 0);
    assert.equal(f(event.end).cmp(source.end), 0);
    assert.deepEqual([...event.sourceIds], [...source.sourceIds]);
    assert.deepEqual([...event.sourceEventIds], [...source.sourceEventIds]);
    assert.equal(event.metadata.program, source.metadata.program);
  }

  // The triplet onsets survive as exact rationals, not as 0.333…
  const onsets = result.candidate.events.map(event => event.start);
  assert.ok(onsets.includes('1/3'), `expected an exact 1/3 onset, got ${onsets.join(' ')}`);
  assert.ok(onsets.includes('2/3'));

  const roles = role => result.candidate.events.filter(event => event.role === role).length;
  assert.equal(roles('Melody'), 6);
  assert.equal(roles('Chord1'), 3);
  assert.equal(roles('Chord2'), 2);
  assert.equal(roles('Chord3'), 1);

  // Percussion never became a pitched role: G11-A held it as evidence and
  // nothing downstream turned it into a note.
  assert.equal(fragment.unsupported.length, 2);
  assert.equal(result.candidate.events.some(event => event.metadata.channel === 9), false);

  // Tempo and meter came from the file and are untouched.
  assert.equal(result.candidate.tempoEvents.length, 1);
  assert.equal(result.candidate.meterEvents.length, 1);
  assert.equal(result.diffFromBaseline.summary.tempoChanged, 0);
});

test('the applied candidate is consumable by the existing validation pipeline', () => {
  const application = applyAcceptedArrangement({
    baseline, suggestion, decisions: ACCEPTED, canonicalIdentity: CANONICAL_IDENTITY,
  });
  assert.equal(application.status, 'PASS');

  const review = reviewAppliedCandidate({ application, baseline });
  assert.equal(review.status, 'REVIEWED');

  // Every downstream module really ran against the candidate.
  assert.ok(review.lineage.sourceToCandidate);
  // Every event moved from "no accepted role" to an accepted one, and the
  // existing diff reports each of those as a role move. Nothing was added,
  // removed, repitched or retimed on the way.
  assert.equal(review.lineage.sourceToCandidate.summary.roleMoved, baseline.events.length);
  assert.equal(review.lineage.sourceToCandidate.summary.noteRemoved, 0);
  assert.equal(review.lineage.sourceToCandidate.summary.noteAdded, 0);
  assert.equal(review.lineage.sourceToCandidate.summary.noteModified, 0);
  assert.ok(review.core3FromBaseline.status);
  assert.ok(review.harmony.status);
  assert.ok(review.readiness.gates.baseline);

  // The readiness baseline gate found a real Source-Faithful snapshot to diff
  // against, because G11-D attached the baseline it derived from.
  assert.equal(review.readiness.gates.baseline.status, 'PASS');
  assert.equal(review.readiness.gates.baseline.baselineId, baseline.id);
});

test('G11-D PASS is not VALIDATED: readiness still blocks on everything it always blocked on', () => {
  const application = applyAcceptedArrangement({
    baseline, suggestion, decisions: ACCEPTED, canonicalIdentity: CANONICAL_IDENTITY,
  });
  const review = reviewAppliedCandidate({ application, baseline });

  assert.equal(application.status, 'PASS');
  assert.equal(review.readiness.candidateReady, false, 'applying accepted decisions must not make a song ready');
  assert.equal(review.readiness.finalAccepted, false);

  // Source completeness is not inherited from the application, and the source
  // really is incomplete: the file carries percussion G11-A could not represent.
  assert.equal(review.readiness.gates.source.status, 'PENDING');
  assert.ok(review.readiness.preGameBlocking.includes('source'));
  assert.ok(review.readiness.preGameBlocking.includes('technical'), 'no MML has been emitted, so the technical gate cannot pass');
  assert.ok(review.readiness.preGameBlocking.includes('originalAudio'));

  // And the stage says so about itself.
  assert.deepEqual([...application.downstream.certifiesGates], []);
  assert.deepEqual([...application.candidate.metadata.g11d.certifiesGates], []);
});

// ─── revision 2 over the pipeline candidate ─────────────────────────────────

test('a second accepted revision diffs against both the baseline and the previous candidate', () => {
  const first = applyAcceptedArrangement({
    baseline, suggestion, decisions: ACCEPTED, canonicalIdentity: CANONICAL_IDENTITY,
  });
  const padEventIds = suggestion.lanes.find(lane => lane.id === laneId(PAD_VOICE)).eventIds;

  const second = applyAcceptedArrangement({
    baseline,
    suggestion,
    canonicalIdentity: CANONICAL_IDENTITY,
    parent: { revision: first.revision, candidate: first.candidate },
    decisions: [{
      id: 'rev2-pad',
      type: 'MOVE_ROLE',
      target: { eventIds: [...padEventIds] },
      fromRole: 'Chord3',
      toRole: 'Chord5',
      reason: 'Reviewed: the pad reads better as the outermost enrichment role.',
      evidence: ['fixture:review note 2'],
      acceptance: acceptance(first.revision.id),
    }],
  });

  assert.equal(second.status, 'PASS');
  assert.equal(second.revision.index, 2);
  assert.equal(second.revision.parentRevisionId, first.revision.id);

  // Against the previous accepted candidate: one role move, nothing else.
  assert.equal(second.diffFromParent.summary.roleMoved, 1);
  assert.equal(second.diffFromParent.summary.noteAdded, 0);
  assert.equal(second.diffFromParent.summary.noteRemoved, 0);

  // Against the Source-Faithful Baseline: the whole lineage, including the
  // roles revision 1 assigned to a role-less baseline.
  assert.equal(second.diffFromBaseline.summary.noteRemoved, 0);
  assert.equal(second.diffFromBaseline.summary.noteAdded, 0);
  assert.equal(second.diffFromBaseline.summary.roleMoved, baseline.events.length, 'the lineage from a role-less baseline still shows every accepted role');

  const review = reviewAppliedCandidate({ application: second, baseline, acceptedPrevious: first.candidate });
  assert.ok(review.lineage.previousToCandidate, 'the accepted-previous comparison Canonical asks for is available');
  assert.equal(review.lineage.previousToCandidate.summary.roleMoved, 1);
  assert.ok(review.core3FromPrevious, 'and Core3 continuity is answered against it too');
});

// ─── Lead handling across the whole chain ───────────────────────────────────

test('a Lead demotion in revision 2 still has to satisfy the Lead Demotion Gate twice', () => {
  const first = applyAcceptedArrangement({
    baseline, suggestion, decisions: ACCEPTED, canonicalIdentity: CANONICAL_IDENTITY,
  });
  const leadEventIds = suggestion.lanes.find(lane => lane.id === laneId(LEAD_VOICE)).eventIds;
  const demote = extra => applyAcceptedArrangement({
    baseline,
    suggestion,
    canonicalIdentity: CANONICAL_IDENTITY,
    parent: { revision: first.revision, candidate: first.candidate },
    decisions: [{
      id: 'rev2-demote',
      type: 'MOVE_ROLE',
      target: { eventIds: [leadEventIds[0]] },
      fromRole: 'Melody',
      toRole: 'Chord4',
      reason: 'Reviewed: this opening note is doubled by the harmony, not the lead.',
      evidence: ['fixture:review note 3'],
      acceptance: acceptance(first.revision.id),
      ...extra,
    }],
  });

  // Without the evidence chain the move is PENDING at application time.
  const bare = demote({});
  assert.equal(bare.status, 'PENDING');
  assert.equal(bare.candidate, null);

  // With it, the move applies -- and the readiness Lead gate still asks for the
  // same evidence, from the same gate, before it will pass.
  const evidenced = demote({
    leadEvidence: {
      sourceIdentity: { sourceId: fragment.source.id, sourceEventId: leadEventIds[0] },
      sectionRole: 'instrumental',
      scoreEvidence: { availability: 'available', classification: 'inner', citation: 'fixture:score inner staff bar 1' },
      audioEvidence: { availability: 'available', classification: 'background', citation: 'fixture:audio 0:00 background' },
      continuity: { checked: true, createsLeadGap: false, replacementEventIds: [] },
      core3: { checked: true, status: 'PASS' },
      positiveReason: 'The score places this attack on the inner staff and the mix keeps it behind the lead.',
    },
  });
  assert.equal(evidenced.status, 'PASS');

  // The baseline declares no roles, so the baseline diff shows no Lead removal
  // and the readiness Lead gate has nothing to require -- but the reports the
  // accepted evidence supports are still produced by the real gate.
  const reports = leadDemotionReportsFromApplication(evidenced, first.candidate);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'PASS');
  assert.equal(reports[0].eventId, leadEventIds[0]);

  // Strip the evidence from the same applied result and the report fails
  // closed, which is what stops an application from vouching for itself.
  const stripped = leadDemotionReportsFromApplication(
    { ...evidenced, applied: evidenced.applied.map(entry => ({ ...entry, leadEvidence: null })) },
    first.candidate,
  );
  assert.equal(stripped[0].status, 'PENDING');
  assert.ok(stripped[0].blockers.length > 0);
});

// ─── the review wiring refuses to speak for a refused application ───────────

test('nothing downstream runs against an application that produced no candidate', () => {
  const refused = applyAcceptedArrangement({
    baseline, suggestion, canonicalIdentity: CANONICAL_IDENTITY,
    decisions: [{ ...ACCEPTED[0], id: 'stale', acceptance: acceptance('g11d:rev:not-this-one') }],
  });
  assert.equal(refused.status, 'FAIL');
  const review = reviewAppliedCandidate({ application: refused, baseline });
  assert.equal(review.status, 'NOT_APPLICABLE');
  assert.equal(review.readiness, null);
  assert.equal(review.core3FromBaseline, null);
  assert.equal(review.harmony, null);
  assert.deepEqual(leadDemotionReportsFromApplication(refused, baseline), []);
});
