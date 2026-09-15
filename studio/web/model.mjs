import { createSource, createCanonicalNoteEvent, createCanonicalRestEvent, createCanonicalTempoEvent, createCanonicalMeterEvent, createCanonicalProject, createArbitrationDecision } from '../backend/canonical/index.mjs';
import { normalizeMMLSource, mmlFragmentToProject } from '../backend/mml/canonicalize.mjs';
import { validateMML, splitMML } from '../backend/mml/parser.mjs';
import { ingestMusicXML, musicXMLFragmentToProject } from '../backend/score/index.mjs';
import { compareCandidateLineage, compareCanonicalVersions } from '../backend/compare/version-drift.mjs';
import { evaluateCore3Continuity } from '../backend/arbitration/core3.mjs';
import { evaluateLeadDemotion } from '../backend/arbitration/lead-demotion.mjs';
import { analyzeCrossSourceHarmony } from '../backend/arbitration/harmony.mjs';
import { evaluateProjectReadiness } from '../backend/final/readiness.mjs';
import { attachAudioAlignmentEvidence } from '../backend/audio/index.mjs';
import { alignmentProjectText } from './audio-payload.mjs';
import { arrangementBinding, deriveArrangement, ingestMidiSource, isRawMidiAsset, reingestMidiAsset, verifyStoredProject } from './midi-source.mjs';

export const WORKSPACE_SCHEMA = 'mml-studio-web/workspace@1';
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;
export const REVIEW_NAMES = ['source', 'version', 'lead', 'core3', 'full6', 'tempo', 'audio', 'adaptation', 'regression'];
const text = value => typeof value === 'string' && value.trim().length > 0;
const finiteNumber = value => (typeof value === 'number' || text(value)) && Number.isFinite(Number(value));
const copy = value => structuredClone(value);
const pending = reason => ({ status: 'PENDING', reason });
const pass = reason => ({ status: 'PASS', reason });
const good = value => ['PASS', 'N/A'].includes(value?.status);

export function newWorkspace() {
  return { schema: WORKSPACE_SCHEMA, id: crypto.randomUUID(), title: '未命名專案', revision: 0, assets: {}, settings: { meterText: '', recording: '', offset: '', end: '', audioRequired: 'unknown', preview: 'unknown' }, reviews: {}, harmonyDecisions: [], core3Approvals: [], leadEvidence: [], audio: null, acceptance: null };
}

// Imported JSON is data, including any old PASS flags. Reconstruct every item
// with the existing IR constructors; imported status metadata never grants a gate.
export function readCanonical(value) {
  if (value?.schema !== 'mabinogi-mobile-mml-studio/canonical-project@2') throw Error('UNSUPPORTED: Canonical IR schema');
  if (!Array.isArray(value.events) || value.events.length > 30000) throw Error('UNSUPPORTED: event count');
  const events = value.events.map(event => {
    if (event.kind === 'note') return createCanonicalNoteEvent(event);
    if (event.kind === 'rest') return createCanonicalRestEvent(event);
    throw Error(`UNSUPPORTED: event kind ${event.kind}`);
  });
  return createCanonicalProject({ ...value, sources: value.sources.map(createSource), events,
    tempoEvents: (value.tempoEvents ?? []).map(createCanonicalTempoEvent), meterEvents: (value.meterEvents ?? []).map(createCanonicalMeterEvent), decisions: (value.decisions ?? []).map(createArbitrationDecision) });
}

