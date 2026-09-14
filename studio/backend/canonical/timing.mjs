// Factual timing provenance for Canonical events.
//
// This module records *how a time value came to exist*, never what it means.
// `origin` is descriptive: it says which module produced a value and from what,
// so a later reviewer can tell a notated symbol apart from an adapter
// reconstruction apart from tooling output. It is not a verdict. Nothing here
// classifies an interval as musical or technical, and no consumer may read a
// classification out of these values alone.
//
// Provenance is recorded per component — start, duration, end — because they
// are not established the same way. A MusicXML note's length is read literally
// from <duration> against <divisions>, while its onset is positional, so a
// single event-level origin would overstate what the file actually notates.
// Components are independently factual and are deliberately not ranked against
// each other: a format that notates absolute endpoints (MIDI note-on/note-off)
// legitimately yields notated start and end with a derived duration, which any
// cross-component rule would wrongly reject.
//
// It defines no Canonical rule and does not change the Canonical IR schema: the
// record lives inside the existing free-form `event.metadata` object, so a
// project written before this module remains valid and simply carries none.
//
// Deferred to C2 — technical-artifact attestation. A module that creates a
// meaning-free value may eventually need to say so, but such an attestation is
// only unambiguous once C2 defines interval identity: an inter-event gap
// belongs to a *pair* of events and has no home on a single event's metadata,
// so a field added here could not express it. It is therefore not implemented
// in C1 rather than half-implemented. When C2 adds it, it must carry an
// explicit target (duration / start / end / a named gap), and it must keep both
// guards this module was reviewed with: the attesting module has to be the one
// that produced the value, and the no-musical-meaning claim has to be affirmed
// literally — never inferred from a duration threshold, a statistical or
// quantization-looking pattern, a source type, or the fact that some tool
// touched the value.
import { f } from '../mml/index.mjs';

export const TIMING_ORIGINS = Object.freeze([
  // Read literally from a notated symbol in the source file.
  'source-notated',
  // Computed by the ingest adapter from notated symbols, but not itself notated.
  'source-derived',
  // Produced by project tooling rather than read from any source.
  'tool-derived',
]);

export const TIMING_COMPONENTS = Object.freeze(['start', 'duration', 'end']);

const nonEmpty = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw Error(`${label} must be a non-empty string`);
  return value.trim();
};

const positiveRational = (value, label) => {
  let result;
  try { result = f(value); }
  catch { throw Error(`${label} must be an exact rational-compatible value`); }
  if (result.cmp(0) <= 0) throw Error(`${label} must be > 0`);
  return result.toString();
};

function normalizeComponent(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${label} must be an object`);
  if (!TIMING_ORIGINS.includes(value.origin)) throw Error(`unsupported ${label}.origin: ${value.origin}`);
  return Object.freeze({
    origin: value.origin,
    // Exact rational in whole-note units: the quantum this component was
    // encoded on. `null` when the adapter cannot truthfully state one.
    unit: value.unit === null || value.unit === undefined ? null : positiveRational(value.unit, `${label}.unit`),
    writtenForm: value.writtenForm === null || value.writtenForm === undefined ? null : nonEmpty(value.writtenForm, `${label}.writtenForm`),
  });
}

// Every component must be stated explicitly. There is no default: an adapter
// that has not decided how a component came to exist has not finished reading.
export function createTimingProvenance({ adapter, start, duration, end }) {
  return Object.freeze({
    adapter: nonEmpty(adapter, 'timing.adapter'),
    start: normalizeComponent(start, 'timing.start'),
    duration: normalizeComponent(duration, 'timing.duration'),
    end: normalizeComponent(end, 'timing.end'),
  });
}
