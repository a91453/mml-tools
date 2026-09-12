// Studio v1 MML facade.
//
// Exact-rational timing, MIDI/ABC codecs, overlap analysis and other proven
// Workbench helpers remain reusable from dist/core.js. Studio parsing and Final
// technical validation, however, are explicitly overridden by parser.mjs so old
// profile rules cannot silently certify new output.

export * from '../../../dist/core.js';
export {
  STUDIO_MML_PROFILE,
  splitMML,
  parseTrack,
  validateMML,
} from './parser.mjs';

export const MML_ENGINE_ADAPTER = Object.freeze({
  name: 'studio-v1-with-legacy-codecs',
  migrationStatus: 'current-rule-parser-active',
  rulesAuthority: '../rules/index.mjs',
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