export function intake({ name, content, id, authority = 'supporting', meterText = '' }) {
  if (typeof content !== 'string' || new TextEncoder().encode(content).length > MAX_TEXT_BYTES) throw Error('UNSUPPORTED: symbolic file exceeds 4 MiB');
  let project, fragment;
  const options = { sourceId: id, label: name, meterText };
  if (/\.mxl$/i.test(name)) throw Error('UNSUPPORTED: compressed MXL; use uncompressed MusicXML');
  if (/^\s*MML@/i.test(content)) {
    fragment = normalizeMMLSource(content, { ...options, authority: 'derived' });
    project = mmlFragmentToProject(fragment);
  } else if (/^\s*</.test(content)) {
    const official = authority === 'primary-symbolic';
    fragment = ingestMusicXML(content, { ...options, kind: official ? 'official-musicxml' : 'third-party-musicxml', authority: official ? authority : 'supporting' });
    project = musicXMLFragmentToProject(fragment);
  } else project = readCanonical(JSON.parse(content));
  return { name, content, project, format: fragment?.validation ? 'MML' : fragment ? 'MusicXML' : 'Canonical IR', complete: fragment ? fragment.complete : project.metadata.sourceComplete === true,
    warnings: copy(fragment?.validation?.warnings ?? fragment?.warnings ?? project.metadata.warnings ?? []),
    errors: copy(fragment?.validation?.errors ?? project.metadata.errors ?? []), unsupported: copy(fragment?.unsupported ?? project.metadata.unsupported ?? []) };
}

// Raw MIDI arrives as bytes, never as text. The whole decode runs in the
// backend adapter; this is the transport boundary and nothing else.
//
// No id crosses this boundary. The source identity is derived from the bytes
// inside ingestMidiSource, so re-picking one file cannot renumber its source,
// its project or any of its events.
export function intakeMidi({ name, bytes, authority = 'supporting' }) {
  return ingestMidiSource({ name, bytes, authority });
}

export function invalidate(workspace) {
  const next = copy(workspace);
  next.revision++;
  next.reviews = {};
  next.harmonyDecisions = [];
  next.core3Approvals = [];
  next.leadEvidence = [];
  next.audio = null;
  next.acceptance = null;
  return next;
}

export function importWorkspace(raw) {
  const input = JSON.parse(raw);
  if (input?.schema !== WORKSPACE_SCHEMA) throw Error('UNSUPPORTED: workspace schema');
  const clean = newWorkspace();
  clean.title = text(input.title) ? input.title : clean.title;
  clean.settings = { ...clean.settings, ...input.settings };
  for (const slot of ['candidate', 'baseline', 'previous']) {
    const asset = input.assets?.[slot];
    if (!asset) continue;
    // A backup's MIDI asset is re-ingested from the bytes it carries, not
    // restored from the project it claims. Whatever the JSON asserts about the
    // events, what is loaded is what those exact bytes decode to -- and because
    // the identity is derived from those bytes, the slot it lands in does not
    // rename the source.
    if (isRawMidiAsset(asset)) clean.assets[slot] = reingestMidiAsset(asset);
    else clean.assets[slot] = intake({ name: asset.name, content: asset.content, id: `import:${slot}`, meterText: clean.settings.meterText, authority: asset.project?.sources?.[0]?.authority });
  }
  // Portable backups cannot attest who accepted an exact client test. Preserve
  // their old reviews as history, require a fresh review in this workspace.
  if (typeof input.deliveryMml === 'string' && input.deliveryMml.length <= 40000) clean.deliveryMml = input.deliveryMml;
  clean.importedHistory = { reviews: input.reviews, acceptance: input.acceptance, audio: input.audio };
  return clean;
}

export function recordReview(workspace, name, note, evidence) {
  if (!REVIEW_NAMES.includes(name) || !text(note) || !text(evidence)) throw Error('請填寫審核結論及來源／段落證據');
  const next = copy(workspace);
  next.reviews[name] = { revision: workspace.revision, note: note.trim(), evidence: evidence.trim(), at: new Date().toISOString() };
  next.acceptance = null;
  return next;
}

const reviewed = (w, name) => w.reviews?.[name]?.revision === w.revision && text(w.reviews[name].note) && text(w.reviews[name].evidence);
const reviewGate = (w, name) => reviewed(w, name) ? pass(w.reviews[name].note) : pending(`${name.toUpperCase()}_REVIEW_REQUIRED`);
const cleanMetadata = project => ({ ...project, decisions: [], metadata: {} });
const hasUnsupported = asset => !asset || asset.unsupported?.length > 0 || asset.errors?.length > 0 || !asset.complete;

