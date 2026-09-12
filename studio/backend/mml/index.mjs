// Studio v1 adapter for the proven Workbench MML engine.
//
// Do not copy parser/validator logic into Studio while the legacy engine remains
// authoritative. This adapter gives Studio a stable import path and lets us
// replace the implementation later only after equivalent regression coverage.

export * from '../../../dist/core.js';

export const MML_ENGINE_ADAPTER = Object.freeze({
  name: 'legacy-workbench-core',
  migrationStatus: 'authoritative-v1',
  source: 'dist/core.js',
});
