import {
  ingestMusicXML as ingestMusicXMLRaw,
  musicXMLFragmentToProject,
  classifyNavigationWords,
} from './musicxml.mjs';
import { isZipContainer, extractMusicXmlFromMxl, MXL_LIMITS, MxlError } from './mxl.mjs';

const NAVIGATION_MARKERS = Object.freeze([
  // The XML reader removes namespace prefixes, so this text-level check sees
  // the same local names. It is a cross-check on the structural reader: every
  // class found here must also have been read (and expanded or refused) there.
  ['REPEAT_BARLINE', /<(?:[^<>\s/:]+:)?repeat\b/i],
  ['VOLTA_ENDING', /<(?:[^<>\s/:]+:)?ending\b/i],
  ['SEGNO', /<(?:[^<>\s/:]+:)?segno\b/i],
  ['CODA', /<(?:[^<>\s/:]+:)?coda\b/i],
  ['DA_CAPO', /\bdacapo\s*=/i],
  ['DAL_SEGNO', /\bdalsegno\s*=/i],
  ['TO_CODA', /\btocoda\s*=/i],
  ['FINE_NAVIGATION', /\bfine\s*=/i],
]);

/** Navigation marker classes present anywhere in the MusicXML text. */
export function detectNavigationMarkers(xml) {
  if (typeof xml !== 'string') throw Error('MusicXML input must be a string');
  return Object.freeze(NAVIGATION_MARKERS
    .filter(([, pattern]) => pattern.test(xml))
    .map(([code]) => Object.freeze({
      code,
      message: 'MusicXML navigation/repeat structure is present in the text.',
    })));
}

// Retained name: callers used it before navigation was expanded. It now reports
// presence, not a failure; `ingestMusicXML` decides what was expanded.
export const detectUnexpandedNavigation = detectNavigationMarkers;

export function ingestMusicXML(xml, options = {}) {
  const present = detectNavigationMarkers(xml);
  const fragment = ingestMusicXMLRaw(xml, options);
  const read = new Set(fragment.navigationClassesSeen ?? []);
  const unaccounted = present.filter(item => !read.has(item.code));
  if (!unaccounted.length) return fragment;
  return Object.freeze({
    ...fragment,
    complete: false,
    unsupported: Object.freeze([...fragment.unsupported, ...unaccounted.map(item => Object.freeze({
      code: item.code,
      reason: 'NAVIGATION_MARKER_UNACCOUNTED',
      message: 'This navigation mark appears in the MusicXML text somewhere the reader does not interpret, so the playback order cannot be confirmed.',
    }))]),
  });
}

/**
 * Uploaded MusicXML bytes -> the XML text to ingest.
 *
 * A ZIP container (.mxl, detected by its magic bytes, never by a filename) is
 * opened through `META-INF/container.xml`; anything else is read as UTF-8
 * MusicXML. The bytes themselves stay the identity of the upload: `container`
 * records which entry the XML was derived from and that entry's own digest.
 */
export function decodeMusicXMLBytes(bytes, { maxTextBytes = null, mxlLimits = MXL_LIMITS } = {}) {
  if (!(bytes instanceof Uint8Array)) throw TypeError('MusicXML bytes must be a Uint8Array');
  if (isZipContainer(bytes)) {
    const { xml, container } = extractMusicXmlFromMxl(bytes, mxlLimits);
    return Object.freeze({ xml, container });
  }
  if (maxTextBytes !== null && bytes.byteLength > maxTextBytes) throw Error(`MusicXML text exceeds ${maxTextBytes} bytes`);
  let xml;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw Error('MusicXML is not valid UTF-8 text');
  }
  return Object.freeze({ xml, container: null });
}

export { musicXMLFragmentToProject, classifyNavigationWords, isZipContainer, extractMusicXmlFromMxl, MXL_LIMITS, MxlError };

export const SCORE_INGESTION_STATUS = Object.freeze({
  musicXmlPartwise: true,
  compressedMxl: true,
  exactDivisionsTiming: true,
  backupForwardVoices: true,
  chords: true,
  rests: true,
  tempoAndMeter: true,
  sourceProvenance: true,
  repeatExpansion: true,
  voltaEndings: true,
  segnoCodaFineJumps: true,
  pickupPlacement: true,
  graceRealization: false,
  transposingPartConcertPitch: false,
  microtonalPitch: false,
  unpitchedMapping: false,
  nestedJumps: false,
  timeOnlyNavigation: false,
});
