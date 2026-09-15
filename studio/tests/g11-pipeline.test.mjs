import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestMIDI, midiFragmentToProject } from '../backend/source/index.mjs';
import { splitProjectSourceVoices, suggestRoleCandidates } from '../backend/arrangement/index.mjs';
import { f } from '../backend/mml/index.mjs';

// G11-A -> G11-B -> G11-C end-to-end integration.
//
// Every other suite in this repository exercises one stage. This one starts
// from raw Standard MIDI File bytes and runs the real production path:
//
//   raw bytes -> ingestMIDI -> midiFragmentToProject   (G11-A)
//             -> splitProjectSourceVoices               (G11-B)
//             -> suggestRoleCandidates                  (G11-C)
//
// Hand-building Canonical events would prove nothing about the contracts
// between the stages, which is exactly what this file exists to check: source
// event conservation, the provenance chain, exact rational timing, uncertainty
// propagation, and the survival of the Core3 three-role architecture.

// ─── raw SMF construction ───────────────────────────────────────────────────

const vlq = value => {
  const out = [value & 0x7f];
  let rest = Math.floor(value / 128);
  while (rest > 0) {
    out.unshift(0x80 | (rest & 0x7f));
    rest = Math.floor(rest / 128);
  }
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

// Absolute-tick note list -> delta-encoded entries.
const notesToEntries = notes => {
  const events = [];
  for (const [channel, pitch, onTick, offTick] of notes) {
    events.push({ tick: onTick, bytes: [0x90 | channel, pitch, 96] });
    events.push({ tick: offTick, bytes: [0x80 | channel, pitch, 0x40] });
  }
  events.sort((a, b) => a.tick - b.tick);
  let last = 0;
  return events.map(event => {
    const delta = event.tick - last;
    last = event.tick;
    return [delta, ...event.bytes];
  });
};

// PPQ 360, not 480: a beat then divides exactly into thirds (120 ticks) and
// sixths (60), so the fixture carries genuine 1/3 and 2/3 rational onsets that a
// float projection would smear.
const PPQ = 360;
const LEAD_VOICE = 'track:1/channel:0';
const ACCOMPANIMENT_VOICE = 'track:2/channel:1';
const BASS_VOICE = 'track:3/channel:2';
const ANSWER_VOICE = 'track:4/channel:3';
const PAD_VOICE = 'track:5/channel:4';

// A Lead that opens on a triplet, rests for a whole bar, and resumes.
const leadNotes = [
  [0, 72, 0, 120], [0, 74, 120, 240], [0, 76, 240, 360],
  [0, 77, 360, 720], [0, 76, 720, 1080], [0, 74, 1080, 1440],
  [0, 72, 1440, 1800], [0, 74, 1800, 2160], [0, 76, 2160, 2880],
  // bar 3 (2880-4320) is a genuine source rest
  [0, 77, 4320, 4680], [0, 76, 4680, 5040], [0, 72, 5040, 5760],
];

// Polyphonic accompaniment: block triads, which G11-B must decompose into
// three simultaneous lanes.
const accompanimentNotes = [
  [0, 720, [60, 64, 67]], [720, 1440, [59, 62, 67]],
  [1440, 2160, [60, 64, 67]], [2160, 2880, [57, 60, 64]],
  [2880, 3600, [59, 62, 67]], [3600, 4320, [60, 64, 67]],
  [4320, 5040, [59, 62, 67]], [5040, 5760, [60, 64, 67]],
].flatMap(([on, off, pitches]) => pitches.map(pitch => [1, pitch, on, off]));

const bassNotes = Array.from({ length: 16 }, (_, i) =>
  [2, [48, 50, 43, 45][i % 4], i * 360, (i + 1) * 360]);

// An instrumental answer that sounds only while the Lead rests.
const answerNotes = [[3, 79, 2880, 3240], [3, 77, 3240, 3600], [3, 76, 3600, 4320]];

// A sustained pad that belongs outside Core3, plus one note doubling the
// accompaniment's 67 at the same instant from a distinct source event.
const padNotes = [[4, 55, 0, 2880], [4, 57, 2880, 5760], [4, 67, 0, 720]];

// General MIDI channel 10 (index 9). G11-A must hold these as evidence and
// never emit them as pitched Canonical notes.
const drumNotes = [[9, 36, 0, 180], [9, 38, 720, 900], [9, 36, 1440, 1620], [9, 38, 2160, 2340]];

const PIPELINE_MIDI = buildMidi({
  format: 1,
  division: PPQ,
  tracks: [
    buildTrack([[0, ...trackName('Conductor')], [0, ...setTempo(500000)], [0, ...timeSig(4, 2)]]),
    buildTrack([[0, ...trackName('Lead')], [0, ...programChange(0, 73)], ...notesToEntries(leadNotes)]),
    buildTrack([[0, ...trackName('Accompaniment')], [0, ...programChange(1, 0)], ...notesToEntries(accompanimentNotes)]),
    buildTrack([[0, ...trackName('Bass')], [0, ...programChange(2, 33)], ...notesToEntries(bassNotes)]),
    buildTrack([[0, ...trackName('Answer')], [0, ...programChange(3, 73)], ...notesToEntries(answerNotes)]),
    buildTrack([[0, ...trackName('Pad')], [0, ...programChange(4, 89)], ...notesToEntries(padNotes)]),
    buildTrack([[0, ...trackName('Drums')], ...notesToEntries(drumNotes)]),
  ],
});

// The real production path, run once and shared by the assertions below.
function runPipeline(options = {}) {
  const fragment = ingestMIDI(PIPELINE_MIDI, { sourceId: 'e2e', label: 'Pipeline fixture' });
  const project = midiFragmentToProject(fragment);
  const decompositions = splitProjectSourceVoices(project);
  const candidate = suggestRoleCandidates(project, options);
  return { fragment, project, decompositions, candidate };
}

// The score's own role evidence, for the variant that asks whether the
// three-role backbone survives the whole pipeline when the roles are known.
const SCORE_ROLES = {
  sourceRoleEvidence: [
    { sourceVoice: LEAD_VOICE, role: 'Melody', citation: 'fixture:score lead staff' },
    { sourceVoice: ANSWER_VOICE, role: 'Melody', citation: 'fixture:score answer staff' },
    { laneId: `lane:${ACCOMPANIMENT_VOICE}#0`, role: 'Chord1', citation: 'fixture:score accompaniment, upper part' },
    { laneId: `lane:${ACCOMPANIMENT_VOICE}#1`, role: 'Chord3', citation: 'fixture:score accompaniment, inner part' },
    { laneId: `lane:${ACCOMPANIMENT_VOICE}#2`, role: 'Chord4', citation: 'fixture:score accompaniment, inner part' },
    { sourceVoice: BASS_VOICE, role: 'Chord2', citation: 'fixture:score bass staff' },
    { sourceVoice: PAD_VOICE, role: 'Chord5', citation: 'fixture:score pad, texture' },
  ],
};

// ─── stage contracts ────────────────────────────────────────────────────────

test('G11-A: raw bytes become a Source-Faithful baseline with percussion held as evidence', () => {
  const { fragment, project } = runPipeline();

  assert.equal(fragment.events.length, 58, 'every pitched note-on/off pair is projected');
  assert.equal(fragment.unsupported.length, 4, 'and every drum event is held as evidence');
  assert.deepEqual([...new Set(fragment.unsupported.map(item => item.code))], ['PERCUSSION_CHANNEL_EVENT']);
  assert.equal(fragment.complete, false, 'unsupported material makes the ingest honestly incomplete');

  // Intake assigns no musical role: that is G11-C's job.
  for (const event of fragment.events) assert.equal(event.role, null);
  // Track and channel together identify the independent line.
  assert.deepEqual(
    [...new Set(fragment.events.map(event => event.voice))].sort(),
    [LEAD_VOICE, ACCOMPANIMENT_VOICE, BASS_VOICE, ANSWER_VOICE, PAD_VOICE].sort(),
  );
  // Velocity stays evidence; Mobile volume is a later adaptation.
  for (const event of fragment.events) {
    assert.equal(event.volume, null);
    assert.equal(typeof event.metadata.velocity, 'number');
    assert.equal(typeof event.metadata.trackIndex, 'number');
    assert.equal(typeof event.metadata.channel, 'number');
  }
  assert.equal(project.metadata.sourceComplete, false);
  assert.equal(project.metadata.unsupported.length, 4, 'the project carries the drum evidence forward');
});

test('G11-B: decomposition is lossless and assigns no role', () => {
  const { fragment, decompositions } = runPipeline();

  assert.equal(decompositions.length, 5, 'one decomposition per source voice');
  for (const decomposition of decompositions) {
    assert.equal(decomposition.complete, true, `${decomposition.sourceVoice} must be source-complete`);
    for (const lane of decomposition.lanes) {
      for (const span of lane.notes) assert.equal(span.sourceRole, null, 'G11-B assigns no role');
    }
  }
  const accompaniment = decompositions.find(item => item.sourceVoice === ACCOMPANIMENT_VOICE);
  assert.equal(accompaniment.maxPolyphony, 3, 'the block triad really is polyphonic');
  assert.equal(accompaniment.lanes.length, 3);

  // Every G11-A note event appears in exactly one G11-B lane, unchanged.
  const byId = new Map(fragment.events.map(event => [event.id, event]));
  const spans = decompositions.flatMap(item => item.lanes.flatMap(lane => lane.notes));
  assert.deepEqual(
    new Set(spans.map(span => span.eventId)),
    new Set(byId.keys()),
    'decomposition neither drops nor invents a source event',
  );
  for (const span of spans) {
    const source = byId.get(span.eventId);
    assert.equal(span.pitch, source.pitch, `${span.eventId} pitch must survive decomposition`);
    assert.equal(f(span.eventStart).cmp(source.start), 0);
    assert.equal(f(span.eventEnd).cmp(source.end), 0);
    assert.deepEqual([...span.sourceIds], [...source.sourceIds]);
    assert.deepEqual([...span.sourceEventIds], [...source.sourceEventIds]);
  }
});

test('G11-C: consumes the real decomposition and accounts for every source event', () => {
  const { fragment, candidate } = runPipeline();

  assert.equal(candidate.coverage.complete, true);
  assert.equal(candidate.coverage.sourceEventCount, fragment.events.length);
  assert.deepEqual([...candidate.coverage.missingEventIds], []);
  assert.deepEqual([...candidate.coverage.unknownEventIds], []);
  assert.deepEqual([...candidate.coverage.mutatedEventIds], []);
  assert.equal(candidate.stageKind, 'ARRANGEMENT_CANDIDATE');
});

// ─── §14 event conservation ─────────────────────────────────────────────────

test('A->B->C: every source event is assigned, pending, unassigned or unsupported', () => {
  const { fragment, candidate } = runPipeline();

  const sourceIds = new Set(fragment.events.map(event => event.id));
  const assigned = new Set(candidate.ledger.filter(entry => entry.selected).map(entry => entry.eventId));
  const pending = new Set(candidate.ledger.filter(entry => entry.decision === 'PENDING').map(entry => entry.eventId));
  const omitted = new Set(candidate.ledger.filter(entry => entry.decision === 'OMIT_FROM_SIX').map(entry => entry.eventId));
  const unsupported = new Set(candidate.unsupportedSourceMaterial.map(item => item.eventId));
  const accounted = new Set([...assigned, ...pending, ...omitted, ...unsupported]);

  assert.deepEqual(accounted, sourceIds, 'ids must match exactly, not merely in count');
  assert.equal(
    candidate.coverage.assignedEventCount + candidate.coverage.pendingEventCount
    + candidate.coverage.unassignedEventCount + candidate.coverage.unsupportedEventCount,
    fragment.events.length,
  );
  // More lanes than roles: capacity must overflow explicitly, never delete.
  assert.ok(candidate.lanes.length > 6, 'the fixture really does exceed six-role capacity');
  assert.ok(candidate.unassigned.length > 0);
  for (const item of candidate.unassigned) {
    assert.equal(item.reason, 'SIX_ROLE_CAPACITY_EXCEEDED');
    assert.equal(item.provisional, true);
    assert.ok(item.eventIds.length);
  }
});

// ─── §15 provenance chain ───────────────────────────────────────────────────

test('A->B->C: a raw MIDI event stays traceable all the way to a candidate role', () => {
  const { fragment, decompositions, candidate } = runPipeline();

  // Pick the second triplet note: a non-binary onset in the Lead.
  const sourceEvent = fragment.events.find(event => event.start === '1/3');
  assert.ok(sourceEvent, 'the fixture must contain a 1/3 onset');
  assert.deepEqual([...sourceEvent.sourceEventIds], ['track:1/event:4', 'track:1/event:5'],
    'the Canonical event names the raw note-on and note-off it came from');

  const laneEntry = decompositions
    .flatMap(item => item.lanes.map(lane => ({ sourceVoice: item.sourceVoice, lane })))
    .find(entry => entry.lane.notes.some(span => span.eventId === sourceEvent.id));
  assert.ok(laneEntry, 'the event must land in a G11-B lane');
  const span = laneEntry.lane.notes.find(item => item.eventId === sourceEvent.id);
  assert.equal(laneEntry.sourceVoice, LEAD_VOICE);
  assert.ok(span.chainId, 'the span names its continuity chain');

  const ledger = candidate.ledger.filter(entry => entry.eventId === sourceEvent.id);
  assert.equal(ledger.length, 1);
  const [entry] = ledger;
  assert.equal(entry.laneId, `lane:${LEAD_VOICE}#${laneEntry.lane.index}`);
  assert.equal(entry.sourceVoice, LEAD_VOICE);
  assert.equal(entry.sourcePitch, sourceEvent.pitch);
  assert.deepEqual([...entry.sourceIds], [...sourceEvent.sourceIds]);
  assert.deepEqual([...entry.sourceEventIds], [...sourceEvent.sourceEventIds]);
  assert.ok(entry.candidateRole, 'and it reaches a candidate role');

  // The reverse question — where did every source event go? — is answerable for
  // all of them, not just this one.
  for (const event of fragment.events) {
    const entries = candidate.ledger.filter(item => item.eventId === event.id);
    assert.ok(entries.length, `${event.id} must have at least one ledger decision`);
    for (const item of entries) {
      assert.deepEqual([...item.sourceEventIds], [...event.sourceEventIds]);
      assert.equal(item.sourcePitch, event.pitch);
    }
  }
});

// ─── §16 exact timing ───────────────────────────────────────────────────────

test('A->B->C: exact rational timing is identical at all three stages', () => {
  const { fragment, decompositions, candidate } = runPipeline();

  const rationals = fragment.events.filter(event => event.start.includes('/') || event.end.includes('/'));
  assert.equal(rationals.length, 3, 'the triplet really produces non-binary rational beats');
  assert.deepEqual(rationals.map(event => `${event.start}..${event.end}`), ['0..1/3', '1/3..2/3', '2/3..1']);

  const spans = new Map(decompositions
    .flatMap(item => item.lanes.flatMap(lane => lane.notes))
    .map(span => [span.eventId, span]));
  for (const event of rationals) {
    const span = spans.get(event.id);
    assert.equal(span.eventStart, event.start, 'G11-B keeps the exact spelling');
    assert.equal(span.eventEnd, event.end);
    const [entry] = candidate.ledger.filter(item => item.eventId === event.id);
    assert.equal(entry.sourceStart, event.start, 'and so does the G11-C ledger');
    assert.equal(entry.sourceEnd, event.end);
  }

  // No decision anywhere may read a float projection of a beat.
  assert.equal(/\d\.\d{3,}/.test(JSON.stringify(candidate)), false,
    'no float-projected beat may appear in the candidate');
  assert.ok(JSON.stringify(candidate).includes('1/3'));
});

// ─── §18 uncertainty propagation ────────────────────────────────────────────

test('A->B->C: unsupported stays unsupported and unresolved stays unresolved', () => {
  const { fragment, candidate } = runPipeline();

  // G11-A UNSUPPORTED must not become supported pitched evidence downstream.
  const drumRefs = new Set(fragment.unsupported.flatMap(item => item.sourceEventIds));
  assert.ok(drumRefs.size);
  const ledgerRefs = new Set(candidate.ledger.flatMap(entry => entry.sourceEventIds));
  for (const ref of drumRefs) {
    assert.equal(ledgerRefs.has(ref), false, `${ref} is drum evidence and must never become a pitched role`);
  }
  for (const lane of candidate.lanes) {
    for (const ref of lane.sourceEventIds) assert.equal(drumRefs.has(ref), false);
  }

  // Bare MIDI carries no role metadata, so principal harmony cannot be
  // established and Core3 fails closed rather than guessing.
  assert.equal(candidate.core3.status, 'PENDING');
  assert.equal(candidate.core3.functions.principalHarmony.satisfied, false);
  assert.equal(candidate.core3.functions.principalHarmony.status, 'CANDIDATE_ONLY');
  assert.ok(candidate.core3.unprovenFunctions.includes('principal-harmony'));
  assert.deepEqual([...candidate.core3.absentFunctions], [], 'unproven is not the same as absent');
  assert.notEqual(candidate.full6.status, 'USEFUL',
    'Full6 may not read as harmless while a Core3 function is unresolved');
});

// ─── §17 Core3 architecture survives the pipeline ───────────────────────────

test('A->B->C: the Core3 three-role backbone survives intake and decomposition', () => {
  const { candidate } = runPipeline(SCORE_ROLES);

  assert.equal(candidate.core3.status, 'COMPLETE');
  assert.deepEqual([...candidate.core3.unprovenFunctions], []);
  assert.deepEqual([...candidate.core3.absentFunctions], []);

  // Melody is source-supported Lead continuity, including the instrumental
  // answer that covers the Lead's own rest. A genuine rest is not a Lead gap.
  const lead = candidate.core3.functions.leadContinuity;
  assert.equal(lead.satisfied, true);
  assert.equal(lead.laneIds.length, 2);
  assert.ok(lead.laneIds.includes(`lane:${LEAD_VOICE}#0`));
  assert.ok(lead.laneIds.includes(`lane:${ANSWER_VOICE}#0`));
  assert.equal(lead.sourceSupportedHandOff, true);

  // Chord1 is principal accompaniment, Chord2 the bass skeleton.
  assert.equal(candidate.core3.functions.principalHarmony.satisfied, true);
  assert.deepEqual([...candidate.roles.Chord1.laneIds], [`lane:${ACCOMPANIMENT_VOICE}#0`]);
  assert.equal(candidate.core3.functions.bassSkeleton.satisfied, true);
  assert.deepEqual([...candidate.roles.Chord2.laneIds], [`lane:${BASS_VOICE}#0`]);

  // All three roles are required; none is optional filler.
  assert.equal(candidate.core3.architecture.priorityAmongRoles, 'NONE');
  assert.equal(candidate.core3.architecture.allThreeRequiredForComplete, true);
  assert.deepEqual([...candidate.core3.architecture.roles], ['Melody', 'Chord1', 'Chord2']);
  assert.equal(candidate.coverage.complete, true);
});

test('A->B->C: enrichment cannot repair a Core3 function broken after the real pipeline', () => {
  // Same pipeline, same score evidence, but the bass staff is withheld.
  const withoutBass = {
    sourceRoleEvidence: SCORE_ROLES.sourceRoleEvidence.filter(entry => entry.sourceVoice !== BASS_VOICE),
  };
  const { candidate } = runPipeline({
    ...withoutBass,
    roleOverrides: { [`lane:${BASS_VOICE}#0`]: null },
  });
  assert.ok(candidate.full6.rolesUsed.length >= 1, 'enrichment roles are populated');
  assert.notEqual(candidate.core3.status, 'COMPLETE');
  assert.ok(candidate.core3.missingFunctions.includes('bass-skeleton'));
});

// ─── §19 responsibility separation, and determinism through the real path ───

test('A->B->C: no stage does another stage job, and no stage mutates source truth', () => {
  const { fragment, decompositions, candidate } = runPipeline(SCORE_ROLES);

  // G11-B claims no role assignment and no reduction.
  for (const decomposition of decompositions) {
    for (const lane of decomposition.lanes) {
      for (const span of lane.notes) assert.equal(span.sourceRole, null);
    }
  }
  // G11-C emits no Final MML and certifies no acceptance gate.
  const serialized = JSON.stringify(candidate);
  assert.equal(serialized.includes('MML@'), false);
  for (const gate of ['TECHNICAL_PASS', 'SOURCE_PASS', 'PLAYER_READBACK_PASS',
    'AUDIO_ALIGNMENT_PASS', 'MOBILE_ADAPTATION_PASS', 'IN_GAME_ACCEPTED']) {
    assert.ok(candidate.notice.includes(gate), `${gate} must be explicitly disclaimed`);
  }
  // And it changed nothing about the baseline.
  const byId = new Map(fragment.events.map(event => [event.id, event]));
  for (const entry of candidate.ledger) {
    const source = byId.get(entry.eventId);
    assert.equal(entry.sourcePitch, source.pitch);
    assert.equal(f(entry.sourceStart).cmp(source.start), 0);
    assert.equal(f(entry.sourceEnd).cmp(source.end), 0);
  }
});

test('A->B->C: the candidate is a pure function of the source event set', () => {
  const { project } = runPipeline();
  const canonical = JSON.stringify(suggestRoleCandidates(project));
  const permutations = {
    reversed: [...project.events].reverse(),
    'pitch-asc': [...project.events].sort((a, b) => a.pitch - b.pitch),
    'id-desc': [...project.events].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)),
    rotated: project.events.map((_, index) => project.events[(index + 1) % project.events.length]),
  };
  for (const [label, events] of Object.entries(permutations)) {
    assert.equal(JSON.stringify(suggestRoleCandidates({ ...project, events })), canonical,
      `${label} source order must not change the candidate`);
  }
  // Caller evidence order must not matter either.
  const scored = JSON.stringify(suggestRoleCandidates(project, SCORE_ROLES));
  assert.equal(
    JSON.stringify(suggestRoleCandidates(project, {
      sourceRoleEvidence: [...SCORE_ROLES.sourceRoleEvidence].reverse(),
    })),
    scored,
    'evidence insertion order must not change the candidate',
  );
});
