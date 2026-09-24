import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { F, f } from '../mml/index.mjs';
import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalRestEvent,
  createCanonicalTempoEvent,
  createCanonicalMeterEvent,
  createCanonicalProject,
} from '../canonical/index.mjs';
import { createTimingProvenance } from '../canonical/timing.mjs';
import { normalizeControlEvents, controlConflictDiagnostic } from '../canonical/control-map.mjs';
import { planPlayback, NAVIGATION_CODES } from './navigation.mjs';

// MusicXML (score-partwise) -> Canonical IR, in playback order.
//
// Three passes:
//
//   1. scan: every part is read in WRITTEN order. Divisions, meter and tempo
//      carry forward the way the notation carries them, and each measure is
//      reduced to measure-local exact offsets plus the navigation it writes.
//   2. plan: `navigation.mjs` turns repeats, voltas and jumps into the order the
//      measures are played. A plan it cannot justify is refused and the written
//      order is kept, with the source marked incomplete and the reason named.
//   3. layout: measures are placed on one timeline shared by every part, in
//      plan order. Nothing is quantized, padded or re-timed inside a measure.
//
// Identity: an event keeps the id it has always had on the first pass through
// its written measure. A later pass through the same written measure appends
// `:pass<N>` to the id and `/pass:<N>` to the source event path, and carries
// `pass`, `playbackMeasureIndex` and `writtenSourceEventId` in its metadata, so
// every played event traces back to exactly one written note or rest.

const MUSICXML_ADAPTER = 'studio/backend/score/musicxml.mjs';
const MAX_XML_CHARS = 20_000_000;
const STEP_TO_SEMITONE = Object.freeze({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 });
const BEAT_UNIT_QUARTERS = Object.freeze({
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
  '64th': 0.0625,
});

// The navigation classes the text-level guard in `score/index.mjs` looks for.
// The scan records which of them it actually read, so a marker placed where
// this reader does not look is reported instead of silently ignored.
export const NAVIGATION_CLASSES = Object.freeze({
  REPEAT: 'REPEAT_BARLINE',
  ENDING: 'VOLTA_ENDING',
  SEGNO: 'SEGNO',
  CODA: 'CODA',
  DA_CAPO: 'DA_CAPO',
  DAL_SEGNO: 'DAL_SEGNO',
  TO_CODA: 'TO_CODA',
  FINE: 'FINE_NAVIGATION',
});

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
});

