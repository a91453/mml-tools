// Studio v1 MML facade.
//
// Exact-rational timing, MIDI/ABC codecs, overlap analysis and other proven
// Workbench helpers remain reusable from dist/core.js. Canonical policy is
// defined by the human-readable docs; parser.mjs implements ingest parsing plus
// Final validation without allowing the legacy profile to silently redefine rules.

export * from '../../../dist/core.js';
export {
  STUDIO_MML_PROFILE,
  splitMML,
  parseTrack,
  validateMML,
} from './parser.mjs';

export const MML_ENGINE_ADAPTER = Object.freeze({
  name: 'studio-v1-with-canonical-draft2-alignment',
  migrationStatus: 'canonical-candidate-alignment-active',
  rulesAuthority: Object.freeze([
    '../../../docs/MASTER_RULES.md',
    '../../../docs/SOURCE_POLICY.md',
    '../../../docs/MOBILE_SYNTAX.md',
    '../../../docs/ACCEPTANCE_CRITERIA.md',
    '../../../docs/PENDING.md',
  ]),
  executableContract: '../rules/index.mjs',
  bareParseTrackMode: 'ingest',
  ingestParser: './parser.mjs#parseTrack',
  finalValidator: './parser.mjs#validateMML',
  // Compatibility alias retained for existing callers/tests. This points to the
  // owning module only; it is not permission to treat bare parseTrack() as Final.
  finalParser: './parser.mjs',
  legacyImplementation: '../../../dist/core.js',
  legacyParserAllowedForFinalGate: false,
  reusableLegacyAreas: Object.freeze([
    'exact-rational-arithmetic',
    'meter-and-bar-building',
    'cross-track-review',
    'midi-codec-and-readback',
    'abc-codec-and-readback',
  ]),
});
