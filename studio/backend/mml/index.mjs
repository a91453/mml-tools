// Studio v1 compatibility adapter for the existing Workbench MML engine.
//
// IMPORTANT: dist/core.js is reusable implementation, not the Studio rules authority.
// The legacy parser currently contains known rule drift (for example 64th-note
// rejection and an obsolete Tempo ceiling). New Studio code must consult
// ../rules/index.mjs before treating a legacy validation result as a Final gate.
//
// We deliberately keep the exports available while migration is incremental so
// exact-rational parsing, MIDI/ABC readback, overlap analysis and regression work
// are not thrown away. Rule truth lives in EFFECTIVE_RULESET.

export * from '../../../dist/core.js';

export const MML_ENGINE_ADAPTER = Object.freeze({
  name: 'legacy-workbench-core',
  migrationStatus: 'compatibility-only-known-rule-drift',
  rulesAuthority: false,
  allowedForFinalGate: false,
  source: 'dist/core.js',
  ruleContract: '../rules/index.mjs',
});
