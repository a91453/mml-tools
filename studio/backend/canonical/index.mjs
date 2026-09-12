import { f, ROLES } from '../mml/index.mjs';

export const SOURCE_KINDS = Object.freeze([
  'official-musicxml',
  'official-midi',
  'third-party-musicxml',
  'third-party-midi',
  'current-mml',
  'historical-mml',
  'original-audio',
  'derived',
]);

export const SOURCE_AUTHORITIES = Object.freeze([
  'primary-symbolic',
  'primary-audio',
  'supporting',
  'derived',
]);

const nonEmpty = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw Error(`${label} must be a non-empty string`);
  return value.trim();
};

const beat = (value, label) => {
  let result;
  try { result = f(value); }
  catch { throw Error(`${label} must be an exact rational-compatible beat value`); }
  if (result.cmp(0) < 0) throw Error(`${label} must be >= 0`);
  return result.toString();
};

const uniqueStrings = (values, label, { allowEmpty = true } = {}) => {
  if (!Array.isArray(values)) throw Error(`${label} must be an array`);
  const normalized = values.map((value, index) => nonEmpty(value, `${label}[${index}]`));
  if (!allowEmpty && !normalized.length) throw Error(`${label} must not be empty`);
  if (new Set(normalized).size !== normalized.length) throw Error(`${label} must not contain duplicates`);
  return normalized;
};

const jsonObject = (value, label) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw Error(`${label} must be an object`);
  return structuredClone(value);
};

export function createSource({ id, label, kind, authority, sha256 = null, metadata = {} }) {
  id = nonEmpty(id, 'source.id');
  label = nonEmpty(label, 'source.label');
  if (!SOURCE_KINDS.includes(kind)) throw Error(`unsupported source.kind: ${kind}`);
  if (!SOURCE_AUTHORITIES.includes(authority)) throw Error(`unsupported source.authority: ${authority}`);
  if (sha256 !== null && (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256))) throw Error('source.sha256 must be null or a 64-character hex SHA-256');
  return Object.freeze({ id, label, kind, authority, sha256, metadata: jsonObject(metadata, 'source.metadata') });
}

export function createCanonicalNoteEvent({
  id,
  pitch,
  start,
  end,
  sourceIds,
  sourceEventIds = [],
  role = null,
  voice = null,
  volume = null,
  tags = [],
  metadata = {},
}) {
  id = nonEmpty(id, 'event.id');
  if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) throw Error('event.pitch must be a MIDI integer from 0 to 127');
  start = beat(start, 'event.start');
  end = beat(end, 'event.end');
  if (f(end).cmp(start) <= 0) throw Error('event.end must be greater than event.start');
  sourceIds = uniqueStrings(sourceIds, 'event.sourceIds', { allowEmpty: false });
  sourceEventIds = uniqueStrings(sourceEventIds, 'event.sourceEventIds');
  if (role !== null && !ROLES.includes(role)) throw Error(`event.role must be null or one of: ${ROLES.join(', ')}`);
  if (voice !== null && (typeof voice !== 'string' && !Number.isInteger(voice))) throw Error('event.voice must be null, string, or integer');
  if (volume !== null && (!Number.isInteger(volume) || volume < 0 || volume > 15)) throw Error('event.volume must be null or an integer from 0 to 15');
  tags = uniqueStrings(tags, 'event.tags');
  return Object.freeze({
    id,
    pitch,
    start,
    end,
    sourceIds,
    sourceEventIds,
    role,
    voice,
    volume,
    tags,
    metadata: jsonObject(metadata, 'event.metadata'),
  });
}

export function createArbitrationDecision({
  id,
  eventIds,
  action,
  status = 'pending',
  reason,
  evidence = [],
  metadata = {},
}) {
  id = nonEmpty(id, 'decision.id');
  eventIds = uniqueStrings(eventIds, 'decision.eventIds', { allowEmpty: false });
  action = nonEmpty(action, 'decision.action');
  if (!['pending', 'accepted', 'rejected'].includes(status)) throw Error('decision.status must be pending, accepted, or rejected');
  reason = nonEmpty(reason, 'decision.reason');
  evidence = uniqueStrings(evidence, 'decision.evidence');
  return Object.freeze({ id, eventIds, action, status, reason, evidence, metadata: jsonObject(metadata, 'decision.metadata') });
}

export function createCanonicalProject({ id, title, sources, events, decisions = [], metadata = {} }) {
  id = nonEmpty(id, 'project.id');
  title = nonEmpty(title, 'project.title');
  if (!Array.isArray(sources) || !Array.isArray(events) || !Array.isArray(decisions)) throw Error('project sources/events/decisions must be arrays');

  const sourceIds = new Set();
  for (const source of sources) {
    if (!source || typeof source !== 'object') throw Error('project.sources contains an invalid source');
    if (sourceIds.has(source.id)) throw Error(`duplicate source id: ${source.id}`);
    sourceIds.add(source.id);
  }

  const eventIds = new Set();
  for (const event of events) {
    if (!event || typeof event !== 'object') throw Error('project.events contains an invalid event');
    if (eventIds.has(event.id)) throw Error(`duplicate event id: ${event.id}`);
    eventIds.add(event.id);
    for (const sourceId of event.sourceIds ?? []) if (!sourceIds.has(sourceId)) throw Error(`event ${event.id} references unknown source: ${sourceId}`);
  }

  const decisionIds = new Set();
  for (const decision of decisions) {
    if (!decision || typeof decision !== 'object') throw Error('project.decisions contains an invalid decision');
    if (decisionIds.has(decision.id)) throw Error(`duplicate decision id: ${decision.id}`);
    decisionIds.add(decision.id);
    for (const eventId of decision.eventIds ?? []) if (!eventIds.has(eventId)) throw Error(`decision ${decision.id} references unknown event: ${eventId}`);
  }

  return Object.freeze({
    schema: 'mabinogi-mobile-mml-studio/canonical-project@1',
    id,
    title,
    sources: [...sources],
    events: [...events],
    decisions: [...decisions],
    metadata: jsonObject(metadata, 'project.metadata'),
  });
}
