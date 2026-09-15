// Raw MIDI source intake for Studio Web.
//
// This module is the integration layer between the browser and the already
// merged G11 backend. It parses nothing itself: `ingestMIDI` decodes the bytes,
// `splitProjectSourceVoices` decomposes the source voices and
// `suggestRoleCandidates` proposes roles. What is added here is only what a
// browser needs and a Node process does not -- a byte-exact persistence
// encoding, a derivation binding so a stored result cannot outlive the bytes it
// came from, and the asset shape the existing Studio model already consumes.
//
// Three separations are load-bearing and are not conveniences:
//
//   * the Source-Faithful Canonical project is never merged with the
//     arrangement candidate. `asset.project` is source truth; `asset.arrangement`
//     is a G11-C suggestion and says so in its own fields;
//   * completeness is whatever the backend computed. Nothing in this module,
//     and no caller metadata reaching it, can raise `complete`;
//   * the bytes are hashed over exactly what was parsed, so a source identity
//     can never describe a different byte sequence than the one ingested.
//
// It is deliberately free of DOM and Node APIs: it runs unchanged inside the
// analysis Worker and inside `node --test`.

import { ingestMIDI, midiFragmentToProject, sha256Hex, toBytes } from '../backend/source/index.mjs';
import { splitProjectSourceVoices, suggestRoleCandidates } from '../backend/arrangement/index.mjs';

export const MIDI_SOURCE_FORMAT = 'MIDI';

// The pipeline identity a stored arrangement is bound to. Bump it whenever the
// derivation changes shape, so a restored project shows its candidate as stale
// instead of presenting an old reading as current.
export const RAW_MIDI_PIPELINE = 'studio-web/raw-midi@1';

// An implementation guard, not a Canonical rule. It matches the symbolic intake
// ceiling already in model.mjs so one source type is not quietly allowed more.
export const MAX_MIDI_BYTES = 4 * 1024 * 1024;

// Mirrors the guard readCanonical already applies. Checking it here makes the
// limit fail visibly at intake, naming the real number, instead of surfacing
// later as an unexplained analysis failure with the source already replaced.
export const MAX_CANONICAL_EVENTS = 30000;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const encoder = new TextEncoder();

// ─── byte-exact persistence encoding ────────────────────────────────────────