const RAW_MIDI_SLOTS = ['candidate', 'baseline', 'previous'];

// Raw MIDI assets, re-verified and re-derived on every analysis.
//
// Two things are established here and nowhere else. First, the persisted bytes,
// the persisted digest and the digest recorded inside the Canonical source must
// all describe one byte sequence; if they disagree the record cannot identify
// its own source and the gate below fails closed. Second, the G11-B/G11-C
// reading a user sees is derived here, from the project that was just
// re-validated by readCanonical -- never restored from storage. A candidate
// therefore cannot survive the bytes it was read from.
//
// A persisted arrangement, if a restored or imported record still carries one,
// is treated the way readCanonical treats imported status metadata: as data. It
// is reported against its binding and discarded, never displayed as current.
function rawMidiReport(workspace, projects) {
  const entries = [];
  for (const slot of RAW_MIDI_SLOTS) {
    const asset = workspace.assets?.[slot];
    if (!isRawMidiAsset(asset)) continue;
    const integrity = verifyStoredProject(asset, projects[slot]);
    const persistedArrangement = asset.arrangement ? arrangementBinding(asset) : null;
    // A record can claim this format and carry no source block at all. That is
    // a verdict, not a crash: integrity already reports it, and reading the
    // fields defensively keeps the whole analysis from throwing on one asset.
    const source = asset.source ?? {};
    let arrangement = null;
    let error = null;
    if (integrity.verified) {
      try { arrangement = deriveArrangement(projects[slot], { sourceSha256: source.sha256 }); }
      catch (failure) { error = `ARRANGEMENT_DERIVATION_FAILED: ${failure.message}`; }
    }
    entries.push({
      slot,
      name: asset.name,
      source: { id: source.id ?? null, kind: source.kind ?? null, authority: source.authority ?? null, sha256: source.sha256 ?? null, byteLength: source.byteLength ?? null },
      // Re-derived from the stored bytes, never read off the stored record.
      // `claimed` is kept beside it so a disagreement is visible rather than
      // just resolved.
      complete: integrity.complete ?? false,
      claimedComplete: asset.complete === true,
      midi: integrity.midi ?? asset.midi,
      warnings: integrity.warnings ?? asset.warnings ?? [],
      unsupported: integrity.unsupported ?? asset.unsupported ?? [],
      integrity,
      persistedArrangement,
      arrangementSource: 'RECOMPUTED_FROM_SOURCE_PROJECT',
      arrangement,
      error,
    });
  }
  return entries;
}

