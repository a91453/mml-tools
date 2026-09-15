// Canonical-aware Final MML emitter — shared contract.
//
// Everything in this module is either read from the executable contract
// (`rules/index.mjs`) or *derived by asking the authoritative parser*. Nothing
// is transcribed. That distinction is the whole point: a second copy of the
// pitch table, the character limit or the 1/64 grid is a drift bug waiting to
// happen, and MOBILE_SYNTAX §11 step 8 requires the mapping from canonical
// output back to source decisions to stay reversible.
//
// This module holds no Canonical rule. It names published values and shapes
// results; `MASTER_RULES.md`, `MOBILE_SYNTAX.md`, `SOURCE_POLICY.md` and
// `ACCEPTANCE_CRITERIA.md` at the pinned rules snapshot remain the authority.
import { f } from '../mml/index.mjs';
import { EFFECTIVE_RULESET } from '../rules/index.mjs';
import { parseTrack } from '../mml/parser.mjs';

const syntax = EFFECTIVE_RULESET.mobileSyntax;

// Result statuses. `ACCEPTANCE_CRITERIA.md` "Final state vocabulary" allows
// PASS / FAIL / PENDING / UNSUPPORTED / N/A; the emitter answers with the three
// that can describe a serialization attempt.
export const EMIT_STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  PENDING: 'PENDING',
});

export const DIAGNOSTIC_SEVERITY = Object.freeze({
  // A confirmed negative: this candidate cannot be Final-emitted as it stands.
  ERROR: 'error',
  // Unresolved Canonical/evidence question. Never resolved by guessing.
  PENDING: 'pending',
  // Reportable fact that does not block. Never used to smuggle a decision.
  NOTICE: 'notice',
});

export const EMIT_DIAGNOSTICS = Object.freeze({
  // --- input shape -------------------------------------------------------
  EVENT_ROLE_UNASSIGNED: 'EVENT_ROLE_UNASSIGNED',
  ROLE_POLYPHONY_UNSUPPORTED: 'ROLE_POLYPHONY_UNSUPPORTED',
  REST_OVERLAPS_NOTE: 'REST_OVERLAPS_NOTE',
  SILENCE_DERIVED_FROM_GAP: 'SILENCE_DERIVED_FROM_GAP',
  EVENT_VOLUME_MIXED_DECISION: 'EVENT_VOLUME_MIXED_DECISION',
  VOLUME_NOT_DECIDED: 'VOLUME_NOT_DECIDED',
  // --- Canonical / G10 ---------------------------------------------------
  MICRO_GAP_TECHNICAL_RESIDUE: 'MICRO_GAP_TECHNICAL_RESIDUE',
  MICRO_GAP_BLOCKED_PENDING: 'MICRO_GAP_BLOCKED_PENDING',
  SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE: 'SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE',
  READINESS_BLOCKED: 'READINESS_BLOCKED',
  IMPLEMENTATION_BLOCKED: 'IMPLEMENTATION_BLOCKED',
  PENDING_DECISIONS_PRESENT: 'PENDING_DECISIONS_PRESENT',
  // --- representability --------------------------------------------------
  DURATION_NOT_REPRESENTABLE: 'DURATION_NOT_REPRESENTABLE',
  DURATION_SEARCH_BUDGET_EXHAUSTED: 'DURATION_SEARCH_BUDGET_EXHAUSTED',
  PITCH_NOT_SPELLABLE: 'PITCH_NOT_SPELLABLE',
  PITCH_ABOVE_OFFICIAL_RANGE: 'PITCH_ABOVE_OFFICIAL_RANGE',
  VOLUME_OUT_OF_RANGE: 'VOLUME_OUT_OF_RANGE',
  // --- tempo -------------------------------------------------------------
  TEMPO_INITIAL_MISSING: 'TEMPO_INITIAL_MISSING',
  TEMPO_NOT_INTEGER: 'TEMPO_NOT_INTEGER',
  TEMPO_OUT_OF_FINAL_RANGE: 'TEMPO_OUT_OF_FINAL_RANGE',
  TEMPO_POSITION_NOT_STRICTLY_INCREASING: 'TEMPO_POSITION_NOT_STRICTLY_INCREASING',
  TEMPO_POSITION_BEYOND_ROLE_END: 'TEMPO_POSITION_BEYOND_ROLE_END',
  // --- delivery ----------------------------------------------------------
  CHARACTER_BUDGET_EXCEEDED: 'CHARACTER_BUDGET_EXCEEDED',
  ROUND_TRIP_PARSE_ERROR: 'ROUND_TRIP_PARSE_ERROR',
  ROUND_TRIP_MISMATCH: 'ROUND_TRIP_MISMATCH',
  NO_NON_EMPTY_ROLE: 'NO_NON_EMPTY_ROLE',
});

export function diagnostic(code, severity, message, details = {}) {
  return Object.freeze({ code, severity, message, ...details });
}

/**
 * Ask the authoritative parser what its own initial state is, instead of
 * repeating the literals it happens to use today. A probe track is the smallest
 * Final-valid track there is.
 */
function probe(raw) {
  const track = parseTrack(raw, 'Melody', { mode: 'final' });
  if (track.errors.length) throw Error(`parser probe unexpectedly failed for "${raw}": ${track.errors[0].message}`);
  return track;
}

