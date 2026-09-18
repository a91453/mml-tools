// Technical MML validation, as an Application Service operation.
//
// Status: IMPLEMENTATION NOTES. This is the business logic the three original
// MCP tools (`mml_service_info`, `mml_validate`, `mml_overlap_details`) used to
// carry inside the transport. It is an adapter over the Application Service
// like every other caller, so the same answer is reachable over HTTP without a
// second implementation.
//
// Two validators, one of which is authoritative
// ---------------------------------------------
// This module holds two engines, and the whole point of the split is that they
// are never interchangeable:
//
//   * `validate()` / `overlapDetails()` are the **Published Canonical** answer.
//     They route to `backend/mml/parser.mjs`, the validator the Manifest-pinned
//     rules snapshot designates, through the Canonical gate. A caller asking
//     for Strict Mobile / current Canonical validation reaches this one.
//
//   * `legacyValidate()` / `legacyOverlapDetails()` are a **legacy diagnostic**
//     over `dist/core.js`. They are retained because the legacy engine reads
//     songs the published rules release has since re-judged, and seeing that
//     difference is useful. They are not a Canonical verdict and never claim to
//     be one.
//
// The two genuinely disagree, in both directions, which is why the legacy
// engine may not stand in for the Canonical one:
//
//     MML@t256o4c1,,,,,;      legacy PASS        Canonical FAIL (TEMPO_OUT_OF_RANGE)
//     a 4/4 bar built from l64/64th notes
//                             legacy FAIL        Canonical PASS
//
// So a legacy report carries `technical_ok: null`, a `legacy_technical_ok`
// boolean of its own, `authority: 'LEGACY_DIAGNOSTIC'`, and a
// `strict_mobile_technical` gate of `NOT_RUN`. A legacy PASS can therefore not
// be read — by a client, a model, or a later refactor — as a Published
// Canonical PASS.
//
// When Published Canonical cannot be loaded, the Canonical operations fail
// closed with `CANONICAL_NOT_LOADED`. They do not fall back to the legacy
// engine: a fallback would answer a Canonical question with a non-Canonical
// verdict, which is exactly the routing defect this split exists to close.
//
// Two things are deliberately preserved byte-for-byte rather than modernized:
//
//   * the report shape and its `gates` vocabulary. Existing clients and the
//     existing regression suite read these exact fields, and renaming them
//     would be a breaking change dressed up as a cleanup. The newer Canonical
//     gate axes in `contracts.mjs` are a different vocabulary for a different
//     pipeline; neither is converted into the other;
//   * the three-digit preflight bound. It protects the rational parser from
//     pathological integers and is not a musical rule.

import { PROFILE, ROLES, VERSION, secondsAt, validateMML as legacyValidateMML } from '../../../dist/core.js';
import { ERROR_CODES, StudioApplicationError, fail } from './contracts.mjs';

export const LEGACY_CORE = Object.freeze({ version: VERSION, profile: PROFILE, roles: ROLES });

// What produced a report. A caller that must not act on a non-Canonical verdict
// checks this field rather than inferring authority from the gate vocabulary.
export const TECHNICAL_AUTHORITY = Object.freeze({
  CANONICAL: 'PUBLISHED_CANONICAL',
  LEGACY: 'LEGACY_DIAGNOSTIC',
});

// The legacy gate vocabulary, unchanged for the Canonical report.
// `strict_mobile_technical` is one axis of several and never implies the
// others: a PASS here is a Strict Mobile technical result under the published
// rules snapshot and says nothing about the source, the recording, the player
// or the game.
const canonicalGates = ok => Object.freeze({
  strict_mobile_technical: ok ? 'PASS' : 'FAIL',
  original_source_identity: 'PENDING',
  original_audio_listening: 'PENDING',
  player_readback: 'NOT_RUN',
  in_game_acceptance: 'PENDING',
});

