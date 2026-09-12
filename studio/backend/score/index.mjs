import {
  ingestMusicXML as ingestMusicXMLRaw,
  musicXMLFragmentToProject,
} from './musicxml.mjs';

const NAVIGATION_MARKERS = Object.freeze([
  ['REPEAT_BARLINE', /<repeat\b/i],
  ['VOLTA_ENDING', /<ending\b/i],
  ['SEGNO', /<segno\b/i],
  ['CODA', /<coda\b/i],
  ['DA_CAPO', /\bdacapo\s*=/i],
  ['DAL_SEGNO', /\bdalsegno\s*=/i],
  ['TO_CODA', /\btocoda\s*=/i],
  ['FINE_NAVIGATION', /\bfine\s*=/i],
]);

export function detectUnexpandedNavigation(xml) {
  if (typeof xml !== 'string') throw Error('MusicXML input must be a string');
  return Object.freeze(NAVIGATION_MARKERS
    .filter(([, pattern]) => pattern.test(xml))
    .map(([code]) => Object.freeze({
      code,
      message: 'MusicXML navigation/repeat structure is present but has not been expanded into canonical playback order.',
    })));
}

export function ingestMusicXML(xml, options = {}) {
  const navigation = detectUnexpandedNavigation(xml);
  const fragment = ingestMusicXMLRaw(xml, options);
  if (!navigation.length) return fragment;
  return Object.freeze({
    ...fragment,
    complete: false,
    unsupported: Object.freeze([...fragment.unsupported, ...navigation]),
  });
}

export { musicXMLFragmentToProject };

export const SCORE_INGESTION_STATUS = Object.freeze({
  musicXmlPartwise: true,
  exactDivisionsTiming: true,
  backupForwardVoices: true,
  chords: true,
  rests: true,
  tempoAndMeter: true,
  sourceProvenance: true,
  repeatExpansion: false,
  graceRealization: false,
  transposingPartConcertPitch: false,
  microtonalPitch: false,
  unpitchedMapping: false,
});