const nodeName = node => Object.keys(node ?? {}).find(key => key !== ':@') ?? null;
const attrs = node => node?.[':@'] ?? {};
const payload = node => {
  const name = nodeName(node);
  return name ? node[name] : [];
};
const childrenNamed = (list, name) => (Array.isArray(list) ? list.filter(node => Object.hasOwn(node, name)) : []);
const firstNamed = (list, name) => childrenNamed(list, name)[0] ?? null;
const hasNamed = (list, name) => Boolean(firstNamed(list, name));
const textNode = list => {
  const item = Array.isArray(list) ? list.find(node => Object.hasOwn(node, '#text')) : null;
  if (!item) return null;
  return String(item['#text']).trim();
};
const childText = (list, name) => {
  const child = firstNamed(list, name);
  return child ? textNode(payload(child)) : null;
};
const intText = (list, name, label) => {
  const value = childText(list, name);
  if (value === null) return null;
  if (!/^-?\d+$/.test(value)) throw Error(`${label} must be an integer; received ${value}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw Error(`${label} is outside the safe integer range`);
  return number;
};
const decimalText = (list, name, label) => {
  const value = childText(list, name);
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw Error(`${label} must be numeric; received ${value}`);
  return number;
};
const attr = (node, name) => attrs(node)[`@_${name}`] ?? null;
const maxF = (a, b) => f(a).cmp(b) >= 0 ? f(a) : f(b);
const sameMeter = (a, b) => Boolean(a && b && a.numerator === b.numerator && a.denominator === b.denominator);

function sanitizeXml(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw Error('MusicXML input must be a non-empty string');
  if (xml.length > MAX_XML_CHARS) throw Error(`MusicXML exceeds ${MAX_XML_CHARS.toLocaleString()} characters`);
  if (/<!ENTITY\b/i.test(xml) || /<!DOCTYPE[^>]*\[/i.test(xml)) throw Error('MusicXML internal entities / DTD subsets are not accepted');
  return xml.replace(/<!DOCTYPE\s+score-partwise\b[^>]*>/i, '');
}

function sourcePath(partId, measureIndex, sequence, kind) {
  return `part:${partId}/measure:${measureIndex + 1}/${kind}:${sequence}`;
}

function parseLyrics(noteChildren) {
  const lyrics = [];
  for (const lyricNode of childrenNamed(noteChildren, 'lyric')) {
    const lyricChildren = payload(lyricNode);
    const text = childText(lyricChildren, 'text');
    if (text) lyrics.push(text);
  }
  return lyrics;
}

function parseTieTypes(noteChildren) {
  return childrenNamed(noteChildren, 'tie')
    .map(node => attr(node, 'type'))
    .filter(Boolean);
}

function parsePartNames(rootChildren) {
  const result = new Map();
  const partList = firstNamed(rootChildren, 'part-list');
  if (!partList) return result;
  for (const scorePart of childrenNamed(payload(partList), 'score-part')) {
    const id = attr(scorePart, 'id');
    if (!id) continue;
    const name = childText(payload(scorePart), 'part-name') ?? id;
    result.set(id, name);
  }
  return result;
}

function detectTitle(rootChildren, fallback) {
  const movement = childText(rootChildren, 'movement-title');
  if (movement) return movement;
  const work = firstNamed(rootChildren, 'work');
  if (work) {
    const title = childText(payload(work), 'work-title');
    if (title) return title;
  }
  return fallback;
}

function parseMeter(timeNode, context) {
  const timeChildren = payload(timeNode);
  // A time element can contain several beats/beat-type pairs (e.g. 2/4 +
  // 3/8). This IR supports one simple signature, not a partial first pair.
  // Keep the source values visible and incomplete instead of inventing 2/4.
  const beatsValues = childrenNamed(timeChildren, 'beats').map(node => textNode(payload(node)));
  const beatTypes = childrenNamed(timeChildren, 'beat-type').map(node => textNode(payload(node)));
  if (hasNamed(timeChildren, 'senza-misura')) {
    context.unsupported.push({ code: 'UNMETERED_TIME', location: context.location });
    return null;
  }
  if (beatsValues.length !== 1 || beatTypes.length !== 1) {
    context.unsupported.push({ code: 'COMPLEX_METER', location: context.location, beats: beatsValues, beatTypes });
    return null;
  }
  const [beats] = beatsValues;
  const [beatType] = beatTypes;
  if (!/^\d+$/.test(beats) || !/^\d+$/.test(beatType)) {
    context.unsupported.push({ code: 'COMPLEX_METER', location: context.location, beats, beatType });
    return null;
  }
  return { numerator: Number(beats), denominator: Number(beatType) };
}

function parseMetronome(directionChildren, context) {
  // Words/dynamics often precede a metronome in the same direction. Inspect
  // every direction-type; a first-child lookup silently loses real Tempo.
  const metronomes = childrenNamed(directionChildren, 'direction-type')
    .flatMap(node => childrenNamed(payload(node), 'metronome'));
  if (!metronomes.length) return null;
  if (metronomes.length > 1) {
    context.unsupported.push({ code: 'MULTIPLE_METRONOME_MARKS', location: context.location });
    return null;
  }
  const [metronome] = metronomes;
  const metaChildren = payload(metronome);
  const unit = childText(metaChildren, 'beat-unit');
  const perMinute = decimalText(metaChildren, 'per-minute', 'metronome per-minute');
  if (!unit || perMinute === null || !(unit in BEAT_UNIT_QUARTERS)) return null;
  const dots = childrenNamed(metaChildren, 'beat-unit-dot').length;
  const factor = BEAT_UNIT_QUARTERS[unit] * (dots ? 2 - 1 / (2 ** dots) : 1);
  return perMinute * factor;
}

function parseMusicXmlTree(xml) {
  const cleaned = sanitizeXml(xml);
  const validation = XMLValidator.validate(cleaned, { allowBooleanAttributes: false });
  if (validation !== true) {
    const detail = validation?.err ? `${validation.err.msg} (line ${validation.err.line}, col ${validation.err.col})` : 'invalid XML';
    throw Error(`MusicXML syntax error: ${detail}`);
  }
  const parsed = parser.parse(cleaned);
  const root = Array.isArray(parsed) ? parsed.find(node => Object.hasOwn(node, 'score-partwise')) : null;
  if (!root) {
    if (Array.isArray(parsed) && parsed.some(node => Object.hasOwn(node, 'score-timewise'))) throw Error('score-timewise MusicXML is not supported in Studio v1; export score-partwise');
    throw Error('MusicXML root must be score-partwise');
  }
  return root;
}

// ─── navigation reading ────────────────────────────────────────────────────

// Notation glyphs some exporters embed in direction text (SMuFL private use
// area, and the Unicode segno/coda symbols). They are symbols, not words.
const GLYPH_CHARACTERS = /[-]|\u{1D10B}|\u{1D10C}/gu;

function wordsOf(directionChildren) {
  return childrenNamed(directionChildren, 'direction-type')
    .flatMap(node => childrenNamed(payload(node), 'words'))
    .map(node => textNode(payload(node)) ?? '')
    .join(' ')
    .replace(GLYPH_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The standard navigation wordings. Only read when no `<sound>` says it. */
export function classifyNavigationWords(text) {
  const words = String(text ?? '').toLowerCase().replace(GLYPH_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return null;
  const result = {
    jump: /^(?:d\.?\s?c\.?|da\s+capo)(?![a-z])/.test(words) ? 'dacapo'
      : /^(?:d\.?\s?s\.?|dal\s+segno)(?![a-z])/.test(words) ? 'dalsegno' : null,
    alFine: /\bal\s+fine\b/.test(words),
    alCoda: /\b(?:al\s+coda|e\s+poi\s+(?:la\s+)?coda)\b/.test(words),
    toCoda: /^to\s+coda\b/.test(words),
    fine: /^fine\.?$/.test(words),
    coda: /^coda\.?$/.test(words),
    playRepeats: /(?:^|\s)(?:with\s+repeats?|con\s+rip(?:\.|etizion[ei]|resa)?|con\s+ritornell[oi])(?![a-z])/.test(words),
  };
  return result;
}

function soundNavigation(sound) {
  if (!sound) return null;
  const read = name => attr(sound, name);
  return {
    dacapo: read('dacapo'),
    dalsegno: read('dalsegno'),
    tocoda: read('tocoda'),
    fine: read('fine'),
    segno: read('segno'),
    coda: read('coda'),
    forwardRepeat: read('forward-repeat'),
    timeOnly: read('time-only'),
  };
}

/**
 * Navigation written by one `<direction>` (or one measure-level `<sound>`).
 * Returns raw markers at `local`; their barline side is decided once the
 * measure's length is known.
 */
function readDirectionNavigation({ directionChildren = [], sound, local, nav, seen }) {
  const s = soundNavigation(sound);
  const types = childrenNamed(directionChildren, 'direction-type').map(payload);
  const glyphSegno = types.some(list => hasNamed(list, 'segno'));
  const glyphCoda = types.some(list => hasNamed(list, 'coda'));
  const words = wordsOf(directionChildren);
  const text = classifyNavigationWords(words);
  if (glyphSegno) seen.add(NAVIGATION_CLASSES.SEGNO);
  if (glyphCoda) seen.add(NAVIGATION_CLASSES.CODA);
  if (s) {
    if (s.dacapo !== null) seen.add(NAVIGATION_CLASSES.DA_CAPO);
    if (s.dalsegno !== null) seen.add(NAVIGATION_CLASSES.DAL_SEGNO);
    if (s.tocoda !== null) seen.add(NAVIGATION_CLASSES.TO_CODA);
    if (s.fine !== null) seen.add(NAVIGATION_CLASSES.FINE);
    if (s.segno !== null) seen.add(NAVIGATION_CLASSES.SEGNO);
    if (s.coda !== null) seen.add(NAVIGATION_CLASSES.CODA);
  }
  const soundJump = s && s.dacapo !== null && s.dacapo !== 'no' ? 'dacapo' : s && s.dalsegno !== null ? 'dalsegno' : null;
  const soundHasNavigation = Boolean(s && ['dacapo', 'dalsegno', 'tocoda', 'fine', 'segno', 'coda'].some(key => s[key] !== null && s[key] !== 'no'));
  const problem = (code, reason, message) => nav.problems.push({ code, reason, message });

  if (s?.forwardRepeat === 'yes') {
    nav.forwardRepeatSound = true;
    seen.add(NAVIGATION_CLASSES.REPEAT);
  }
  if (s?.timeOnly !== null && s?.timeOnly !== undefined && soundHasNavigation) {
    problem(NAVIGATION_CODES.PLAN, 'NAVIGATION_TIME_ONLY_UNSUPPORTED', `A navigation <sound> restricted to time-only="${s.timeOnly}" is not expanded.`);
    return;
  }
  if (s && s.dacapo !== null && s.dacapo !== 'no' && s.dalsegno !== null) {
    problem(NAVIGATION_CODES.DAL_SEGNO, 'CONFLICTING_JUMPS', 'One <sound> asks for both D.C. and D.S.');
    return;
  }

  let jump = null;
  if (soundJump) {
    if (text?.jump && text.jump !== soundJump) {
      problem(soundJump === 'dacapo' ? NAVIGATION_CODES.DA_CAPO : NAVIGATION_CODES.DAL_SEGNO, 'SOUND_AND_WORDS_DISAGREE', `The <sound> says ${soundJump} but the text reads "${words}".`);
      return;
    }
    jump = { kind: soundJump, label: soundJump === 'dalsegno' ? (s.dalsegno || null) : null, evidence: text?.jump ? 'sound+words' : 'sound' };
  } else if (!soundHasNavigation && text?.jump) {
    jump = { kind: text.jump, label: null, evidence: 'words' };
  }
  if (jump) {
    if (text?.alFine && text?.alCoda) {
      problem(jump.kind === 'dacapo' ? NAVIGATION_CODES.DA_CAPO : NAVIGATION_CODES.DAL_SEGNO, 'AL_FINE_AND_AL_CODA', `"${words}" names both Fine and Coda.`);
      return;
    }
    nav.raw.push({ type: 'jump', ...jump, variant: text?.alFine ? 'al-fine' : text?.alCoda ? 'al-coda' : null, playRepeats: text?.playRepeats === true, words, local });
  }
  const tocoda = s && s.tocoda !== null ? { label: s.tocoda || null, evidence: text?.toCoda ? 'sound+words' : 'sound' }
    : !soundHasNavigation && text?.toCoda ? { label: null, evidence: 'words' } : null;
  if (tocoda) nav.raw.push({ type: 'tocoda', ...tocoda, words, local });
  const fine = s && s.fine !== null && s.fine !== 'no' ? { evidence: text?.fine ? 'sound+words' : 'sound' }
    : !soundHasNavigation && text?.fine ? { evidence: 'words' } : null;
  if (fine) nav.raw.push({ type: 'fine', ...fine, label: null, words, local });

  // A glyph inside a jump's own text ("D.S. al Coda" with a segno sign, a
  // "To Coda" drawn as a coda sign) is part of that jump, not a target.
  if (jump || tocoda) {
    if (s && (s.segno !== null || s.coda !== null)) problem(NAVIGATION_CODES.PLAN, 'JUMP_AND_TARGET_IN_ONE_SOUND', 'One <sound> is both a jump and a jump target.');
    return;
  }
  if ((s && s.segno !== null) || glyphSegno) nav.raw.push({ type: 'segno', label: s?.segno || null, local });
  if ((s && s.coda !== null) || glyphCoda) nav.raw.push({ type: 'coda', label: s?.coda || null, evidence: s && s.coda !== null ? 'sound' : 'glyph', local });
  // The bare word "Coda" is often only a section title; it is recorded as a
  // candidate target and used only when a To Coda needs one.
  else if (!soundHasNavigation && text?.coda) nav.raw.push({ type: 'coda', label: null, evidence: 'words', local });
}

function readBarlineNavigation(barline, nav, seen) {
  const location = attr(barline, 'location') ?? 'right';
  const children = payload(barline);
  for (const repeat of childrenNamed(children, 'repeat')) {
    seen.add(NAVIGATION_CLASSES.REPEAT);
    nav.repeats.push({ direction: attr(repeat, 'direction'), times: attr(repeat, 'times'), location });
  }
  for (const ending of childrenNamed(children, 'ending')) {
    seen.add(NAVIGATION_CLASSES.ENDING);
    nav.endings.push({ number: attr(ending, 'number'), type: attr(ending, 'type'), location });
  }
  const side = location === 'left' ? 'start' : location === 'right' ? 'end' : 'middle';
  if (hasNamed(children, 'segno')) { seen.add(NAVIGATION_CLASSES.SEGNO); nav.markers.push({ type: 'segno', label: null, where: side }); }
  if (hasNamed(children, 'coda')) { seen.add(NAVIGATION_CLASSES.CODA); nav.markers.push({ type: 'coda', label: null, where: side }); }
}

// ─── pass 1: scan in written order ─────────────────────────────────────────

function scanPart(partNode, partIndex, { partNames, warnings, unsupported, seen }) {
  const partId = attr(partNode, 'id') ?? `P${partIndex + 1}`;
  const partName = partNames.get(partId) ?? partId;
  const measureNodes = childrenNamed(payload(partNode), 'measure');
  let divisions = null;
  let meterInForce = null;
  const measures = [];

  for (let measureIndex = 0; measureIndex < measureNodes.length; measureIndex++) {
    const measureNode = measureNodes[measureIndex];
    const measureNumber = attr(measureNode, 'number') ?? String(measureIndex + 1);
    const measureChildren = payload(measureNode);
    let cursor = f(0);
    let extent = f(0);
    let chordAnchor = null;
    let sequence = 0;

    const location = { partId, partName, measureNumber, measureIndex: measureIndex + 1 };
    const context = { unsupported, location };
    const record = {
      index: measureIndex,
      number: measureNumber,
      implicit: attr(measureNode, 'implicit'),
      meterAtStart: meterInForce,
      items: [],
      tempos: [],
      times: [],
      nav: { repeats: [], endings: [], markers: [], problems: [], forwardRepeatSound: false, raw: [] },
    };

    const readTempo = ({ sound, directionChildren, localPosition, kind }) => {
      const soundTempoRaw = sound ? attr(sound, 'tempo') : null;
      let bpm = soundTempoRaw !== null ? Number(soundTempoRaw) : null;
      if (bpm !== null && (!Number.isFinite(bpm) || bpm <= 0)) throw Error(`invalid sound tempo at ${partId} measure ${measureNumber}`);
      if (bpm === null && directionChildren) bpm = parseMetronome(directionChildren, context);
      if (bpm !== null) {
        record.tempos.push({ local: localPosition, bpm, sequence, kind, source: soundTempoRaw !== null ? 'sound-tempo' : 'metronome' });
      }
    };

    for (const child of measureChildren) {
      const name = nodeName(child);
      if (!name || name === '#text') continue;
      sequence++;

      if (name === 'attributes') {
        chordAnchor = null;
        const attributeChildren = payload(child);
        const newDivisions = intText(attributeChildren, 'divisions', 'MusicXML divisions');
        if (newDivisions !== null) {
          if (newDivisions <= 0) throw Error(`MusicXML divisions must be positive at ${partId} measure ${measureNumber}`);
          divisions = newDivisions;
        }

        for (const timeNode of childrenNamed(attributeChildren, 'time')) {
          const meter = parseMeter(timeNode, context);
          // An unsupported signature leaves the meter in force unknown rather
          // than letting an earlier one be restated over it later.
          meterInForce = meter ? { ...meter, measureIndex, sequence } : null;
          if (!meter) continue;
          record.times.push({ local: cursor, ...meter, sequence });
        }

        const transpose = firstNamed(attributeChildren, 'transpose');
        if (transpose) {
          const transposeChildren = payload(transpose);
          const chromatic = intText(transposeChildren, 'chromatic', 'transpose chromatic') ?? 0;
          const octaveChange = intText(transposeChildren, 'octave-change', 'transpose octave-change') ?? 0;
          if (chromatic !== 0 || octaveChange !== 0) unsupported.push({
            code: 'TRANSPOSING_PART',
            location: context.location,
            chromatic,
            octaveChange,
            message: 'Written pitch is preserved; concert-pitch arbitration is not implemented yet.',
          });
        }
        continue;
      }

      if (name === 'backup' || name === 'forward') {
        chordAnchor = null;
        if (!divisions) throw Error(`${name} appears before divisions at ${partId} measure ${measureNumber}`);
        const durationValue = intText(payload(child), 'duration', `${name} duration`);
        if (!durationValue || durationValue <= 0) throw Error(`${name} duration must be positive at ${partId} measure ${measureNumber}`);
        const delta = new F(durationValue, divisions);
        if (name === 'backup') {
          const next = cursor.sub(delta);
          if (next.cmp(0) < 0) throw Error(`backup moves before measure start at ${partId} measure ${measureNumber}`);
          cursor = next;
        } else {
          cursor = cursor.add(delta);
          extent = maxF(extent, cursor);
        }
        continue;
      }

      if (name === 'direction') {
        chordAnchor = null;
        const directionChildren = payload(child);
        const sound = firstNamed(directionChildren, 'sound');
        if (!divisions) {
          readDirectionNavigation({ directionChildren, sound, local: cursor, nav: record.nav, seen });
          warnings.push({ code: 'DIRECTION_BEFORE_DIVISIONS', location: context.location });
          continue;
        }
        const offsetValue = intText(directionChildren, 'offset', 'direction offset') ?? 0;
        const localPosition = cursor.add(new F(offsetValue, divisions));
        if (measureIndex === 0 && localPosition.cmp(0) < 0) throw Error(`direction offset moves before song start at ${partId} measure ${measureNumber}`);
        readDirectionNavigation({ directionChildren, sound, local: localPosition, nav: record.nav, seen });
        readTempo({ sound, directionChildren, localPosition, kind: 'direction' });
        continue;
      }

      if (name === 'sound') {
        // A <sound> may sit directly in the measure; it carries the same
        // playback attributes as one inside a direction.
        chordAnchor = null;
        readDirectionNavigation({ sound: child, local: cursor, nav: record.nav, seen });
        readTempo({ sound: child, localPosition: cursor, kind: 'sound' });
        continue;
      }

      if (name === 'barline') {
        readBarlineNavigation(child, record.nav, seen);
        continue;
      }

      if (name !== 'note') {
        chordAnchor = null;
        continue;
      }

      const noteChildren = payload(child);
      const isChord = hasNamed(noteChildren, 'chord');
      const isGrace = hasNamed(noteChildren, 'grace');
      const isRest = hasNamed(noteChildren, 'rest');
      const isCue = hasNamed(noteChildren, 'cue');
      const voice = childText(noteChildren, 'voice');
      const staff = intText(noteChildren, 'staff', 'note staff');
      const lyrics = parseLyrics(noteChildren);
      const ties = parseTieTypes(noteChildren);
      const type = childText(noteChildren, 'type');
      const dotCount = childrenNamed(noteChildren, 'dot').length;
      const eventPath = sourcePath(partId, measureIndex, sequence, 'note');

      if (isGrace) {
        unsupported.push({ code: 'GRACE_NOTE', location: context.location, sourceEventId: eventPath });
        chordAnchor = null;
        continue;
      }

      if (!divisions) throw Error(`note appears before divisions at ${partId} measure ${measureNumber}`);
      const durationValue = intText(noteChildren, 'duration', 'note duration');
      if (!durationValue || durationValue <= 0) throw Error(`note duration must be positive at ${partId} measure ${measureNumber}`);
      const duration = new F(durationValue, divisions);
      const localStart = isChord ? chordAnchor : cursor;
      if (localStart === null) throw Error(`chord note has no preceding anchor at ${partId} measure ${measureNumber}`);
      extent = maxF(extent, localStart.add(duration));

      const metadata = {
        partId,
        partName,
        partIndex: partIndex + 1,
        measureNumber,
        measureIndex: measureIndex + 1,
        staff,
        chord: isChord,
        cue: isCue,
        ties,
        lyrics,
        type,
        dots: dotCount,
        durationDivisions: durationValue,
        divisions,
        // Only the length is notated here. It is read literally from
        // <duration> against the <divisions> in force. The onset is
        // positional — accumulated through the measure cursor, backup /
        // forward, measure extents and the playback order — and the end
        // follows from that onset, so neither may claim to be notated.
        timing: createTimingProvenance({
          adapter: MUSICXML_ADAPTER,
          start: { origin: 'source-derived' },
          duration: {
            origin: 'source-notated',
            // <divisions> counts divisions per quarter note, so one
            // division is 1/(4 × divisions) of a whole note.
            unit: new F(1, divisions).div(4),
            writtenForm: type ? `${type}${'.'.repeat(dotCount)}` : null,
          },
          end: { origin: 'source-derived' },
        }),
      };

      if (isRest) {
        record.items.push({
          kind: 'rest', local: localStart, duration, sequence, eventPath, voice, isCue,
          metadata: { ...metadata, measureRest: attr(firstNamed(noteChildren, 'rest'), 'measure') === 'yes' },
        });
      } else {
        const unpitched = firstNamed(noteChildren, 'unpitched');
        if (unpitched) {
          unsupported.push({ code: 'UNPITCHED_NOTE', location: context.location, sourceEventId: eventPath });
        } else {
          const pitchNode = firstNamed(noteChildren, 'pitch');
          if (!pitchNode) throw Error(`pitched note is missing pitch at ${partId} measure ${measureNumber}`);
          const pitchChildren = payload(pitchNode);
          const step = childText(pitchChildren, 'step');
          const octave = intText(pitchChildren, 'octave', 'pitch octave');
          const alter = decimalText(pitchChildren, 'alter', 'pitch alter') ?? 0;
          if (!(step in STEP_TO_SEMITONE) || octave === null) throw Error(`invalid pitch at ${partId} measure ${measureNumber}`);
          if (!Number.isInteger(alter)) {
            unsupported.push({ code: 'MICROTONAL_PITCH', location: context.location, sourceEventId: eventPath, step, alter, octave });
          } else {
            const midi = 12 * (octave + 1) + STEP_TO_SEMITONE[step] + alter;
            if (!Number.isInteger(midi) || midi < 0 || midi > 127) throw Error(`MIDI pitch out of range at ${partId} measure ${measureNumber}`);
            record.items.push({
              kind: 'note', local: localStart, duration, sequence, eventPath, voice, isCue, pitch: midi,
              metadata: { ...metadata, writtenPitch: { step, alter, octave } },
            });
          }
        }
      }

      if (!isChord) {
        chordAnchor = cursor;
        cursor = cursor.add(duration);
        extent = maxF(extent, cursor);
      }
    }

    if (extent.cmp(0) === 0 && measureChildren.length) warnings.push({ code: 'ZERO_EXTENT_MEASURE', location: context.location });
    record.extent = extent;
    // Barline side of each direction-level mark. A jump mark acts at the end
    // of its measure; a target is read at a barline.
    for (const marker of record.nav.raw) {
      const { local, ...rest } = marker;
      const atStart = local.cmp(0) <= 0;
      const atEnd = local.cmp(extent) >= 0;
      const isTarget = marker.type === 'segno' || marker.type === 'coda';
      const where = isTarget ? (atStart ? 'start' : atEnd ? 'end' : 'middle') : (atEnd ? 'end' : atStart ? 'start' : 'middle');
      record.nav.markers.push({ ...rest, where });
    }
    delete record.nav.raw;
    measures.push(record);
  }
  return { partId, partName, partIndex, measures };
}

// ─── pickup ────────────────────────────────────────────────────────────────

/**
 * The first measure as a pickup (anacrusis), declared or inferred.
 *
 * Declared: `implicit="yes"`. Inferred: the attribute is absent and measure 1
 * holds less than its written time signature -- reported as PICKUP_INFERRED.
 * `implicit="no"` is an explicit statement that it is not a pickup.
 *
 * Placement: the pickup occupies the END of a partial first bar whose length is
 * the pickup rounded up to whole beats of the written signature (1.5 quarters
 * in 4/4 -> a 2/4 first bar with the pickup from beat 1/2). The meter map then
 * says so: a partial-bar meter at beat 0 and the written signature from the
 * first full bar, so every later barline of the source falls on a barline of
 * its own meter map. The half beat before the pickup is silence the rounding
 * places, not an event.
 */
function detectPickup(scans, lengths, warnings) {
  const first = scans.map(scan => scan.measures[0]).filter(Boolean);
  if (!first.length) return null;
  const length = lengths[0];
  if (!length || length.cmp(0) <= 0) return null;
  const implicitValues = new Set(first.map(measure => measure.implicit).filter(value => value !== null));
  if (implicitValues.has('no') && !implicitValues.has('yes')) return null;
  const declared = implicitValues.has('yes');
  const meters = first.flatMap(measure => measure.times.filter(time => time.local.cmp(0) === 0).map(time => `${time.numerator}/${time.denominator}`));
  const distinct = [...new Set(meters)];
  if (distinct.length !== 1) {
    if (declared) warnings.push({ code: 'PICKUP_NOT_PLACED', message: 'Measure 1 is declared a pickup but the parts state no single written time signature for it; it is laid out literally from beat 0.', meters: distinct });
    return null;
  }
  const [numerator, denominator] = distinct[0].split('/').map(Number);
  const bar = new F(numerator * 4, denominator);
  if (length.cmp(bar) >= 0) return null;
  const unit = new F(4, denominator);
  const units = length.div(unit);
  const wholeUnits = (units.n + units.d - 1n) / units.d;
  const partialBar = unit.mul(new F(wholeUnits));
  const offset = partialBar.sub(length);
  const pickup = {
    status: declared ? 'declared' : 'inferred',
    pickupBeats: length.toString(),
    writtenMeter: { numerator, denominator },
    writtenBarBeats: bar.toString(),
    partialBarBeats: partialBar.toString(),
    partialBarMeter: partialBar.cmp(bar) < 0 ? { numerator: Number(wholeUnits), denominator } : null,
    leadingSilenceBeats: offset.toString(),
  };
  if (!declared) {
    warnings.push({
      code: 'PICKUP_INFERRED',
      message: `Measure 1 holds ${pickup.pickupBeats} beats under a written ${numerator}/${denominator} (${pickup.writtenBarBeats} beats) and is not marked implicit="yes". It is read as a pickup ending a ${pickup.partialBarBeats}-beat first bar${offset.cmp(0) > 0 ? `, starting after ${pickup.leadingSilenceBeats} beat(s) of silence` : ''}; the first full bar starts at beat ${pickup.partialBarBeats}.`,
      ...pickup,
    });
  }
  return { ...pickup, length, bar, partialBar, offset };
}

// ─── entry point ───────────────────────────────────────────────────────────

export function ingestMusicXML(xml, options = {}) {
  const {
    sourceId = 'musicxml-source',
    label = 'MusicXML source',
    kind = 'official-musicxml',
    authority = kind === 'official-musicxml' ? 'primary-symbolic' : 'supporting',
    sha256 = null,
    container = null,
  } = options;

  if (!['official-musicxml', 'third-party-musicxml'].includes(kind)) throw Error('MusicXML source kind must be official-musicxml or third-party-musicxml');

  const root = parseMusicXmlTree(xml);
  const rootChildren = payload(root);
  const partNames = parsePartNames(rootChildren);
  const title = detectTitle(rootChildren, label);

  const events = [];
  const tempoEvents = [];
  const meterEvents = [];
  const warnings = [];
  const unsupported = [];
  const partSummaries = [];
  const seen = new Set();

  const partNodes = childrenNamed(rootChildren, 'part');
  if (!partNodes.length) throw Error('MusicXML contains no part elements');

  // Pass 1.
  const scans = partNodes.map((partNode, partIndex) => scanPart(partNode, partIndex, { partNames, warnings, unsupported, seen }));
  const measureCount = Math.max(...scans.map(scan => scan.measures.length));
  // One timeline for every part: a measure lasts as long as its longest part.
  const lengths = Array.from({ length: measureCount }, (_, index) => scans.reduce(
    (longest, scan) => (scan.measures[index] ? maxF(longest, scan.measures[index].extent) : longest),
    f(0),
  ));
  for (let index = 0; index < measureCount; index += 1) {
    const differing = scans.filter(scan => scan.measures[index] && scan.measures[index].extent.cmp(0) > 0 && scan.measures[index].extent.cmp(lengths[index]) !== 0);
    if (differing.length) {
      warnings.push({
        code: 'MEASURE_LENGTH_DIFFERS_ACROSS_PARTS',
        measureIndex: index + 1,
        length: lengths[index].toString(),
        parts: differing.map(scan => ({ partId: scan.partId, length: scan.measures[index].extent.toString() })),
        message: 'Parts fill this measure to different lengths; every part\'s next measure starts after the longest.',
      });
    }
  }
  const numberOf = index => scans.find(scan => scan.measures[index])?.measures[index].number ?? String(index + 1);

  // Pass 2.
  const hasNavigation = scans.some(scan => scan.measures.some(measure => measure.nav.repeats.length || measure.nav.endings.length || measure.nav.markers.length || measure.nav.problems.length || measure.nav.forwardRepeatSound));
  let plan = Array.from({ length: measureCount }, (_, index) => ({ index, pass: 1 }));
  let navigation = Object.freeze({ expanded: false, writtenMeasures: measureCount, playedMeasures: measureCount, playbackOrderText: measureCount ? `${numberOf(0)}–${numberOf(measureCount - 1)}` : '' });
  if (hasNavigation) {
    if (new Set(scans.map(scan => scan.measures.length)).size > 1) {
      unsupported.push({ code: NAVIGATION_CODES.PLAN, reason: 'PART_MEASURE_COUNT_MISMATCH', message: 'Parts have different measure counts, so their navigation marks cannot be aligned; the written order is kept.', counts: scans.map(scan => ({ partId: scan.partId, measures: scan.measures.length })) });
      navigation = Object.freeze({ ...navigation, refused: true });
    } else {
      const result = planPlayback({
        parts: scans.map(scan => ({ partId: scan.partId, measures: scan.measures.map(measure => measure.nav) })),
        measureCount,
        numberOf,
      });
      warnings.push(...result.warnings);
      if (result.ok) {
        plan = result.plan;
        navigation = result.summary;
      } else {
        unsupported.push(...result.diagnostics.map(item => ({ ...item, message: `${item.message} The written order is kept and the source is not complete.` })));
        navigation = Object.freeze({ ...navigation, refused: true, reasons: Object.freeze(result.diagnostics.map(item => item.reason)) });
      }
    }
  }

  // Pass 3.
  const pickup = plan[0]?.index === 0 ? detectPickup(scans, lengths, warnings) : null;
  const placed = [];
  let cursor = f(0);
  plan.forEach((entry, position) => {
    if (position === 0 && pickup) {
      placed.push({ ...entry, position, start: pickup.offset, controlStart: f(0), end: pickup.partialBar });
      cursor = pickup.partialBar;
      return;
    }
    const end = cursor.add(lengths[entry.index]);
    placed.push({ ...entry, position, start: cursor, controlStart: cursor, end });
    cursor = end;
  });
  const beatAt = (slot, local) => (local.cmp(0) === 0 ? slot.controlStart : slot.start.add(local));
  // Whether a beat is a bar line of the meter map this part has emitted so
  // far: a whole number of bars after the part's latest meter event.
  const onBarLine = (partId, beat) => {
    const last = meterEvents.findLast(event => event.metadata?.partId === partId);
    if (!last) return true;
    const barLength = f(`${4 * last.numerator}/${last.denominator}`);
    return !String(beat.sub(f(last.beat)).div(barLength)).includes('/');
  };
  const idSuffix = pass => (pass > 1 ? `:pass${pass}` : '');
  const pathSuffix = pass => (pass > 1 ? `/pass:${pass}` : '');
  const playbackMetadata = slot => ({ pass: slot.pass, playbackMeasureIndex: slot.position + 1 });

  for (const scan of scans) {
    const { partId, partName } = scan;
    let partEventCount = 0;
    let partRestCount = 0;
    let partEnd = f(0);
    let currentMeter = null;

    for (const slot of placed) {
      const measure = scan.measures[slot.index];
      if (!measure) continue;
      partEnd = slot.end;
      const suffix = idSuffix(slot.pass);
      const sourceSuffix = pathSuffix(slot.pass);

      for (const item of measure.items) {
        const start = slot.start.add(item.local);
        const end = start.add(item.duration);
        const metadata = {
          ...item.metadata,
          ...playbackMetadata(slot),
          ...(slot.pass > 1 ? { writtenSourceEventId: item.eventPath } : {}),
        };
        const common = {
          start: String(start),
          end: String(end),
          sourceIds: [sourceId],
          sourceEventIds: [`${item.eventPath}${sourceSuffix}`],
          role: null,
          voice: item.voice,
          tags: ['source-faithful', ...(item.isCue ? ['cue'] : [])],
          metadata,
        };
        if (item.kind === 'rest') {
          events.push(createCanonicalRestEvent({ id: `${sourceId}:rest:${partId}:${slot.index + 1}:${item.sequence}${suffix}`, ...common }));
          partRestCount++;
        } else {
          events.push(createCanonicalNoteEvent({ id: `${sourceId}:note:${partId}:${slot.index + 1}:${item.sequence}${suffix}`, pitch: item.pitch, volume: null, ...common }));
          partEventCount++;
        }
      }

      // Meter, per part. A replayed or jumped-to measure that writes no
      // signature of its own is restated with the one in force at that written
      // measure, so the meter map follows playback order the way the notation
      // does.
      const writesAtStart = measure.times.some(time => time.local.cmp(0) === 0);
      if (!writesAtStart && measure.meterAtStart && !sameMeter(currentMeter, measure.meterAtStart)) {
        meterEvents.push(createCanonicalMeterEvent({
          id: `${sourceId}:meter:${partId}:${slot.index + 1}:restated${suffix || ':pass1'}`,
          beat: String(slot.controlStart),
          numerator: measure.meterAtStart.numerator,
          denominator: measure.meterAtStart.denominator,
          sourceIds: [sourceId],
          // The written signature being restated is the evidence.
          sourceEventIds: [sourcePath(partId, measure.meterAtStart.measureIndex, measure.meterAtStart.sequence, 'attributes/time')],
          metadata: { partId, partName, measureNumber: measure.number, restated: true, reason: 'playback-order', restatedFromMeasureIndex: measure.meterAtStart.measureIndex + 1, ...playbackMetadata(slot) },
        }));
        currentMeter = measure.meterAtStart;
      }
      for (const time of measure.times) {
        const path = sourcePath(partId, slot.index, time.sequence, 'attributes/time');
        const id = `${sourceId}:meter:${partId}:${slot.index + 1}:${time.sequence}${suffix}`;
        const base = { partId, partName, measureNumber: measure.number, ...playbackMetadata(slot) };
        if (slot.position === 0 && pickup && time.local.cmp(0) === 0) {
          if (pickup.partialBarMeter) {
            meterEvents.push(createCanonicalMeterEvent({
              id: `${id}:partial-first-bar`,
              beat: '0',
              numerator: pickup.partialBarMeter.numerator,
              denominator: pickup.partialBarMeter.denominator,
              sourceIds: [sourceId],
              sourceEventIds: [path],
              metadata: { ...base, partialFirstBar: true, pickup: pickup.status, writtenNumerator: time.numerator, writtenDenominator: time.denominator },
            }));
          }
          // The written signature governs from the first full bar (from beat 0
          // when the rounded first bar is already a full bar). If that bar
          // writes its own signature, that one is the meter there.
          const nextWrites = Boolean(pickup.partialBarMeter) && placed[1]?.index === 1
            && scan.measures[1]?.times.some(next => next.local.cmp(0) === 0);
          if (!nextWrites) {
            meterEvents.push(createCanonicalMeterEvent({
              id,
              beat: pickup.partialBarMeter ? String(pickup.partialBar) : '0',
              numerator: time.numerator,
              denominator: time.denominator,
              sourceIds: [sourceId],
              sourceEventIds: [path],
              metadata: { ...base, ...(pickup.partialBarMeter ? { afterPickup: true } : { pickup: pickup.status }) },
            }));
          }
          currentMeter = time;
          continue;
        }
        const at = beatAt(slot, time.local);
        // A written signature equal to the one in force is not a meter change.
        // It is still recorded as before when it falls on a bar line, but not
        // when it would fall inside a bar: after a pickup, a repeat or D.C.
        // back to the first measure replays the pickup's written 4/4 one beat
        // into a bar, and that restatement made the meter map one that the
        // Final validator and the prescreen refuse (a meter change inside a
        // bar), so a complete, correct source could never be delivered.
        if (sameMeter(currentMeter, time) && !onBarLine(partId, at)) continue;
        meterEvents.push(createCanonicalMeterEvent({
          id,
          beat: String(at),
          numerator: time.numerator,
          denominator: time.denominator,
          sourceIds: [sourceId],
          sourceEventIds: [`${path}${sourceSuffix}`],
          metadata: base,
        }));
        currentMeter = time;
      }
    }

    partSummaries.push(Object.freeze({
      id: partId,
      name: partName,
      measures: scan.measures.length,
      endBeat: String(partEnd),
      noteEvents: partEventCount,
      restEvents: partRestCount,
    }));
  }

  // Tempo, across parts: one written tempo map, followed in playback order.
  const tempoByMeasure = Array.from({ length: measureCount }, (_, index) => scans
    .flatMap(scan => (scan.measures[index]?.tempos ?? []).map(mark => ({ ...mark, measureIndex: index, partId: scan.partId, partName: scan.partName, partIndex: scan.partIndex, measureNumber: scan.measures[index].number })))
    .sort((a, b) => a.local.cmp(b.local) || a.partIndex - b.partIndex || a.sequence - b.sequence));
  const tempoAtStart = [];
  let written = null;
  for (let index = 0; index < measureCount; index += 1) {
    tempoAtStart.push(written);
    const marks = tempoByMeasure[index];
    if (marks.length) written = marks.at(-1);
  }
  let currentTempo = null;
  for (const slot of placed) {
    const marks = tempoByMeasure[slot.index];
    const suffix = idSuffix(slot.pass);
    const sourceSuffix = pathSuffix(slot.pass);
    const inForce = tempoAtStart[slot.index];
    if (!marks.some(mark => mark.local.cmp(0) <= 0) && inForce && currentTempo !== inForce.bpm) {
      tempoEvents.push(createCanonicalTempoEvent({
        id: `${sourceId}:tempo:${inForce.partId}:${slot.index + 1}:restated${suffix || ':pass1'}`,
        beat: String(slot.controlStart),
        bpm: inForce.bpm,
        sourceIds: [sourceId],
        // The written mark being restated is the evidence.
        sourceEventIds: [sourcePath(inForce.partId, inForce.measureIndex, inForce.sequence, `${inForce.kind}/tempo`)],
        metadata: { partId: inForce.partId, partName: inForce.partName, measureNumber: numberOf(slot.index), restated: true, reason: 'playback-order', restatedFromMeasureIndex: inForce.measureIndex + 1, source: inForce.source, ...playbackMetadata(slot) },
      }));
      currentTempo = inForce.bpm;
    }
    for (const mark of marks) {
      const beat = beatAt(slot, mark.local);
      if (beat.cmp(0) < 0) throw Error(`direction offset moves before song start at ${mark.partId} measure ${mark.measureNumber}`);
      tempoEvents.push(createCanonicalTempoEvent({
        id: `${sourceId}:tempo:${mark.partId}:${slot.index + 1}:${mark.sequence}${suffix}`,
        beat: String(beat),
        bpm: mark.bpm,
        sourceIds: [sourceId],
        sourceEventIds: [`${sourcePath(mark.partId, slot.index, mark.sequence, `${mark.kind}/tempo`)}${sourceSuffix}`],
        metadata: { partId: mark.partId, partName: mark.partName, measureNumber: mark.measureNumber, source: mark.source, ...playbackMetadata(slot) },
      }));
      currentTempo = mark.bpm;
    }
  }

  // Several parts writing the same control at the same beat state one fact.
  // Different values at one beat are a contradiction inside the source.
  const controls = normalizeControlEvents({ tempoEvents, meterEvents });
  for (const conflict of controls.conflicts) unsupported.push(controlConflictDiagnostic(conflict));

  const pickupRecord = pickup ? Object.freeze({
    status: pickup.status,
    pickupBeats: pickup.pickupBeats,
    writtenMeter: pickup.writtenMeter,
    writtenBarBeats: pickup.writtenBarBeats,
    partialBarBeats: pickup.partialBarBeats,
    partialBarMeter: pickup.partialBarMeter,
    leadingSilenceBeats: pickup.leadingSilenceBeats,
  }) : null;
  const source = createSource({
    id: sourceId,
    label,
    kind,
    authority,
    sha256,
    metadata: {
      format: 'MusicXML',
      root: 'score-partwise',
      title,
      navigation,
      pickup: pickupRecord,
      ...(container ? { container } : {}),
    },
  });

  const complete = unsupported.length === 0;
  return Object.freeze({
    source,
    title,
    complete,
    events: Object.freeze(events),
    tempoEvents: controls.tempoEvents,
    meterEvents: controls.meterEvents,
    parts: Object.freeze(partSummaries),
    navigation,
    pickup: pickupRecord,
    container: container ?? null,
    navigationClassesSeen: Object.freeze([...seen].sort()),
    warnings: Object.freeze(warnings),
    unsupported: Object.freeze(unsupported),
  });
}

export function musicXMLFragmentToProject(fragment, options = {}) {
  if (!fragment?.source || !Array.isArray(fragment.events)) throw Error('invalid MusicXML fragment');
  const id = options.id ?? `${fragment.source.id}-project`;
  const title = options.title ?? fragment.title ?? fragment.source.label;
  return createCanonicalProject({
    id,
    title,
    sources: [fragment.source],
    events: [...fragment.events],
    tempoEvents: [...fragment.tempoEvents],
    meterEvents: [...fragment.meterEvents],
    metadata: {
      ingestion: 'musicxml-v2',
      sourceComplete: fragment.complete,
      warnings: [...fragment.warnings],
      unsupported: [...fragment.unsupported],
      parts: [...fragment.parts],
      navigation: fragment.navigation ?? null,
      pickup: fragment.pickup ?? null,
      ...(fragment.container ? { container: fragment.container } : {}),
    },
  });
}