// The legacy diagnostic's gates. `strict_mobile_technical` is NOT_RUN because
// this engine did not run the published rules: the axis exists, and nothing
// answered it. `legacy_diagnostic` is the legacy engine's own result, named so
// that it cannot be mistaken for the axis above.
const legacyGates = ok => Object.freeze({
  strict_mobile_technical: 'NOT_RUN',
  legacy_diagnostic: ok ? 'PASS' : 'FAIL',
  original_source_identity: 'PENDING',
  original_audio_listening: 'PENDING',
  player_readback: 'NOT_RUN',
  in_game_acceptance: 'PENDING',
});

const pairSummary = review => review?.pairs.map(pair => ({
  left: pair.left,
  right: pair.right,
  status: pair.status,
  overlap_count: pair.overlaps.length,
})) ?? [];

// The argument shape the three original tools declare over MCP, enforced here
// so that every transport refuses the same malformed request the same way. A
// request that is not a technical-check request must not be graded as one: a
// FAIL report over a missing `mml` reads to a caller as a verdict about a song.
// The numbers below are the MCP schema's numbers; the two must stay equal.
export const TECHNICAL_INPUT = Object.freeze({
  mml: { type: 'string', min: 1, max: 40000 },
  meter_text: { type: 'string', min: 1, max: 2048 },
  pickup: { type: 'string', max: 32 },
  final_partial: { type: 'string', max: 32 },
  drum_profile: { type: 'string', max: 4096 },
  programs: { type: 'programs' },
  title: { type: 'string', max: 120 },
  error_offset: { type: 'integer', min: 0, max: 100000 },
});
export const OVERLAP_INPUT = Object.freeze({
  ...TECHNICAL_INPUT,
  offset: { type: 'integer', min: 0, max: 100000 },
  limit: { type: 'integer', min: 1, max: 200 },
  kind: { type: 'enum', values: ['all', 'same_pitch', 'low_mid_intervals'] },
});
const REQUIRED = Object.freeze(['mml', 'meter_text']);

function checkShape(input, shape) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(ERROR_CODES.INVALID_REQUEST, 'A technical check takes a JSON object.');
  for (const key of REQUIRED) if (input[key] === undefined) fail(ERROR_CODES.INVALID_REQUEST, `${key} is required`, { required: REQUIRED });
  for (const [key, value] of Object.entries(input)) {
    // Own keys only: a JSON key such as `__proto__` or `constructor` resolves
    // through the prototype and is not an accepted field either.
    const rule = Object.hasOwn(shape, key) ? shape[key] : null;
    if (!rule) fail(ERROR_CODES.INVALID_REQUEST, `${key} is not an accepted technical-check field`, { accepted: Object.keys(shape) });
    if (value === undefined) continue;
    if (rule.type === 'string') {
      if (typeof value !== 'string' || value.length < (rule.min ?? 0) || value.length > rule.max) fail(ERROR_CODES.INVALID_REQUEST, `${key} must be a string of ${rule.min ?? 0}–${rule.max} characters`);
    } else if (rule.type === 'integer') {
      if (!Number.isSafeInteger(value) || value < rule.min || value > rule.max) fail(ERROR_CODES.INVALID_REQUEST, `${key} must be an integer from ${rule.min} to ${rule.max}`);
    } else if (rule.type === 'enum') {
      if (!rule.values.includes(value)) fail(ERROR_CODES.INVALID_REQUEST, `${key} must be one of ${rule.values.join(', ')}`, { accepted: rule.values });
    } else if (rule.type === 'programs') {
      if (!Array.isArray(value) || value.length !== 6 || value.some(item => !Number.isSafeInteger(item) || item < 0 || item > 127)) fail(ERROR_CODES.INVALID_REQUEST, 'programs must be six integers from 0 to 127');
    }
  }
}

