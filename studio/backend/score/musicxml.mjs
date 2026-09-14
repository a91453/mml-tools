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
  const beats = childText(timeChildren, 'beats');
  const beatType = childText(timeChildren, 'beat-type');
  if (beats === null || beatType === null) return null;
  if (!/^\d+$/.test(beats) || !/^\d+$/.test(beatType)) {
    context.unsupported.push({ code: 'COMPLEX_METER', location: context.location, beats, beatType });
    return null;
  }
  return { numerator: Number(beats), denominator: Number(beatType) };
}

function parseMetronome(directionChildren) {
  const directionType = firstNamed(directionChildren, 'direction-type');
  if (!directionType) return null;
  const metronome = firstNamed(payload(directionType), 'metronome');
  if (!metronome) return null;
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

export function ingestMusicXML(xml, options = {}) {
  const {
    sourceId = 'musicxml-source',
    label = 'MusicXML source',
    kind = 'official-musicxml',
    authority = kind === 'official-musicxml' ? 'primary-symbolic' : 'supporting',
    sha256 = null,
  } = options;

  if (!['official-musicxml', 'third-party-musicxml'].includes(kind)) throw Error('MusicXML source kind must be official-musicxml or third-party-musicxml');

  const root = parseMusicXmlTree(xml);
  const rootChildren = payload(root);
  const partNames = parsePartNames(rootChildren);
  const title = detectTitle(rootChildren, label);
  const source = createSource({
    id: sourceId,
    label,
    kind,
    authority,
    sha256,
    metadata: { format: 'MusicXML', root: 'score-partwise', title },
  });

  const events = [];
  const tempoEvents = [];
  const meterEvents = [];
  const warnings = [];
  const unsupported = [];
  const partSummaries = [];

  const partNodes = childrenNamed(rootChildren, 'part');
  if (!partNodes.length) throw Error('MusicXML contains no part elements');

  for (let partIndex = 0; partIndex < partNodes.length; partIndex++) {
    const partNode = partNodes[partIndex];
    const partId = attr(partNode, 'id') ?? `P${partIndex + 1}`;
    const partName = partNames.get(partId) ?? partId;
    const measureNodes = childrenNamed(payload(partNode), 'measure');
    let divisions = null;
    let partPosition = f(0);
    let partEventCount = 0;
    let partRestCount = 0;

    for (let measureIndex = 0; measureIndex < measureNodes.length; measureIndex++) {
      const measureNode = measureNodes[measureIndex];
      const measureNumber = attr(measureNode, 'number') ?? String(measureIndex + 1);
      const measureChildren = payload(measureNode);
      let cursor = f(0);
      let extent = f(0);
      let chordAnchor = null;
      let sequence = 0;

      const context = {
        unsupported,
        location: { partId, partName, measureNumber, measureIndex: measureIndex + 1 },
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
            if (!meter) continue;
            const position = partPosition.add(cursor);
            meterEvents.push(createCanonicalMeterEvent({
              id: `${sourceId}:meter:${partId}:${measureIndex + 1}:${sequence}`,
              beat: String(position),
              numerator: meter.numerator,
              denominator: meter.denominator,
              sourceIds: [sourceId],
              sourceEventIds: [sourcePath(partId, measureIndex, sequence, 'attributes/time')],
              metadata: { partId, partName, measureNumber },
            }));
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
          if (!divisions) {
            warnings.push({ code: 'DIRECTION_BEFORE_DIVISIONS', location: context.location });
            continue;
          }
          const directionChildren = payload(child);
          const offsetValue = intText(directionChildren, 'offset', 'direction offset') ?? 0;
          const position = partPosition.add(cursor).add(new F(offsetValue, divisions));
          if (position.cmp(0) < 0) throw Error(`direction offset moves before song start at ${partId} measure ${measureNumber}`);

          const sound = firstNamed(directionChildren, 'sound');
          const soundTempoRaw = sound ? attr(sound, 'tempo') : null;
          let bpm = soundTempoRaw !== null ? Number(soundTempoRaw) : null;
          if (bpm !== null && (!Number.isFinite(bpm) || bpm <= 0)) throw Error(`invalid sound tempo at ${partId} measure ${measureNumber}`);
          if (bpm === null) bpm = parseMetronome(directionChildren);
          if (bpm !== null) {
            tempoEvents.push(createCanonicalTempoEvent({
              id: `${sourceId}:tempo:${partId}:${measureIndex + 1}:${sequence}`,
              beat: String(position),
              bpm,
              sourceIds: [sourceId],
              sourceEventIds: [sourcePath(partId, measureIndex, sequence, 'direction/tempo')],
              metadata: { partId, partName, measureNumber, source: soundTempoRaw !== null ? 'sound-tempo' : 'metronome' },
            }));
          }
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
        const globalStart = partPosition.add(localStart);
        const globalEnd = globalStart.add(duration);
        extent = maxF(extent, localStart.add(duration));

        const common = {
          start: String(globalStart),
          end: String(globalEnd),
          sourceIds: [sourceId],
          sourceEventIds: [eventPath],
          role: null,
          voice,
          tags: ['source-faithful', ...(isCue ? ['cue'] : [])],
          metadata: {
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
            // The duration is read literally from <duration> against the
            // <divisions> in force, so this event's length is notated. The onset
            // is positional — accumulated through the measure cursor, backup /
            // forward and measure extents — which is why `unit` reports the
            // quantum the file encodes on rather than an onset claim.
            //
            // No artifact attestation is emitted: this adapter only reads, it
            // never creates a meaning-free value by construction.
            timing: createTimingProvenance({
              origin: 'source-notated',
              adapter: MUSICXML_ADAPTER,
              // <divisions> counts divisions per quarter note, so one division
              // is 1/(4 × divisions) of a whole note.
              unit: new F(1, divisions).div(4),
              writtenForm: type ? `${type}${'.'.repeat(dotCount)}` : null,
            }),
          },
        };

        if (isRest) {
          events.push(createCanonicalRestEvent({
            id: `${sourceId}:rest:${partId}:${measureIndex + 1}:${sequence}`,
            ...common,
            metadata: { ...common.metadata, measureRest: attr(firstNamed(noteChildren, 'rest'), 'measure') === 'yes' },
          }));
          partRestCount++;
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
              events.push(createCanonicalNoteEvent({
                id: `${sourceId}:note:${partId}:${measureIndex + 1}:${sequence}`,
                pitch: midi,
                volume: null,
                ...common,
                metadata: { ...common.metadata, writtenPitch: { step, alter, octave } },
              }));
              partEventCount++;
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
      partPosition = partPosition.add(extent);
    }

    partSummaries.push(Object.freeze({
      id: partId,
      name: partName,
      measures: measureNodes.length,
      endBeat: String(partPosition),
      noteEvents: partEventCount,
      restEvents: partRestCount,
    }));
  }

  const complete = unsupported.length === 0;
  return Object.freeze({
    source,
    title,
    complete,
    events: Object.freeze(events),
    tempoEvents: Object.freeze(tempoEvents),
    meterEvents: Object.freeze(meterEvents),
    parts: Object.freeze(partSummaries),
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
      ingestion: 'musicxml-v1',
      sourceComplete: fragment.complete,
      warnings: [...fragment.warnings],
      unsupported: [...fragment.unsupported],
      parts: [...fragment.parts],
    },
  });
}