export function analyzeWorkspace(w) {
  const asset = w.assets?.candidate;
  if (!asset) return { state: 'CANDIDATE', gates: { intake: pending('CANDIDATE_MISSING') }, blockers: ['intake'], tracks: null, rawMidi: [] };
  // Validate even locally restored objects and disregard imported acceptance.
  const candidate = readCanonical(asset.project);
  const baseline = w.assets.baseline ? readCanonical(w.assets.baseline.project) : null;
  const previous = w.assets.previous ? readCanonical(w.assets.previous.project) : null;
  let project = cleanMetadata(candidate);
  const localDecisions = (w.harmonyDecisions ?? []).filter(d => d.revision === w.revision).map(d => createArbitrationDecision(d));
  const decisions = [...candidate.decisions.filter(d => !localDecisions.some(local => local.id === d.id)).map(d => createArbitrationDecision({ ...d, status: 'pending' })), ...localDecisions];
  project = createCanonicalProject({ ...project, decisions, metadata: {
    sourceComplete: !hasUnsupported(asset) && !hasUnsupported(w.assets.baseline) && reviewed(w, 'source'),
    ...(baseline ? { sourceFaithfulBaseline: { snapshot: cleanMetadata(baseline) } } : {}),
  } });
  let audioError = null;
  if (w.audio?.revision === w.revision) {
    try {
      if (w.audio.projectIdentity !== alignmentProjectText(candidate)) throw Error('AUDIO_SYMBOLIC_IDENTITY_UNVERIFIED');
      project = attachAudioAlignmentEvidence(project, w.audio.report);
    }
    catch (error) { audioError = error.message; }
  }
  const rawMml = asset.format === 'MML' ? asset.content : w.deliveryMml;
  const technical = rawMml ? validateMML(rawMml, { meterText: w.settings.meterText }) : null;
  let deliveryMatches = false;
  if (technical?.ok) {
    const delivered = mmlFragmentToProject(normalizeMMLSource(rawMml, { sourceId: 'delivery-readback', meterText: w.settings.meterText }));
    const diff = compareCanonicalVersions(candidate, delivered);
    const meters = p => JSON.stringify(p.meterEvents.map(e => [e.beat, e.numerator, e.denominator]));
    deliveryMatches = diff.structurallyIdentical && meters(candidate) === meters(delivered);
  }
  const lineage = baseline ? compareCandidateLineage({ sourceBaseline: baseline, acceptedPrevious: previous, candidate }) : null;
  const core3 = baseline ? evaluateCore3Continuity({ baseline, candidate, approvedChanges: (w.core3Approvals ?? []).filter(a => a.revision === w.revision) }) : pending('BASELINE_MISSING');
  const harmony = analyzeCrossSourceHarmony(project);
  const leadReports = (w.leadEvidence ?? []).filter(e => e.revision === w.revision).map(e => {
    const event = baseline?.events.find(event => event.id === e.eventId);
    if (!event) throw Error('Lead evidence references an unknown baseline event');
    const move = lineage.sourceToCandidate.notes.roleMoved.find(pair => pair.before.id === event.id);
    const removed = lineage.sourceToCandidate.notes.removed.some(item => item.id === event.id);
    const destination = move?.after.role ?? (removed ? 'omitted' : null);
    if (destination !== e.destinationRole) return { status: 'PENDING', eventId: event.id, blockers: ['LEAD_DESTINATION_DOES_NOT_MATCH_CANDIDATE'] };
    return evaluateLeadDemotion({ ...e, event });
  });
  const audioPresent = Object.values(w.assets).some(a => a.project.sources.some(s => s.kind === 'original-audio')) || Boolean(w.audio);
  const audioRequired = audioPresent || w.settings.audioRequired !== 'no';
  const readiness = evaluateProjectReadiness({ project, mmlValidation: technical, core3Report: core3, harmonyReport: harmony, leadDemotionReports: leadReports, lineageReport: lineage, versionDriftReviewed: reviewed(w, 'version'), originalAudioRequired: audioRequired, playerReadback: w.settings.preview === 'none' && reviewed(w, 'tempo') ? 'N/A' : 'PENDING' });
  const gates = { ...readiness.gates };
  delete gates.inGameAcceptance;
  gates.intake = text(w.title) && text(w.settings.recording) && finiteNumber(w.settings.offset) && finiteNumber(w.settings.end) && Number(w.settings.offset) >= 0 && Number(w.settings.end) > Number(w.settings.offset)
    ? pass('VERSION_AND_RANGE_RECORDED') : pending('RECORDING_VERSION_AND_RANGE_REQUIRED');
  gates.source = hasUnsupported(asset) || hasUnsupported(w.assets.baseline) ? { status: asset.unsupported?.length || w.assets.baseline?.unsupported?.length ? 'UNSUPPORTED' : 'PENDING', reason: 'SOURCE_INCOMPLETE_OR_UNSUPPORTED' } : reviewGate(w, 'source');
  if (w.assets.previous && hasUnsupported(w.assets.previous)) gates.previousSource = pending('PREVIOUS_SOURCE_INCOMPLETE');
  gates.lead = reviewGate(w, 'lead');
  gates.core3 = good(gates.core3) ? reviewGate(w, 'core3') : gates.core3;
  gates.full6 = reviewGate(w, 'full6');
  gates.versionDrift = baseline && good(gates.versionDrift) ? reviewGate(w, 'version') : pending('BASELINE_OR_VERSION_REVIEW_MISSING');
  gates.tempo = reviewGate(w, 'tempo');
  gates.originalAudio = audioError ? pending(audioError) : good(gates.originalAudio) ? audioRequired ? reviewGate(w, 'audio') : { status: 'N/A', reason: 'USER_DECLARED_NO_ORIGINAL_AUDIO' } : gates.originalAudio;
  gates.adaptation = reviewGate(w, 'adaptation');
  gates.regression = reviewGate(w, 'regression');
  gates.deliveryIdentity = deliveryMatches ? pass('EXACT_SYMBOLIC_READBACK') : pending('MML_AND_CANDIDATE_IDENTITY_NOT_VERIFIED');
  const rawMidi = rawMidiReport(w, { candidate, baseline, previous });
  if (rawMidi.length) {
    // Byte identity only. It states that the stored bytes are the bytes this
    // source record names -- never that the source is complete, reviewed or
    // accepted, which gates.source and the reviews above decide separately.
    const unverified = rawMidi.filter(item => !item.integrity.verified || item.error);
    const staleStored = rawMidi.filter(item => item.persistedArrangement && !item.persistedArrangement.current);
    gates.rawMidiSource = unverified.length
      ? { status: 'UNSUPPORTED', reason: `RAW_MIDI_SOURCE_IDENTITY_UNVERIFIED: ${unverified.map(item => `${item.slot}: ${[...item.integrity.reasons, item.error].filter(Boolean).join(', ')}`).join(' · ')}` }
      : staleStored.length
        ? pending(`STALE_STORED_ARRANGEMENT_DISCARDED: ${staleStored.map(item => `${item.slot}: ${item.persistedArrangement.reasons.join(', ')}`).join(' · ')}`)
        : pass('RAW_MIDI_BYTES_MATCH_SOURCE_IDENTITY');
    // The source gate reads the same recomputed verdict. A stored record that
    // claims a completeness its own bytes do not support cannot pass it, and a
    // recorded source review cannot stand in for the missing evidence.
    const contradicted = rawMidi.filter(item => !item.complete || !item.integrity.verified);
    if (contradicted.length && good(gates.source)) {
      gates.source = { status: contradicted.some(item => item.unsupported.length) ? 'UNSUPPORTED' : 'PENDING', reason: 'SOURCE_INCOMPLETE_OR_UNSUPPORTED' };
    }
  }
  // All statuses outside the Canonical vocabulary remain visibly pending.
  for (const [name, gate] of Object.entries(gates)) if (!['PASS', 'FAIL', 'PENDING', 'UNSUPPORTED', 'N/A'].includes(gate.status)) gates[name] = pending(gate.status ?? 'UNKNOWN');
  const blockers = Object.keys(gates).filter(name => !good(gates[name]));
  const validated = blockers.length === 0;
  const acceptance = w.acceptance;
  const accepted = validated && acceptance?.revision === w.revision && acceptance.exactMml === rawMml?.trim() && acceptance.outcome === 'accepted' && ['client', 'instrument', 'evidence', 'at'].every(k => text(acceptance[k]));
  return { state: accepted ? 'IN_GAME_ACCEPTED' : validated ? 'VALIDATED' : 'CANDIDATE', gates, blockers, technical, core3, harmony, lineage, leadReports, readiness, rawMidi,
    tracks: technical?.ok && deliveryMatches ? splitMML(rawMml) : null, rawMml: technical?.ok && deliveryMatches ? rawMml.trim() : null,
    historicalRegression: 'FIXTURE_PENDING', audioError, importedDecisions: candidate.decisions };
}

export function recordAcceptance(w, details) {
  const report = analyzeWorkspace(w);
  if (report.state !== 'VALIDATED' && report.state !== 'IN_GAME_ACCEPTED') throw Error('所有必要非實機 Gate 通過後，才能記錄實機接受');
  if (!['client', 'instrument', 'evidence'].every(k => text(details[k]))) throw Error('需要 client／樂器及實機證據');
  return { ...copy(w), acceptance: { ...details, revision: w.revision, exactMml: report.rawMml, outcome: 'accepted', at: new Date().toISOString() } };
}