// Base64 over latin-1 code units, not a UTF-8 round trip: every byte 0x00-0xff
// maps to exactly one code unit and back, so the decoded array is the byte
// sequence that was encoded. A UTF-8 decode of arbitrary MIDI bytes would
// replace invalid sequences and silently change the source.
export function encodeSourceBytes(input) {
  const bytes = toBytes(input);
  let binary = '';
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export function decodeSourceBytes(text) {
  if (typeof text !== 'string' || !BASE64.test(text) || text.length % 4 !== 0) throw Error('SOURCE_BYTES_UNREADABLE: persisted MIDI is not valid base64');
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const digestOf = text => sha256Hex(encoder.encode(text));

// ─── source facts ───────────────────────────────────────────────────────────

const countByCode = items => {
  const counts = {};
  for (const item of items) counts[item.code] = (counts[item.code] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
};

// What the file states about itself, taken from the fragment rather than
// re-derived. Percussion is counted separately from the rest of the
// unsupported evidence because it is the one class a reader is most likely to
// assume became ordinary notes.
function midiFacts(fragment) {
  const metadata = fragment.source.metadata;
  const percussion = fragment.unsupported.filter(item => item.code === 'PERCUSSION_CHANNEL_EVENT');
  return {
    smfFormat: metadata.format,
    division: metadata.division,
    declaredTrackCount: metadata.declaredTrackCount,
    trackCount: metadata.trackCount,
    byteLength: metadata.byteLength,
    title: fragment.title,
    noteEventCount: fragment.events.length,
    tempoEventCount: fragment.tempoEvents.length,
    meterEventCount: fragment.meterEvents.length,
    pedalEventCount: fragment.pedalEvents.length,
    hasTempo: fragment.tempoEvents.length > 0,
    hasMeter: fragment.meterEvents.length > 0,
    percussionEventCount: percussion.length,
    percussionChannels: [...new Set(percussion.map(item => item.channel))].sort((a, b) => a - b),
    percussionNoteNumbers: [...new Set(percussion.map(item => item.noteNumber))].sort((a, b) => a - b),
    unsupportedCounts: countByCode(fragment.unsupported),
    warningCounts: countByCode(fragment.warnings),
    tracks: fragment.tracks.map(track => ({
      index: track.index,
      name: track.name,
      rawEvents: track.rawEvents,
      noteEvents: track.noteEvents,
      percussionEvents: track.percussionEvents,
      channels: [...track.channels],
      programChanges: track.programChanges.map(change => ({ ...change })),
      endTick: track.endTick,
      endBeat: track.endBeat,
      sawEndOfTrack: track.sawEndOfTrack,
    })),
    sourceVoices: [...new Set(fragment.events.map(event => event.voice))].sort(),
  };
}

// ─── G11-B / G11-C derivation ───────────────────────────────────────────────

// The decomposition, reported at the level the invariants are stated at.
// Per-note spans are not repeated here: G11-C carries the identical spans in
// `candidate.lanes[].spans`, and duplicating them a third time would only make
// the stored record larger without making anything more explainable.
function voiceSplitReport(decompositions) {
  const inputEventIds = decompositions.flatMap(group => [...group.inputEventIds]);
  const outputEventIds = decompositions.flatMap(group => [...group.outputEventIds]);
  const outputCounts = new Map();
  for (const id of outputEventIds) outputCounts.set(id, (outputCounts.get(id) ?? 0) + 1);

  return {
    schema: 'mml-studio-web/raw-midi-voice-split@1',
    stage: 'G11-B',
    complete: decompositions.every(group => group.complete),
    sourceVoiceCount: decompositions.length,
    laneCount: decompositions.reduce((total, group) => total + group.lanes.length, 0),
    maxPolyphony: Math.max(0, ...decompositions.map(group => group.maxPolyphony)),
    inputEventCount: inputEventIds.length,
    outputEventCount: outputEventIds.length,
    // Losslessness is a statement about identities, so it is recorded as the
    // actual set difference rather than as two counts that happen to agree.
    missingEventIds: inputEventIds.filter(id => !outputCounts.has(id)).sort(),
    duplicatedEventIds: [...outputCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort(),
    groups: decompositions.map((group, index) => ({
      index,
      sourceVoice: group.sourceVoice,
      complete: group.complete,
      maxPolyphony: group.maxPolyphony,
      laneCount: group.lanes.length,
      inputEventCount: group.inputEventIds.length,
      outputEventCount: group.outputEventIds.length,
      lanes: group.lanes.map(lane => ({
        index: lane.index,
        averagePitchExact: lane.averagePitchExact,
        chainIds: [...lane.chainIds],
        noteCount: lane.notes.length,
        eventIds: lane.notes.map(note => note.eventId),
        segments: lane.segments.map(segment => ({ ...segment })),
        // Lane adjacency is a packing fact. A junction across real silence is
        // never evidence that one continuous voice was found.
        silenceJunctions: lane.junctions.filter(junction => junction.silence).map(junction => ({ from: junction.from, to: junction.to })),
      })),
      diagnostics: group.diagnostics.map(item => ({ ...item })),
    })),
    notice: 'G11-B decomposes source voices into monophonic lanes. It assigns no musical role, deletes nothing, and merges nothing.',
  };
}

// The candidate, bound to the exact bytes and event set it was derived from. If
// either moves, `arrangementBinding` reports it stale and the reader is told,
// rather than a stale reading being presented as current.
export function deriveArrangement(project, { sourceSha256, pipeline = RAW_MIDI_PIPELINE } = {}) {
  const decompositions = splitProjectSourceVoices(project);
  const candidate = suggestRoleCandidates(project);
  return {
    schema: 'mml-studio-web/raw-midi-arrangement@1',
    pipeline,
    // Stated as data so no reader has to infer it from the absence of a flag.
    stage: 'G11-C',
    stageKind: 'ARRANGEMENT_CANDIDATE',
    accepted: false,
    certifiesGates: [],
    derivation: {
      sourceSha256: sourceSha256 ?? null,
      projectId: project.id ?? null,
      eventCount: project.events.length,
      eventIdDigest: digestOf(project.events.map(event => event.id).join('\n')),
    },
    voiceSplit: voiceSplitReport(decompositions),
    candidate,
    notice: 'A G11-C suggestion over a Source-Faithful Baseline. It is not an accepted arrangement, it does not modify the source project, and it certifies no ACCEPTANCE_CRITERIA.md gate.',
  };
}

// Whether an arrangement describes the asset it is stored next to.
//
// Nothing in this integration persists an arrangement -- `analyzeWorkspace`
// re-derives it from the source project every time, so what is on screen is
// current by construction. This exists for the other direction: a restored or
// imported record may still carry one, written by an older pipeline or bound to
// bytes that are no longer these. Such a record is data, never a result, and
// this is what lets the reader be told so instead of being shown it.
export function arrangementBinding(asset, arrangement = asset?.arrangement ?? null) {
  if (!arrangement) return { current: false, reasons: ['ARRANGEMENT_MISSING'] };
  const reasons = [];
  if (arrangement.pipeline !== RAW_MIDI_PIPELINE) reasons.push('ARRANGEMENT_PIPELINE_VERSION_CHANGED');
  if (arrangement.derivation?.sourceSha256 !== asset.source?.sha256) reasons.push('ARRANGEMENT_SOURCE_BYTES_CHANGED');
  if (arrangement.derivation?.projectId !== asset.project?.id) reasons.push('ARRANGEMENT_PROJECT_CHANGED');
  const events = asset.project?.events ?? [];
  if (arrangement.derivation?.eventCount !== events.length) reasons.push('ARRANGEMENT_EVENT_COUNT_CHANGED');
  else if (arrangement.derivation?.eventIdDigest !== digestOf(events.map(event => event.id).join('\n'))) reasons.push('ARRANGEMENT_EVENT_IDENTITY_CHANGED');
  return { current: reasons.length === 0, reasons };
}

// The stored bytes, the stored digest and the digest recorded inside the
// Canonical source record must all describe one byte sequence. Anything else
// means the persisted record cannot be trusted to identify its own source.
export function verifySourceBytes(asset) {
  const source = asset?.source ?? null;
  if (!source || typeof source.bytesBase64 !== 'string') return { verified: false, reasons: ['SOURCE_BYTES_MISSING'] };
  const reasons = [];
  let bytes = null;
  try { bytes = decodeSourceBytes(source.bytesBase64); }
  catch (error) { return { verified: false, reasons: [error.message] }; }
  if (bytes.length !== source.byteLength) reasons.push('SOURCE_BYTE_LENGTH_MISMATCH');
  const digest = sha256Hex(bytes);
  if (digest !== source.sha256) reasons.push('SOURCE_DIGEST_MISMATCH');
  const canonicalSource = asset.project?.sources?.find(item => item.id === source.id) ?? null;
  if (!canonicalSource) reasons.push('SOURCE_NOT_IN_CANONICAL_PROJECT');
  else if (canonicalSource.sha256 !== digest) reasons.push('CANONICAL_SOURCE_DIGEST_MISMATCH');
  return { verified: reasons.length === 0, reasons, byteLength: bytes.length, sha256: digest, bytes: reasons.length === 0 ? bytes : null };
}

// Re-reads the stored bytes through the real adapter and checks that what they
// decode to is what the record says they decoded to.
//
// Without this, a stored asset's own fields would be the analysis's source of
// truth: a record whose `complete` was flipped to true and whose `unsupported`
// evidence was emptied would read as a clean source, because every consumer
// downstream reads those fields. Re-deriving makes the bytes the authority and
// the stored fields a claim that has to agree with them.
//
// The freshly ingested project is used only for comparison. The analysis keeps
// running on the stored project that readCanonical already re-validated, so
// event identity -- which recorded evidence is bound to -- never depends on
// re-ingestion happening to agree.
export function verifyStoredProject(asset, validatedProject) {
  const verdict = verifySourceBytes(asset);
  if (!verdict.verified) return { verified: false, reasons: verdict.reasons, complete: null, unsupported: null };
  let fresh;
  try {
    fresh = ingestMIDI(verdict.bytes, {
      sourceId: asset.source.id,
      label: asset.name,
      kind: asset.source.kind,
      authority: asset.source.authority,
      sha256: verdict.sha256,
    });
  } catch (error) {
    // Bytes that no longer parse cannot support any claim the record makes.
    return { verified: false, reasons: [`SOURCE_BYTES_NO_LONGER_PARSE: ${error.message}`], complete: null, unsupported: null };
  }
  const reasons = [];
  const rebuilt = midiFragmentToProject(fresh);
  if (JSON.stringify(rebuilt) !== JSON.stringify(validatedProject)) reasons.push('STORED_PROJECT_DOES_NOT_MATCH_SOURCE_BYTES');
  if (asset.complete !== fresh.complete) reasons.push('STORED_COMPLETENESS_DOES_NOT_MATCH_SOURCE_BYTES');
  if ((asset.unsupported ?? []).length !== fresh.unsupported.length) reasons.push('STORED_UNSUPPORTED_EVIDENCE_DOES_NOT_MATCH_SOURCE_BYTES');
  return {
    verified: reasons.length === 0,
    reasons: [...verdict.reasons, ...reasons],
    sha256: verdict.sha256,
    byteLength: verdict.byteLength,
    // The verdict the bytes support, whatever the record claims.
    complete: fresh.complete,
    unsupported: fresh.unsupported.map(item => ({ ...item })),
    warnings: fresh.warnings.map(item => ({ ...item })),
    midi: midiFacts(fresh),
  };
}

// ─── intake ─────────────────────────────────────────────────────────────────

export function isRawMidiAsset(asset) {
  return asset?.format === MIDI_SOURCE_FORMAT;
}

// Sniffs the four header bytes. Used to route a file whose extension lies in
// either direction; the decoder still validates everything after them.
export function looksLikeMidi(input) {
  try {
    const bytes = toBytes(input);
    return bytes.length >= 4 && bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64;
  } catch { return false; }
}

export function ingestMidiSource({ name, bytes, id, authority = 'supporting' }) {
  const data = toBytes(bytes);
  if (!data.length) throw Error('UNSUPPORTED: empty MIDI file');
  if (data.length > MAX_MIDI_BYTES) throw Error(`UNSUPPORTED: MIDI file exceeds ${MAX_MIDI_BYTES / 1048576} MiB`);

  // Hashed over exactly the bytes handed to the decoder, so the identity can
  // never describe a different sequence than the one that was parsed.
  const sha256 = sha256Hex(data);
  const bytesBase64 = encodeSourceBytes(data);

  // SOURCE_POLICY.md §1C: a third-party MIDI is supporting evidence until it is
  // independently confirmed. Only an explicit caller claim raises it, and the
  // claim changes the source record -- never the completeness verdict below.
  const official = authority === 'primary-symbolic';
  const kind = official ? 'official-midi' : 'third-party-midi';
  const sourceId = id ?? `midi:${sha256.slice(0, 16)}`;

  const fragment = ingestMIDI(data, {
    sourceId,
    label: name,
    kind,
    authority: official ? 'primary-symbolic' : 'supporting',
    sha256,
  });
  const project = midiFragmentToProject(fragment);

  if (project.events.length > MAX_CANONICAL_EVENTS) {
    throw Error(`UNSUPPORTED: this MIDI yields ${project.events.length} Canonical events; the local analysis limit is ${MAX_CANONICAL_EVENTS}. The file was not accepted and the current source is unchanged.`);
  }

  return {
    name,
    format: MIDI_SOURCE_FORMAT,
    project,
    // Straight from the backend fragment. There is deliberately no path by
    // which a caller argument reaches this field.
    complete: fragment.complete,
    warnings: fragment.warnings.map(item => ({ ...item })),
    errors: [],
    unsupported: fragment.unsupported.map(item => ({ ...item })),
    source: {
      id: sourceId,
      kind,
      authority: fragment.source.authority,
      sha256,
      byteLength: data.length,
      encoding: 'base64',
      bytesBase64,
    },
    midi: midiFacts(fragment),
    // No arrangement is stored. G11-B/G11-C are re-derived from this project on
    // every analysis, so a candidate can never be presented from a reading that
    // belongs to different bytes, and a workspace does not carry a multiple of
    // its own source in derived material.
  };
}

// Rebuilds an asset from persisted bytes rather than trusting a persisted
// project. Used by portable import, where the JSON is data of unknown
// provenance: whatever project it claims to carry, what is ingested is the
// byte sequence it also carries, and the digest has to agree.
export function reingestMidiAsset(asset, { id = null } = {}) {
  const source = asset?.source ?? null;
  if (!source || typeof source.bytesBase64 !== 'string') throw Error('UNSUPPORTED: MIDI source bytes are missing from this backup');
  const bytes = decodeSourceBytes(source.bytesBase64);
  const digest = sha256Hex(bytes);
  if (typeof source.sha256 === 'string' && source.sha256 !== digest) throw Error('SOURCE_DIGEST_MISMATCH: the backup\'s MIDI bytes do not match its recorded source identity');
  return ingestMidiSource({
    name: typeof asset.name === 'string' && asset.name.trim() ? asset.name : 'imported.mid',
    bytes,
    id: id ?? source.id,
    authority: source.authority === 'primary-symbolic' ? 'primary-symbolic' : 'supporting',
  });
}
