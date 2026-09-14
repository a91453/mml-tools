// G11 source intake facade.
//
// Raw MIDI -> lossless evidence -> Canonical IR. Arrangement intelligence
// (voice splitting, track merging, role assignment, Core3/Full6 decomposition)
// is deliberately absent: `MASTER_RULES.md` §3 requires a diff-capable
// Source-Faithful Baseline to exist before any such transformation is accepted,
// and this module produces that baseline.

export { decodeMidiFile, toBytes, META_TYPES } from './midi-file.mjs';
export { ingestMIDI, midiFragmentToProject } from './midi.mjs';
export { sha256Hex } from './sha256.mjs';

// Factual capability record for this adapter. `false` means the adapter does
// not do the thing -- either because it is out of G11-A scope or because doing
// it would require evidence intake does not have. It never means the input was
// silently accepted as if it had been handled.
export const MIDI_INGESTION_STATUS = Object.freeze({
  // Implemented in G11-A.
  smfFormat0: true,
  smfFormat1: true,
  ppqDivision: true,
  runningStatus: true,
  noteOnVelocityZeroAsRelease: true,
  restruckNoteFifoMatching: true,
  exactRationalBeats: true,
  tempoMap: true,
  timeSignatureMap: true,
  // The program is snapshotted at each note-on, so a later program change on
  // the same channel cannot rewrite an earlier note's provenance, and program
  // state never crosses track boundaries. Proven by regression, not asserted.
  programChangeProvenance: true,
  programAtNoteOnset: true,
  // One event the Canonical schema cannot represent is recorded in
  // `unsupported`; it never aborts the ingest or removes other evidence.
  schemaRejectionIsolated: true,
  // source.sha256 is computed from the parsed bytes by default.
  sourceIdentitySha256: true,
  sustainPedalEvidence: true,
  sysexPreservedAsEvidence: true,
  unknownMetaPreservedAsEvidence: true,
  malformedTrackPartialEvidence: true,
  timingProvenance: true,
  sourceProvenance: true,

  // Not done here, by decision.
  smfFormat2: false,              // independent sequences; no shared timeline exists
  smfFormatAbove2: false,         // undefined by the spec; track relationship unknown
  smpteDivision: false,           // absolute time, not musical time
  velocityToMobileVolume: false,  // Gate 8 adaptation, not an intake fact
  sustainPedalNoteExtension: false, // performance interpretation
  percussionMapping: false,       // MASTER_RULES.md §8 needs drum-face evidence
  quantization: false,            // would erase source timing
  restSynthesis: false,           // gaps are not asserted to be notated rests
  voiceSplitting: false,          // deferred to G11-B
  trackMerging: false,            // deferred to G11-B
  roleAssignment: false,          // deferred to G11-B
  core3Decomposition: false,      // deferred to G11-C
});
