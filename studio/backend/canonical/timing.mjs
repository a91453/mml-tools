// Factual timing provenance for Canonical events.
//
// This module records *how a time value came to exist*, never what it means.
// `origin` is descriptive: it says which module produced a start/end pair and
// from what, so a later reviewer can tell a notated symbol apart from an adapter
// reconstruction apart from tooling output. It is not a verdict. Nothing here
// classifies an interval as musical or technical, and no consumer may read a
// classification out of these values alone.
//
// It defines no Canonical rule and does not change the Canonical IR schema: the
// record lives inside the existing free-form `event.metadata` object, so a
// project written before this module remains valid and simply carries none.
import { f } from '../mml/index.mjs';

export const TIMING_ORIGINS = Object.freeze([
  // Read literally from a notated symbol in the source file.
  'source-notated',
  // Computed by the ingest adapter from notated symbols, but not itself notated.
  'source-derived',
  // Produced by project tooling rather than read from any source.
  'tool-derived',
]);

export const TIMING_ARTIFACT_KINDS = Object.freeze([
  'quantization-residue',
  'decomposition-residue',
  'synthetic-spacing',
]);

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

// An artifact attestation is the only way a module may state that a time value
// it created carries no musical meaning. It must be affirmed by construction —
// from the module's own transformation semantics — never inferred from a
// duration threshold, a statistical or quantization-looking pattern, a source
// type, or the fact that some tool touched the value. A module that cannot
// affirm it mechanically leaves this absent, and the interval stays unclassified.
function normalizeArtifact(artifact, adapter) {
  if (artifact === null || artifact === undefined) return null;
  if (typeof artifact !== 'object' || Array.isArray(artifact)) throw Error('timing.artifact must be null or an object');
  if (!TIMING_ARTIFACT_KINDS.includes(artifact.kind)) throw Error(`unsupported timing.artifact.kind: ${artifact.kind}`);
  const producedBy = nonEmpty(artifact.producedBy, 'timing.artifact.producedBy');
  // A module may attest only to residue it created itself. Nothing may
  // retro-label an interval it merely carried, copied, merged or re-validated.
  if (producedBy !== adapter) throw Error('timing.artifact.producedBy must be the attesting adapter');
  // Absence is never consent: the attestation has to be affirmed literally.
  if (artifact.carriesNoMusicalMeaning !== true) throw Error('timing.artifact.carriesNoMusicalMeaning must be literally true');
  return Object.freeze({
    kind: artifact.kind,
    producedBy,
    inputUnit: positiveRational(artifact.inputUnit, 'timing.artifact.inputUnit'),
    carriesNoMusicalMeaning: true,
  });
}

export function createTimingProvenance({ origin, adapter, unit = null, writtenForm = null, artifact = null }) {
  if (!TIMING_ORIGINS.includes(origin)) throw Error(`unsupported timing.origin: ${origin}`);
  adapter = nonEmpty(adapter, 'timing.adapter');
  return Object.freeze({
    origin,
    adapter,
    // Exact rational in whole-note units: the quantum the source encoded on.
    // `null` when the adapter cannot truthfully state one.
    unit: unit === null ? null : positiveRational(unit, 'timing.unit'),
    writtenForm: writtenForm === null ? null : nonEmpty(writtenForm, 'timing.writtenForm'),
    artifact: normalizeArtifact(artifact, adapter),
  });
}