function preflight(input) {
  if (/\d{4}/.test(input.mml)) fail(ERROR_CODES.INVALID_REQUEST, 'MML 數值超過本服務的三位數安全界限；Strict Mobile 指令不需要四位數數值。');
  for (const key of ['meter_text', 'pickup', 'final_partial']) {
    if (/\d{10}/.test(input[key] ?? '')) fail(ERROR_CODES.INVALID_REQUEST, `${key} 數值過長。`);
  }
  for (const key of ['pickup', 'final_partial']) {
    const value = input[key] ?? '';
    if (value && !/^\d+(?:\/\d+|\.\d{1,9})?$/.test(value)) fail(ERROR_CODES.INVALID_REQUEST, `${key} 需為非負整數、小數或分數。`);
  }
}

const settingsOf = input => ({
  meterText: input.meter_text,
  pickup: input.pickup,
  finalPartial: input.final_partial,
  drumText: input.drum_profile,
  programs: input.programs,
  title: input.title,
});

export function createTechnicalService({ serviceVersion, canonical = null }) {
  // The Published Canonical validator, or a fail-closed refusal. There is no
  // third outcome: an unavailable Canonical never resolves to the legacy
  // engine, because a legacy verdict is not an answer to a Canonical question.
  const canonicalValidator = async () => {
    if (!canonical || typeof canonical.engines !== 'function') {
      throw new StudioApplicationError(
        ERROR_CODES.CANONICAL_NOT_LOADED,
        'CANONICAL_NOT_LOADED: this technical service was built without the Published Canonical gate, so it cannot answer a Canonical validation request. The legacy diagnostic is reachable separately and is not a Canonical verdict.',
        { legacy_fallback_allowed: false },
      );
    }
    const engines = await canonical.engines();
    const validate = engines?.mml?.validateMML;
    if (typeof validate !== 'function') {
      throw new StudioApplicationError(
        ERROR_CODES.ENGINE_UNAVAILABLE,
        'ENGINE_UNAVAILABLE: the Canonical MML validator was not exported by the loaded engines.',
        { legacy_fallback_allowed: false },
      );
    }
    return { validate, profile: engines.mml.STUDIO_MML_PROFILE ?? PROFILE };
  };

  const report = (validation, offset, { authority, profile }) => {
    const song = validation.song;
    const ok = validation.ok === true;
    const canonicalAuthority = authority === TECHNICAL_AUTHORITY.CANONICAL;
    return {
      service_version: serviceVersion,
      core_version: VERSION,
      profile,
      authority,
      // A legacy diagnostic states no Canonical technical verdict at all. The
      // field stays present so the shape is stable, and stays null so no caller
      // can read a legacy PASS as `technical_ok`.
      technical_ok: canonicalAuthority ? ok : null,
      ...(canonicalAuthority ? {} : { legacy_technical_ok: ok }),
      gates: canonicalAuthority ? canonicalGates(ok) : legacyGates(ok),
      error_count: validation.errors.length,
      errors: validation.errors.slice(offset, offset + 200),
      error_offset: offset,
      next_error_offset: offset + 200 < validation.errors.length ? offset + 200 : null,
      warnings: validation.warnings,
      tracks: song?.tracks.map(track => ({
        role: track.role,
        empty: track.empty,
        characters: track.characters,
        character_limit: 2400,
        total_beats: track.total,
        note_events: track.events.length,
        error_count: track.errors.length,
      })) ?? [],
      total_beats: song?.total ?? null,
      estimated_seconds: ok ? secondsAt(song.total, song.tempo) : null,
      tempo_map: song?.tempo ?? [],
      meter_map: song?.meter ?? [],
      bar_count: song?.bars.length ?? 0,
      pair_count: song?.review?.pairs.length ?? 0,
      pairs: pairSummary(song?.review),
      low_mid_interval_count: song?.review?.crowding.length ?? null,
      max_simultaneous_attacks: song?.review?.maxSimultaneousAttacks ?? null,
      changed_input: false,
      evidence_notice: canonicalAuthority
        ? '技術 PASS 只針對 Published Canonical 的 Strict Mobile 技術面。來源、鼓面證據、聽驗、播放器回讀及遊戲結果未由此服務確認。'
        : 'LEGACY 診斷結果，非 Published Canonical 判定。legacy PASS 不等於 Canonical PASS；請以 Canonical 端點的 technical_ok 為準。',
    };
  };

  const overlapReport = (review, input, { authority, profile }) => {
    const items = [];
    if (input.kind !== 'low_mid_intervals') {
      for (const pair of review.pairs) for (const overlap of pair.overlaps) items.push({ category: 'same_pitch', left: pair.left, right: pair.right, ...overlap });
    }
    if (input.kind !== 'same_pitch') {
      for (const overlap of review.crowding) items.push({ category: 'low_mid_intervals', ...overlap });
    }
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;
    const canonicalAuthority = authority === TECHNICAL_AUTHORITY.CANONICAL;
    return {
      service_version: serviceVersion,
      core_version: VERSION,
      profile,
      authority,
      technical_ok: canonicalAuthority ? true : null,
      ...(canonicalAuthority ? {} : { legacy_technical_ok: true }),
      gates: canonicalAuthority ? canonicalGates(true) : legacyGates(true),
      pair_count: 15,
      pairs: pairSummary(review),
      total_items: items.length,
      offset,
      limit,
      items: items.slice(offset, offset + limit),
      next_offset: offset + limit < items.length ? offset + limit : null,
      changed_input: false,
    };
  };

  return Object.freeze({
    /**
     * Published Canonical technical validation over a complete six-track MML
     * string. Fails closed when Canonical is unavailable.
     */
    async validate(input) {
      checkShape(input, TECHNICAL_INPUT);
      preflight(input);
      const { validate, profile } = await canonicalValidator();
      return report(validate(input.mml, settingsOf(input)), input.error_offset ?? 0, { authority: TECHNICAL_AUTHORITY.CANONICAL, profile });
    },

    /**
     * Paged same-pitch and low/mid interval detail, under Published Canonical.
     *
     * A validation failure returns the validation report instead, exactly as
     * the original tool did: there is no reviewed interval list for a song the
     * parser could not read.
     */
    async overlapDetails(input) {
      checkShape(input, OVERLAP_INPUT);
      preflight(input);
      const { validate, profile } = await canonicalValidator();
      const validation = validate(input.mml, settingsOf(input));
      const meta = { authority: TECHNICAL_AUTHORITY.CANONICAL, profile };
      if (!validation.ok) return report(validation, input.error_offset ?? 0, meta);
      return overlapReport(validation.song.review, input, meta);
    },

    /**
     * The legacy `dist/core.js` engine, as an explicitly labelled diagnostic.
     *
     * Retained so an environment without the published Git history keeps the
     * capability it already had, and so the difference between the legacy
     * engine and the published rules stays observable. Its PASS is not a
     * Published Canonical PASS and the report says so in three places:
     * `authority`, `technical_ok: null`, and `gates.strict_mobile_technical`.
     */
    legacyValidate(input) {
      checkShape(input, TECHNICAL_INPUT);
      preflight(input);
      return report(legacyValidateMML(input.mml, settingsOf(input)), input.error_offset ?? 0, { authority: TECHNICAL_AUTHORITY.LEGACY, profile: PROFILE });
    },

    /** Paged overlap detail from the legacy engine, labelled as a diagnostic. */
    legacyOverlapDetails(input) {
      checkShape(input, OVERLAP_INPUT);
      preflight(input);
      const validation = legacyValidateMML(input.mml, settingsOf(input));
      const meta = { authority: TECHNICAL_AUTHORITY.LEGACY, profile: PROFILE };
      if (!validation.ok) return report(validation, input.error_offset ?? 0, meta);
      return overlapReport(validation.song.review, input, meta);
    },
  });
}
