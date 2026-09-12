import { f, ROLES, parseMeter } from './index.mjs';
import { validateMML } from './parser.mjs';
import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalRestEvent,
  createCanonicalTempoEvent,
  createCanonicalMeterEvent,
  createCanonicalProject,
} from '../canonical/index.mjs';

const maxF = (a, b) => f(a).cmp(b) >= 0 ? f(a) : f(b);

function silenceSpans(track) {
  const spans = [];
  let cursor = f(0);
  const events = [...track.events].sort((a, b) => f(a.start).cmp(b.start) || f(a.end).cmp(b.end));
  for (const event of events) {
    const start = f(event.start);
    if (start.cmp(cursor) > 0) spans.push({ start: String(cursor), end: String(start) });
    cursor = maxF(cursor, event.end);
  }
  const total = f(track.total);
  if (total.cmp(cursor) > 0) spans.push({ start: String(cursor), end: String(total) });
  return spans;
}

function meterEventsFromSettings(sourceId, meterText) {
  if (!meterText?.trim()) return [];
  return parseMeter(meterText).map((meter, index) => createCanonicalMeterEvent({
    id: `${sourceId}:meter:${index + 1}`,
    beat: meter.beat,
    numerator: meter.numerator,
    denominator: meter.denominator,
    sourceIds: [sourceId],
    sourceEventIds: [`settings:meter:${index + 1}`],
    metadata: { evidence: 'caller-confirmed-meter-map' },
  }));
}

export function normalizeMMLSource(raw, options = {}) {
  const {
    sourceId = 'mml-source',
    label = 'MML source',
    kind = 'current-mml',
    authority = 'derived',
    sha256 = null,
    meterText = '',
    pickup = '',
    finalPartial = '',
    programs,
    drumText,
  } = options;

  if (!['current-mml', 'historical-mml'].includes(kind)) throw Error('MML source kind must be current-mml or historical-mml');

  // Source ingestion is deliberately broader than Final validation. It keeps
  // caution forms such as plain non-preferred 1–64 lengths and Nxx as evidence,
  // then records warnings instead of erasing the source event identity.
  const validation = validateMML(raw, {
    meterText,
    pickup,
    finalPartial,
    programs,
    drumText,
    title: label,
    validationMode: 'ingest',
  });
  if (!validation.song) throw Error(validation.errors?.[0]?.message ?? 'MML could not be parsed');

  const source = createSource({
    id: sourceId,
    label,
    kind,
    authority,
    sha256,
    metadata: {
      format: 'MML',
      profile: validation.song.profile,
      validationMode: validation.song.validationMode,
      technicalOk: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings,
    },
  });

  const events = [];
  for (let trackIndex = 0; trackIndex < validation.song.tracks.length; trackIndex++) {
    const track = validation.song.tracks[trackIndex];
    const role = ROLES[trackIndex];
    for (let eventIndex = 0; eventIndex < track.events.length; eventIndex++) {
      const event = track.events[eventIndex];
      events.push(createCanonicalNoteEvent({
        id: `${sourceId}:note:${role}:${eventIndex + 1}`,
        pitch: event.pitch,
        start: event.start,
        end: event.end,
        volume: event.volume,
        role,
        voice: role,
        sourceIds: [sourceId],
        sourceEventIds: [`track:${role}/note:${eventIndex + 1}`],
        tags: ['mml-source', kind],
        metadata: { trackIndex: trackIndex + 1, characters: track.characters },
      }));
    }

    const rests = silenceSpans(track);
    for (let restIndex = 0; restIndex < rests.length; restIndex++) {
      const rest = rests[restIndex];
      events.push(createCanonicalRestEvent({
        id: `${sourceId}:rest:${role}:${restIndex + 1}`,
        start: rest.start,
        end: rest.end,
        role,
        voice: role,
        sourceIds: [sourceId],
        sourceEventIds: [`track:${role}/silence:${restIndex + 1}`],
        tags: ['mml-source', 'inferred-silence', kind],
        metadata: { trackIndex: trackIndex + 1, inference: 'gap-between-expanded-note-events' },
      }));
    }
  }

  const firstActiveTrack = validation.song.tracks.find(track => !track.empty);
  const tempoEvents = (firstActiveTrack?.tempo ?? []).map((tempo, index) => createCanonicalTempoEvent({
    id: `${sourceId}:tempo:${index + 1}`,
    beat: tempo.beat,
    bpm: tempo.bpm,
    sourceIds: [sourceId],
    sourceEventIds: [`track:${firstActiveTrack.role}/tempo:${index + 1}`],
    metadata: { canonicalTrack: firstActiveTrack.role },
  }));
  const meterEvents = meterEventsFromSettings(sourceId, meterText);

  return Object.freeze({
    source,
    complete: validation.ok,
    validation,
    events: Object.freeze(events),
    tempoEvents: Object.freeze(tempoEvents),
    meterEvents: Object.freeze(meterEvents),
  });
}

export function mmlFragmentToProject(fragment, options = {}) {
  if (!fragment?.source || !fragment.validation?.song) throw Error('invalid MML fragment');
  return createCanonicalProject({
    id: options.id ?? `${fragment.source.id}-project`,
    title: options.title ?? fragment.source.label,
    sources: [fragment.source],
    events: [...fragment.events],
    tempoEvents: [...fragment.tempoEvents],
    meterEvents: [...fragment.meterEvents],
    metadata: {
      ingestion: 'mml-source-v2-canonical-alignment',
      sourceComplete: fragment.complete,
      technicalOk: fragment.validation.ok,
      errors: [...fragment.validation.errors],
      warnings: [...fragment.validation.warnings],
      totalBeats: fragment.validation.song.total,
    },
  });
}
