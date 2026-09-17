// Legacy technical MML validation, as an Application Service operation.
//
// Status: IMPLEMENTATION NOTES. This is the business logic the three original
// MCP tools (`mml_service_info`, `mml_validate`, `mml_overlap_details`) used to
// carry inside the transport. It is moved here unchanged, so those tools become
// adapters over the Application Service like every other caller, and the same
// answer is reachable over HTTP without a second implementation.
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
//
// This operation deliberately does not require Published Canonical. It runs on
// the legacy `dist/core.js` engine, exactly as it did before, so an environment
// without the published Git history keeps the capability it already had instead
// of losing it to a layer that was supposed to be additive.

import { PROFILE, ROLES, VERSION, secondsAt, validateMML } from '../../../dist/core.js';
import { ERROR_CODES, fail } from './contracts.mjs';

export const LEGACY_CORE = Object.freeze({ version: VERSION, profile: PROFILE, roles: ROLES });

// The legacy gate vocabulary, unchanged. `technical_ok` is one axis of several
// and never implies the others: a PASS here is a Strict Mobile technical result
// and says nothing about the source, the recording, the player or the game.
const legacyGates = ok => Object.freeze({
  strict_mobile_technical: ok ? 'PASS' : 'FAIL',
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
    const rule = shape[key];
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

const runValidation = input => validateMML(input.mml, {
  meterText: input.meter_text,
  pickup: input.pickup,
  finalPartial: input.final_partial,
  drumText: input.drum_profile,
  programs: input.programs,
  title: input.title,
});

export function createTechnicalService({ serviceVersion }) {
  const report = (validation, offset = 0) => {
    const song = validation.song;
    return {
      service_version: serviceVersion,
      core_version: VERSION,
      profile: PROFILE,
      technical_ok: validation.ok,
      gates: legacyGates(validation.ok),
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
      estimated_seconds: validation.ok ? secondsAt(song.total, song.tempo) : null,
      tempo_map: song?.tempo ?? [],
      meter_map: song?.meter ?? [],
      bar_count: song?.bars.length ?? 0,
      pair_count: song?.review?.pairs.length ?? 0,
      pairs: pairSummary(song?.review),
      low_mid_interval_count: song?.review?.crowding.length ?? null,
      max_simultaneous_attacks: song?.review?.maxSimultaneousAttacks ?? null,
      changed_input: false,
      evidence_notice: '技術 PASS 只針對本 Strict Mobile profile。來源、鼓面證據、聽驗、播放器回讀及遊戲結果未由此服務確認。',
    };
  };

  return Object.freeze({
    /** Technical validation over a complete six-track MML string. */
    validate(input) {
      checkShape(input, TECHNICAL_INPUT);
      preflight(input);
      return report(runValidation(input), input.error_offset ?? 0);
    },

    /**
     * Paged same-pitch and low/mid interval detail.
     *
     * A validation failure returns the validation report instead, exactly as
     * the original tool did: there is no reviewed interval list for a song the
     * parser could not read.
     */
    overlapDetails(input) {
      checkShape(input, OVERLAP_INPUT);
      preflight(input);
      const validation = runValidation(input);
      if (!validation.ok) return report(validation, input.error_offset ?? 0);
      const review = validation.song.review;
      const items = [];
      if (input.kind !== 'low_mid_intervals') {
        for (const pair of review.pairs) for (const overlap of pair.overlaps) items.push({ category: 'same_pitch', left: pair.left, right: pair.right, ...overlap });
      }
      if (input.kind !== 'same_pitch') {
        for (const overlap of review.crowding) items.push({ category: 'low_mid_intervals', ...overlap });
      }
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 100;
      return {
        service_version: serviceVersion,
        core_version: VERSION,
        profile: PROFILE,
        technical_ok: true,
        gates: legacyGates(true),
        pair_count: 15,
        pairs: pairSummary(review),
        total_items: items.length,
        offset,
        limit,
        items: items.slice(offset, offset + limit),
        next_offset: offset + limit < items.length ? offset + limit : null,
        changed_input: false,
      };
    },
  });
}