// Note names the parser accepts, plus the two accidental spellings that land on
// a neighbouring octave. Which pitch each one *means* is never assumed here —
// it is read back out of the parser below.
const SPELLING_TEXTS = Object.freeze([
  'c', 'c+', 'd', 'd+', 'e', 'f', 'f+', 'g', 'g+', 'a', 'a+', 'b',
  // Octave-boundary enharmonics. Their value is that they reach a pitch without
  // moving the octave state, so a later note need not move back.
  'b+', 'c-',
]);

let cachedParserFacts = null;

/**
 * Derive every fact the serializer needs about the parser it must satisfy.
 *
 * `defaultVolume` / `defaultLength` are the parser's own initial state, so the
 * emitter knows which state tokens it is allowed to leave out. `spellingsByPitch`
 * is the inverse of the parser's forward pitch mapping, obtained by parsing each
 * candidate spelling rather than by restating `12 * (octave + 1) + …`. P6 keeps
 * that mapping an implementation mapping, and deriving it keeps this module from
 * accidentally asserting a second one.
 */
export function parserFacts() {
  if (cachedParserFacts) return cachedParserFacts;

  const plain = probe('t120o4c4');
  const defaultVolume = plain.events[0].volume;
  // `c` with no denominator takes the parser's default length. A token of plain
  // length n lasts 4/n quarter-note beats, so n = 4 / duration — computed as an
  // exact rational and only then required to be a whole number.
  const defaulted = probe('t120o4c');
  const derivedLength = f(4).div(f(defaulted.total));
  if (derivedLength.d !== 1n) throw Error('parser default length is not an integer denominator');
  const defaultLength = Number(derivedLength.n);

  const spellingsByPitch = new Map();
  for (let octave = syntax.octaveMin; octave <= syntax.octaveMax; octave += 1) {
    for (const text of SPELLING_TEXTS) {
      const track = parseTrack(`t120o${octave}${text}4`, 'Melody', { mode: 'final' });
      if (track.errors.length || track.events.length !== 1) continue;
      const { pitch } = track.events[0];
      if (!spellingsByPitch.has(pitch)) spellingsByPitch.set(pitch, []);
      spellingsByPitch.get(pitch).push(Object.freeze({ octave, text }));
    }
  }
  // Deterministic candidate order: shortest text first, then lower octave, then
  // lexicographic. Every search below improves only on strict `<`, so this order
  // alone fixes the output.
  for (const [pitch, list] of spellingsByPitch) {
    list.sort((left, right) => left.text.length - right.text.length
      || left.octave - right.octave
      || (left.text < right.text ? -1 : left.text > right.text ? 1 : 0));
    spellingsByPitch.set(pitch, Object.freeze(list));
  }

  cachedParserFacts = Object.freeze({
    defaultVolume,
    defaultLength,
    spellingsByPitch,
    octaveMin: syntax.octaveMin,
    octaveMax: syntax.octaveMax,
    volumeMin: syntax.volumeMin,
    volumeMax: syntax.volumeMax,
    tempoMin: syntax.tempoMin,
    tempoMax: syntax.tempoMax,
    officialPitchMax: syntax.numericNoteMax,
    characterLimit: syntax.perTrackCharacterLimit,
  });
  return cachedParserFacts;
}

export const DEFAULT_EMIT_OPTIONS = Object.freeze({
  cautionLengthOptIn: false,
  // Node budget for the duration search. Bounded by construction: exhaustion is
  // a structured fail-closed diagnostic, never a truncated or approximate answer.
  budget: 200000,
  // Tie segments per attack. A deeper chain costs characters, so a real score
  // never approaches this; it exists so a pathological duration cannot hang.
  maxTieSegments: 12,
  readiness: null,
});

export function normalizeEmitOptions(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw Error('emit options must be an object');
  }
  const budget = options.budget ?? DEFAULT_EMIT_OPTIONS.budget;
  const maxTieSegments = options.maxTieSegments ?? DEFAULT_EMIT_OPTIONS.maxTieSegments;
  if (!Number.isSafeInteger(budget) || budget <= 0) throw Error('budget must be a positive integer');
  if (!Number.isSafeInteger(maxTieSegments) || maxTieSegments <= 0) throw Error('maxTieSegments must be a positive integer');
  return Object.freeze({
    cautionLengthOptIn: options.cautionLengthOptIn === true,
    budget,
    maxTieSegments,
    readiness: options.readiness ?? null,
  });
}

// Release identity travels with every result so a report can never be read
// against the wrong rules snapshot. These are the metadata fields the Published
// Manifest fixes; nothing here re-derives or re-publishes them.
export function canonicalIdentity() {
  return EFFECTIVE_RULESET.canonical;
}

export const EMITTER_NOTICE = 'Emitter status is an implementation result, not a Canonical verdict. PASS means the candidate was serialized exactly and re-parsed to identical semantics under the authoritative Final parser; it does not certify source completeness, arrangement correctness, Canonical compliance or in-game acceptance. Character counts are JavaScript string lengths (PENDING P1). Emitted MML never uses Nxx (PENDING P3), never uses forbidden dotted forms (PENDING P5), and treats the octave mapping as an implementation mapping (PENDING P6).';
