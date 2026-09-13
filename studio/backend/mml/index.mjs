// Studio v1 MML facade.
//
// Exact-rational timing, MIDI/ABC codecs, overlap analysis and other proven
// Workbench helpers remain reusable from dist/core.js. Canonical policy is
// discovered only through docs/CANONICAL_MANIFEST.md and defined by its pinned
// published human-readable rules; parser.mjs implements ingest parsing plus
// Final validation without allowing the legacy profile to silently redefine rules.

import { EFFECTIVE_RULESET } from '../rules/index.mjs';

export * from '../../../dist/core.js';
export {
  STUDIO_MML_PROFILE,
  splitMML,
  parseTrack,
  validateMML,
} from './parser.mjs';

export const MML_ENGINE_ADAPTER = Object.freeze({
  name: 'studio-v1-with-published-canonical-manifest',
  migrationStatus: 'published-canonical-manifest-active',
  rulesEntryPoint: EFFECTIVE_RULESET.authority.entryPoint,
  canonical: EFFECTIVE_RULESET.canonical,
  rulesAuthority: EFFECTIVE_RULESET.authority.humanReadable,
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
