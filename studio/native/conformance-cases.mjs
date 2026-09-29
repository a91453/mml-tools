// Cross-host conformance cases for the native core.
//
// Status: VERIFIER INPUT. Each case is a request to one native core operation.
// scripts/build-native-core.mjs answers every case on the Node server path — the
// technical service with the Git-loaded Published Canonical gate, the
// composition server/mcp.mjs serves mml_validate from — and writes the answers
// beside the bundle. The Node tests (tests/native-core.test.mjs) and the Swift
// tests (apps/ios/MMLKit) then require the bundled core to give exactly those
// answers on their own hosts.
//
// The cases record no expected verdict of their own. A case says what is asked,
// never what the rules say about it: the answer always comes from the Canonical
// implementation at build time, so these fixtures cannot become a second rule
// source or drift from the published release.
const fourFour = '0 4/4';
const sixtyFourths = `MML@t120o4l64${'c'.repeat(64)},,,,,;`;

export const NATIVE_CONFORMANCE_CASES = Object.freeze([
  { name: 'two-roles-whole-bars', operation: 'validate', request: { mml: 'MML@t120o4l4cdefgab>c,t120o3l2cegc,,,,;', meter_text: fourFour } },
  { name: 'tempo-above-255', operation: 'validate', request: { mml: 'MML@t256o4c1,,,,,;', meter_text: fourFour } },
  { name: 'one-bar-of-64ths', operation: 'validate', request: { mml: sixtyFourths, meter_text: fourFour } },
  { name: 'undeclared-partial-final-bar', operation: 'validate', request: { mml: 'MML@t120o4l4cde,,,,,;', meter_text: fourFour } },
  { name: 'source-confirmed-pickup', operation: 'validate', request: { mml: 'MML@t120o4l4c<g>cdef1,,,,,;', meter_text: fourFour, pickup: '1' } },
  { name: 'numeric-note-without-opt-in', operation: 'validate', request: { mml: 'MML@t120o4l4n60n62n64n65,,,,,;', meter_text: fourFour } },
  { name: 'tempo-map-mismatch', operation: 'validate', request: { mml: 'MML@t120o4c1,t121o4e1,,,,;', meter_text: fourFour } },
  { name: 'missing-octave-before-first-note', operation: 'validate', request: { mml: 'MML@t120l4cdef,,,,,;', meter_text: fourFour } },
  { name: 'not-a-six-role-string', operation: 'validate', request: { mml: 'hello', meter_text: fourFour } },
  { name: 'five-roles-only', operation: 'validate', request: { mml: 'MML@t120o4c1,,,,;', meter_text: fourFour } },
  { name: 'meter-change-and-programs', operation: 'validate', request: { mml: 'MML@t120o4l4cdefgab,t120o3l4cdefgab,,,,;', meter_text: '0 4/4\n4 3/4', programs: [0, 1, 2, 3, 4, 5], title: '拍號切換' } },
  { name: 'missing-meter-is-refused', operation: 'validate', request: { mml: 'MML@t120o4c1,,,,,;' } },
  { name: 'four-digit-value-is-refused', operation: 'validate', request: { mml: 'MML@t1200o4c1,,,,,;', meter_text: fourFour } },
  { name: 'unknown-field-is-refused', operation: 'validate', request: { mml: 'MML@t120o4c1,,,,,;', meter_text: fourFour, tempo: 120 } },
  { name: 'same-pitch-overlap-details', operation: 'overlapDetails', request: { mml: 'MML@t120o4l2cc,t120o4l2ce,t120o3l2b>c,,,;', meter_text: fourFour } },
]);
