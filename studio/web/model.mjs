import { createSource, createCanonicalNoteEvent, createCanonicalRestEvent, createCanonicalTempoEvent, createCanonicalMeterEvent, createCanonicalProject, createArbitrationDecision } from '../backend/canonical/index.mjs';
import { normalizeMMLSource, mmlFragmentToProject } from '../backend/mml/canonicalize.mjs';
import { validateMML, splitMML } from '../backend/mml/parser.mjs';
import { ingestMusicXML, musicXMLFragmentToProject, decodeMusicXMLBytes, isZipContainer } from '../backend/score/index.mjs';
import { compareCandidateLineage, compareCanonicalVersions } from '../backend/compare/version-drift.mjs';
import { evaluateCore3Continuity } from '../backend/arbitration/core3.mjs';
import { evaluateCore3Completeness } from '../backend/arbitration/core3-completeness.mjs';
import { evaluateLeadDemotion, evaluateLeadPromotion, singleSourceIdentityOf } from '../backend/arbitration/lead-demotion.mjs';
import { SIX_ROLES } from '../backend/arrangement/decision-application.mjs';
import { baselineOriginEvent } from '../backend/arrangement/decision-review.mjs';
import { analyzeCrossSourceHarmony } from '../backend/arbitration/harmony.mjs';
import { evaluateProjectReadiness, emitFinalMml, EMIT_STATUS, DIAGNOSTIC_SEVERITY } from '../backend/final/index.mjs';
import { attachAudioAlignmentEvidence } from '../backend/audio/index.mjs';
import { alignmentProjectText } from './audio-payload.mjs';
import { arrangementBinding, deriveArrangement, ingestMidiSource, isRawMidiAsset, reingestMidiAsset, verifyStoredProject } from './midi-source.mjs';
import { acceptedArrangementBinding, acceptedDecisionBindings, acceptedRevisionHead, buildAcceptedDecisionRecord, deriveAcceptedArrangement } from './arrangement-decisions.mjs';
import { planMobileAdaptation, applyMobileAdaptation } from '../backend/adaptation/index.mjs';
import { planFinalReduction, applyFinalReduction } from '../backend/reduction/index.mjs';
import { buildRollProjection } from './roll-model.mjs';
import { compareReadback, normalizeCapture } from './preview/readback.mjs';
import { sanitizeStoredNotes } from './listen-notes.mjs';

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
  return { schema: WORKSPACE_SCHEMA, id: crypto.randomUUID(), title: '未命名專案', revision: 0, assets: {}, settings: { meterText: '', recording: '', offset: '', end: '', audioRequired: 'unknown', preview: 'unknown' }, reviews: {}, harmonyDecisions: [], core3Approvals: [], leadEvidence: [], leadPromotionEvidence: [], acceptedDecisions: [], audio: null, acceptance: null };
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

export function intake({ name, content, id, authority = 'supporting', meterText = '', container = null }) {
  if (typeof content !== 'string' || new TextEncoder().encode(content).length > MAX_TEXT_BYTES) throw Error('UNSUPPORTED: symbolic file exceeds 4 MiB');
  let project, fragment;
  const options = { sourceId: id, label: name, meterText };
  // An archive read as text is not MusicXML; compressed MusicXML arrives as
  // bytes through intakeMxl, which opens the container first.
  if (/^PK\u0003\u0004/.test(content)) throw Error('UNSUPPORTED: compressed MusicXML (.mxl) must be picked as a file so its bytes can be opened');
  if (/^\s*MML@/i.test(content)) {
    fragment = normalizeMMLSource(content, { ...options, authority: 'derived' });
    project = mmlFragmentToProject(fragment);
  } else if (/^\s*</.test(content)) {
    const official = authority === 'primary-symbolic';
    fragment = ingestMusicXML(content, { ...options, kind: official ? 'official-musicxml' : 'third-party-musicxml', authority: official ? authority : 'supporting', container });
    project = musicXMLFragmentToProject(fragment);
  } else project = readCanonical(JSON.parse(content));
  return { name, content, project, format: fragment?.validation ? 'MML' : fragment ? (container ? 'MusicXML (compressed .mxl)' : 'MusicXML') : 'Canonical IR', complete: fragment ? fragment.complete : project.metadata.sourceComplete === true,
    ...(container ? { container } : {}),
    warnings: copy(fragment?.validation?.warnings ?? fragment?.warnings ?? project.metadata.warnings ?? []),
    errors: copy(fragment?.validation?.errors ?? project.metadata.errors ?? []), unsupported: copy(fragment?.unsupported ?? project.metadata.unsupported ?? []) };
}

// Compressed MusicXML arrives as bytes. The shared score reader opens the ZIP
// container (magic bytes, META-INF/container.xml, bounded inflate, CRC and
// path checks) exactly as the service intake does; the extracted document is
// then ingested as MusicXML, and the asset records which archive entry it came
// from and that entry's digest. The workspace keeps the extracted XML as the
// asset's text, so a backup restores it as the MusicXML it was read as.
export function intakeMxl({ name, bytes, id, authority = 'supporting', meterText = '' }) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isZipContainer(data)) throw Error('UNSUPPORTED: not a compressed MusicXML (.mxl) archive');
  let decoded;
  try { decoded = decodeMusicXMLBytes(data); } catch (error) { throw Error(`UNSUPPORTED: compressed MusicXML refused: ${error.message}`); }
  return intake({ name, content: decoded.xml, id, authority, meterText, container: decoded.container });
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
  next.leadPromotionEvidence = [];
  // An accepted arrangement decision is bound to the exact baseline, source and
  // lane decomposition it was reviewed against. Once the revision moves, every
  // one of those bindings is a claim about inputs that are no longer loaded, so
  // the records go the way harmony decisions, Core3 approvals and Lead evidence
  // already go: dropped, to be re-accepted against what is actually there.
  next.acceptedDecisions = [];
  next.audio = null;
  next.acceptance = null;
  // A player readback describes one exact string at one revision.
  delete next.playerReadback;
  // A delivery MML is the exact string for one exact candidate. Once the
  // candidate, its sources or the project settings change, that string is no
  // longer the delivery for what is now on screen. Leaving it behind is what
  // made a superseded delivery stay copyable as the current Final, so it is
  // dropped here with the derived generation record that describes it.
  delete next.deliveryMml;
  delete next.deliveryBinding;
  delete next.finalDelivery;
  delete next.mobileAdaptation;
  // The reduction is an input record too, and it is bound to the exact baseline
  // and candidate it was previewed against. Once the revision moves, that plan
  // describes material that is no longer loaded, so it goes the way the Mobile
  // profile and every accepted decision go: dropped, to be re-previewed.
  delete next.finalReduction;
  return next;
}

// ─── G12 Final Six-Role Reduction ───────────────────────────────────────────
//
// The same two operations the Agent plane has, over the local workspace:
// `previewFinalReduction` is read-only, and applying persists the *inputs* --
// the accepted decisions, the plan id and the reviewer -- never a derived
// candidate and never a PASS. Every analysis re-derives the reduction from the
// sources that are loaded now, so a restored workspace is re-checked rather
// than believed, and a stale plan is refused there exactly as it is here.

export function previewFinalReduction(workspace, decisions = [], { acceptedBy = 'reduction-preview', instrumentProfile = null } = {}) {
  if (!workspace.assets?.baseline || !workspace.assets?.candidate) throw Error('Final Six-Role Reduction 需要來源基準與候選');
  return planFinalReduction({
    baseline: readCanonical(workspace.assets.baseline.project),
    candidate: readCanonical(workspace.assets.candidate.project),
    decisions,
    acceptedBy,
    instrumentProfile,
  });
}

export function applyWorkspaceFinalReduction(workspace, { decisions, expectedPlanId, acceptedBy }) {
  if (!workspace.assets?.baseline || !workspace.assets?.candidate) throw Error('Final Six-Role Reduction 需要來源基準與候選');
  const application = applyFinalReduction({
    baseline: readCanonical(workspace.assets.baseline.project),
    candidate: readCanonical(workspace.assets.candidate.project),
    decisions,
    expectedPlanId,
    acceptedBy,
  });
  if (!application.didApply) return { workspace, applied: false, plan: application.plan, blockers: application.blockers, unchanged: application.unchanged ?? false };
  const next = invalidate(workspace);
  next.finalReduction = { decisions: copy(application.plan.decisions), expectedPlanId: application.plan.id, acceptedBy };
  return { workspace: next, applied: true, plan: application.plan };
}

/** Return to the pre-reduction candidate. The reduction inputs are dropped. */
export function clearFinalReduction(workspace) {
  return invalidate(workspace);
}

/**
 * The candidate Mobile adaptation actually addresses.
 *
 * Reduction and adaptation are two layers in one order: reduction resolves role
 * and six-role capacity, adaptation then answers target register and volume for
 * the roles that survived it. So an adaptation preview reads the reduced
 * candidate, not the pre-reduction one -- otherwise it would plan against roles
 * the reduction has already changed, and a role the reduction placed would look
 * unassigned. A workspace with no stored reduction is its own candidate.
 */
function adaptationInput(workspace) {
  if (!workspace.assets?.baseline || !workspace.assets?.candidate) throw Error('Mobile 適配需要來源基準與候選');
  const baseline = readCanonical(workspace.assets.baseline.project);
  let candidate = readCanonical(workspace.assets.candidate.project);
  if (workspace.finalReduction) {
    const { decisions, expectedPlanId, acceptedBy } = workspace.finalReduction;
    const application = applyFinalReduction({ baseline, candidate, decisions, expectedPlanId, acceptedBy });
    if (!application.didApply) throw Error(application.blockers?.map(item => item.code).join(', ') || 'FINAL_REDUCTION_NOT_APPLIED');
    candidate = application.candidate;
  }
  return { baseline, candidate };
}

export function previewMobileAdaptation(workspace, profile) {
  const { baseline, candidate } = adaptationInput(workspace);
  return planMobileAdaptation({ baseline, candidate, profile });
}

export function applyWorkspaceMobileAdaptation(workspace, { profile, expectedPlanId, acceptedBy }) {
  const { baseline, candidate } = adaptationInput(workspace);
  const application = applyMobileAdaptation({ baseline, candidate, profile, expectedPlanId, acceptedBy });
  if (!application.didApply) return { workspace, applied: false, plan: application.plan, blockers: application.blockers, unchanged: application.unchanged ?? false };
  const next = invalidate(workspace);
  // The adaptation was computed on top of the reduction, so the reduction has
  // to survive with it. `invalidate` drops it as a source-bound record; it is
  // carried back explicitly, unchanged, because it is the input the adapted
  // candidate is derived from. The reverse does not hold: applying a reduction
  // invalidates an earlier adaptation, which was planned against roles the
  // reduction has now changed.
  if (workspace.finalReduction) next.finalReduction = copy(workspace.finalReduction);
  // Persist inputs, not a trusted derived candidate or PASS. Re-derive on every
  // analysis, including restore from IndexedDB. Original source assets survive.
  next.mobileAdaptation = { profile: application.plan.profile, expectedPlanId: application.plan.id, acceptedBy };
  return { workspace: next, applied: true, plan: application.plan };
}

export function clearMobileAdaptation(workspace) {
  return invalidate(workspace);
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
  //
  // The delivery text is carried, its status is not. `deliveryBinding` and
  // `finalDelivery` are deliberately never restored: a backup asserting
  // `finalDelivery.status === 'PASS'` is describing a generation nobody can
  // re-check from the file. Without a binding the carried text is treated as a
  // pasted delivery, which is re-validated and read back against the candidate
  // from scratch on every analysis -- the same treatment imported reviews get.
  if (typeof input.deliveryMml === 'string' && input.deliveryMml.length <= 40000) clean.deliveryMml = input.deliveryMml;
  // Accepted arrangement decisions travel as history for the same reason. A
  // backup cannot attest that its decisions were reviewed against the bytes
  // this workspace just re-ingested, and a backup asserting an applied
  // candidate is describing an application nobody can re-check from the file.
  // A reduction record travels as history for the same reason: a backup cannot
  // attest that its plan was reviewed against the bytes this workspace just
  // re-ingested, and an imported plan id is a claim about a derivation nobody
  // can re-check from the file. It is preserved and shown, never restored into
  // the live `finalReduction` slot, so the reduction has to be previewed and
  // accepted again against what is actually loaded.
  // Listening notes (listen-ui.mjs) are the owner's plain-text remarks about an
  // exact MML string, keyed by its sha256. They are not reviews or evidence and
  // no analysis reads them, so they travel as data, cleaned note by note.
  const listeningNotes = sanitizeStoredNotes(input.listeningNotes);
  if (listeningNotes.length) clean.listeningNotes = listeningNotes;
  clean.importedHistory = { reviews: input.reviews, acceptance: input.acceptance, audio: input.audio, acceptedDecisions: input.acceptedDecisions, leadEvidence: input.leadEvidence, leadPromotionEvidence: input.leadPromotionEvidence, mobileAdaptation: input.mobileAdaptation, finalReduction: input.finalReduction, playerReadback: input.playerReadback };
  return clean;
}

// Record one explicitly accepted arrangement decision.
//
// The bindings are computed here from the project and lanes that are loaded
// now, so a decision cannot be recorded as accepted against inputs that are not
// on screen. `acceptedDecisionBindings` is exported for the same reason: a UI
// fills an acceptance block from what is loaded, never from what it remembers.
//
// `reviewedRevisionId` is the caller's statement of which G11-D revision the
// reviewer looked at. It is checked against the head of the chain this call
// re-derives from the stored records: null when no revision exists yet, the
// last PASS revision's id otherwise. A decision cannot be recorded against a
// revision that is not the verified head -- not a superseded one, not a
// sibling, not one an import claims -- so the chain stays linear and every
// recorded decision names a parent the backend has actually built.
export function recordAcceptedDecision(workspace, decision, { reviewedRevisionId = null } = {}) {
  const asset = workspace.assets?.candidate;
  if (!isRawMidiAsset(asset)) throw Error('UNSUPPORTED: accepted arrangement decisions need a raw MIDI candidate source');
  const project = readCanonical(asset.project);
  const integrity = verifyStoredProject(asset, project);
  if (!integrity.verified) throw Error(`SOURCE_INTEGRITY_UNVERIFIED: ${integrity.reasons.join(', ')}`);
  const arrangement = deriveArrangement(project, { sourceSha256: asset.source?.sha256 });
  const current = deriveAcceptedArrangement({
    project,
    suggestion: arrangement.candidate,
    records: workspace.acceptedDecisions,
    revision: workspace.revision,
    sourceSha256: asset.source?.sha256,
  });
  const head = acceptedRevisionHead(current);
  if (reviewedRevisionId !== head) {
    throw Error(`STALE_ACCEPTED_DECISION: DECISION_REVIEWED_REVISION_NOT_CHAIN_HEAD (expected ${head ?? 'null'}, observed ${reviewedRevisionId ?? 'null'})`);
  }
  const record = buildAcceptedDecisionRecord({
    project,
    suggestion: arrangement.candidate,
    revision: workspace.revision,
    reviewedRevisionId,
    decision,
  });
  const next = copy(workspace);
  next.acceptedDecisions = [...(next.acceptedDecisions ?? []), record];
  next.acceptance = null;
  return next;
}

export function clearAcceptedDecisions(workspace) {
  const next = copy(workspace);
  next.acceptedDecisions = [];
  next.acceptance = null;
  return next;
}

export { acceptedDecisionBindings };

// ─── G11-D Decision Composer ────────────────────────────────────────────────
//
// The page composes one decision on the review roll; everything that makes it
// an acceptance happens on this side. The page never supplies an acceptance
// block, a binding or an id: `previewAcceptedDecision` fills the bindings from
// what is loaded, builds the record exactly as recording would, and
// re-derives the whole chain with that record appended, writing nothing.
// `acceptPreviewedDecision` rebuilds the same record and records it only if
// its digest is the one the reviewer was shown, so an acceptance always names
// the dry run that was actually previewed -- the same shape as the reduction
// and Mobile adaptation preview/apply pairs.
const COMPOSER_DRAFT_KEYS = Object.freeze(['type', 'eventIds', 'toRole', 'toRoles', 'reason', 'evidence', 'note']);
const COMPOSER_TYPES = Object.freeze(['ASSIGN_ROLE', 'MOVE_ROLE', 'OMIT_FROM_SIX', 'DUPLICATE_WITH_JUSTIFICATION', 'KEEP']);
export const COMPOSER_ACCEPTED_BY = 'local-workspace-user';

function composerContext(workspace) {
  if (workspace.finalReduction || workspace.mobileAdaptation) throw Error('UNSUPPORTED: Final 收斂或 Mobile 適配已套用；先移除它們，才能記錄編排決策');
  const asset = workspace.assets?.candidate;
  if (!isRawMidiAsset(asset)) throw Error('UNSUPPORTED: accepted arrangement decisions need a raw MIDI candidate source');
  const project = readCanonical(asset.project);
  const integrity = verifyStoredProject(asset, project);
  if (!integrity.verified) throw Error(`SOURCE_INTEGRITY_UNVERIFIED: ${integrity.reasons.join(', ')}`);
  const arrangement = deriveArrangement(project, { sourceSha256: asset.source?.sha256 });
  const current = deriveAcceptedArrangement({ project, suggestion: arrangement.candidate, records: workspace.acceptedDecisions, revision: workspace.revision, sourceSha256: asset.source?.sha256 });
  if (!['NOT_REQUESTED', 'PASS'].includes(current.status)) throw Error(`STALE_ACCEPTED_DECISION: 目前的決策鏈未通過（${current.status}）；請先清除決策再重新編排`);
  // Roles as the next decision will find them: the verified head, or the
  // Source-Faithful Baseline before any decision.
  const roles = new Map((current.status === 'PASS' ? current.application.candidate : project).events.filter(e => e.kind === 'note').map(e => [e.id, e.role ?? null]));
  return { asset, project, arrangement, current, head: acceptedRevisionHead(current), roles };
}

function composeDecision(workspace, context, draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw Error('decision draft must be an object');
  for (const key of Object.keys(draft)) if (!COMPOSER_DRAFT_KEYS.includes(key)) throw Error(`decision draft may not carry ${key}`);
  if (!COMPOSER_TYPES.includes(draft.type)) throw Error(`unsupported decision type: ${draft.type}`);
  const eventIds = Array.isArray(draft.eventIds) ? [...new Set(draft.eventIds)] : [];
  if (!eventIds.length || eventIds.some(id => typeof id !== 'string')) throw Error('請先在捲軸上選取至少一個事件');
  const missing = eventIds.filter(id => !context.roles.has(id));
  if (missing.length) throw Error(`選取的事件不在目前的來源中：${missing.slice(0, 3).join(', ')}`);
  const before = [...new Set(eventIds.map(id => context.roles.get(id)))];
  const fromRole = before.length === 1 ? before[0] : undefined;
  if (['MOVE_ROLE', 'DUPLICATE_WITH_JUSTIFICATION'].includes(draft.type) && (fromRole === undefined || fromRole === null)) throw Error('這個決策需要選取的事件目前同屬一個角色');
  const evidence = (Array.isArray(draft.evidence) ? draft.evidence : String(draft.evidence ?? '').split('\n')).map(item => String(item).trim()).filter(Boolean);
  const decision = {
    id: `web:g11d:${workspace.revision}:${(workspace.acceptedDecisions?.length ?? 0) + 1}`,
    type: draft.type,
    target: { eventIds: [...eventIds].sort() },
    reason: String(draft.reason ?? '').trim(),
    evidence,
    acceptance: { ...acceptedDecisionBindings({ project: context.project, suggestion: context.arrangement.candidate, reviewedRevisionId: context.head }), acceptedBy: COMPOSER_ACCEPTED_BY, ...(text(draft.note) ? { note: draft.note.trim() } : {}) },
  };
  if (draft.type === 'MOVE_ROLE' || draft.type === 'DUPLICATE_WITH_JUSTIFICATION') decision.fromRole = fromRole;
  if (draft.type === 'ASSIGN_ROLE' || draft.type === 'MOVE_ROLE') decision.toRole = draft.toRole;
  if (draft.type === 'DUPLICATE_WITH_JUSTIFICATION') decision.toRoles = draft.toRoles;
  return decision;
}

// Read-only dry run of one composed decision on top of the recorded chain.
export function previewAcceptedDecision(workspace, draft) {
  const context = composerContext(workspace);
  const decision = composeDecision(workspace, context, draft);
  const record = buildAcceptedDecisionRecord({ project: context.project, suggestion: context.arrangement.candidate, revision: workspace.revision, reviewedRevisionId: context.head, decision });
  const derived = deriveAcceptedArrangement({ project: context.project, suggestion: context.arrangement.candidate, records: [...(workspace.acceptedDecisions ?? []), record], revision: workspace.revision, sourceSha256: context.asset.source?.sha256 });
  const application = derived.application;
  return copy({
    projectId: workspace.id, revision: workspace.revision, reviewedRevisionId: context.head,
    recordDigest: record.recordDigest, decision: record.decision,
    status: derived.status,
    applied: (application?.applied ?? []).map(item => ({ decisionId: item.decisionId, type: item.type, events: item.events.map(e => ({ eventId: e.eventId, fromRole: e.fromRole, toRole: e.toRole })) })),
    rejected: application?.rejected ?? [], conflicts: application?.conflicts ?? [], stale: application?.stale ?? [],
    diagnostics: application?.diagnostics ?? [], omitted: application?.omitted?.length ?? 0,
    diffFromBaseline: application?.diffFromBaseline?.summary ?? null,
    chain: derived.chain,
    // What the roll would show if this were accepted; a projection, never stored.
    roll: derived.status === 'PASS' ? buildRollProjection(application.candidate) : null,
  });
}

// Record the previewed decision, and only that one.
export function acceptPreviewedDecision(workspace, draft, { expectedRecordDigest } = {}) {
  const preview = previewAcceptedDecision(workspace, draft);
  if (preview.recordDigest !== expectedRecordDigest) throw Error('STALE_ACCEPTED_DECISION: 目前的內容與預覽時不同，請重新預覽');
  if (preview.status !== 'PASS') throw Error(`預覽結果為 ${preview.status}，不能接受；請依預覽列出的原因修改決策`);
  const context = composerContext(workspace);
  return recordAcceptedDecision(workspace, composeDecision(workspace, context, draft), { reviewedRevisionId: context.head });
}

// Record the Lead Demotion Gate evidence for one baseline Melody event.
//
// The pre-G11-D Lead path. The page used to build this record itself, reaching
// into `event.sourceIds[0]` / `event.sourceEventIds[0]`; that was array-index
// pairing, which the shared identity binding refuses for a multi-source event.
// The record is now constructed here, behind the Worker, from the baseline
// event that is loaded: the identity comes from `singleSourceIdentityOf()`, the
// one constructor the gate module offers, and is bound to the event at analysis
// time by the gate itself. A form never supplies an identity.
//
// Nothing here evaluates the evidence. The gate runs on every analysis against
// the baseline event the record names, so a stored record that was edited
// afterwards is judged by what it says then, not by what was recorded now.
export const LEAD_DESTINATIONS = Object.freeze([...SIX_ROLES.filter(role => role !== 'Melody'), 'omitted']);

export function recordLeadEvidence(workspace, form) {
  if (!form || typeof form !== 'object') throw Error('Lead evidence form is required');
  if (!LEAD_DESTINATIONS.includes(form.destinationRole)) throw Error('目標角色必須為 Chord1–Chord5 或 omitted');
  const event = workspace.assets?.baseline?.project?.events?.find(item => item.id === form.eventId && item.role === 'Melody');
  if (!event) throw Error('找不到基準 Melody event');
  const checked = form.continuity === 'checked';
  const record = {
    eventId: event.id,
    destinationRole: form.destinationRole,
    // null for a multi-source event: the pairing cannot be proven from the IR,
    // and the gate reports it rather than this record guessing it.
    sourceIdentity: singleSourceIdentityOf(event) ? { ...singleSourceIdentityOf(event) } : null,
    sectionRole: form.sectionRole,
    scoreEvidence: { availability: text(form.scoreCitation) ? 'available' : 'unavailable', classification: form.scoreClass, citation: form.scoreCitation },
    audioEvidence: { availability: text(form.audioCitation) ? 'available' : 'unavailable', classification: form.audioClass, citation: form.audioCitation },
    positiveReason: form.positiveReason,
    continuity: { checked, createsLeadGap: checked ? false : null, replacementEventIds: [] },
    core3: { checked, status: checked ? 'PASS' : 'PENDING' },
    revision: workspace.revision,
  };
  const next = copy(workspace);
  next.acceptance = null;
  next.leadEvidence = [...(next.leadEvidence ?? []).filter(item => item.eventId !== event.id), record];
  return next;
}

// Record the Lead Promotion Gate evidence for one candidate Melody event.
//
// The symmetric half of `recordLeadEvidence` above, and deliberately a separate
// writer rather than an extra branch in it: that function's refusals ("the
// destination must be Chord1-Chord5 or omitted", "no such baseline Melody
// event") are the demotion contract, and loosening them to admit a promotion
// would remove the guard rather than add a path.
//
// Two event ids, because a promotion has two. `promotedEventId` is the
// *candidate* Melody event, which is what the shared readiness gate keys on: a
// role move keeps the source event id, while a justified duplicate gets a
// derived one. `originEventId` is the Source-Faithful *baseline* event the
// citation is bound to, resolved through the same reversible derived-duplicate
// chain the Agent/Application plane walks -- so a duplicate's derived id cannot
// be used to launder a citation, and nothing is matched by pitch, time or array
// order.
//
// As with demotion, nothing here evaluates anything. The record is data, and
// the shared promotion grader judges it on every analysis against the baseline
// event it names.
export const LEAD_PROMOTION_DESTINATION = 'Melody';

export function recordLeadPromotionEvidence(workspace, form) {
  if (!form || typeof form !== 'object') throw Error('Lead promotion evidence form is required');
  if ((form.destinationRole ?? LEAD_PROMOTION_DESTINATION) !== LEAD_PROMOTION_DESTINATION) throw Error('目標角色必須為 Melody');
  const candidate = workspace.assets?.candidate?.project ?? null;
  const baseline = workspace.assets?.baseline?.project ?? null;
  if (!baseline) throw Error('需要 Source-Faithful Baseline 才能提交 Lead 升級證據');

  const promoted = (candidate?.events ?? []).find(item => item.id === form.promotedEventId && item.role === LEAD_PROMOTION_DESTINATION);
  if (!promoted) throw Error('找不到候選 Melody event');

  // The origin is the baseline event this promotion came from: the same id for
  // a role move, or the head of the derived chain for a duplicate. An explicit
  // originEventId is accepted, but it is resolved against the baseline here --
  // a form never supplies an identity.
  const origin = baselineOriginEvent(baseline, candidate, form.originEventId || form.promotedEventId);
  if (!origin) throw Error('找不到基準來源 event（無法回溯到 Source-Faithful Baseline）');
  if (origin.role === LEAD_PROMOTION_DESTINATION) throw Error('來源事件已是 Melody，這不是一次升級');

  const checked = form.continuity === 'checked';
  const record = {
    promotedEventId: promoted.id,
    originEventId: origin.id,
    destinationRole: LEAD_PROMOTION_DESTINATION,
    // null for a multi-source origin: the pairing cannot be proven from the IR,
    // and the gate reports it rather than this record guessing it.
    sourceIdentity: singleSourceIdentityOf(origin) ? { ...singleSourceIdentityOf(origin) } : null,
    sectionRole: form.sectionRole,
    scoreEvidence: { availability: text(form.scoreCitation) ? 'available' : 'unavailable', classification: form.scoreClass, citation: form.scoreCitation },
    audioEvidence: { availability: text(form.audioCitation) ? 'available' : 'unavailable', classification: form.audioClass, citation: form.audioCitation },
    positiveReason: form.positiveReason,
    continuity: { checked, createsLeadGap: checked ? false : null, replacementEventIds: [] },
    core3: { checked, status: checked ? 'PASS' : 'PENDING' },
    revision: workspace.revision,
  };
  const next = copy(workspace);
  next.acceptance = null;
  next.leadPromotionEvidence = [...(next.leadPromotionEvidence ?? []).filter(item => item.promotedEventId !== promoted.id), record];
  return next;
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
    let acceptedArrangement = null;
    let error = null;
    if (integrity.verified) {
      try { arrangement = deriveArrangement(projects[slot], { sourceSha256: source.sha256 }); }
      catch (failure) { error = `ARRANGEMENT_DERIVATION_FAILED: ${failure.message}`; }
      // G11-D, re-derived from the same re-validated project and the same
      // freshly computed G11-C lanes. A stored application is never restored:
      // an accepted decision that survived in storage across a source change is
      // refused by its own bindings rather than replayed.
      if (arrangement && slot === 'candidate') {
        try {
          acceptedArrangement = deriveAcceptedArrangement({
            project: projects[slot],
            suggestion: arrangement.candidate,
            records: workspace.acceptedDecisions,
            revision: workspace.revision,
            sourceSha256: source.sha256,
          });
        } catch (failure) { error = `ACCEPTED_ARRANGEMENT_DERIVATION_FAILED: ${failure.message}`; }
      }
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
      acceptedArrangement,
      persistedAcceptedArrangement: asset.acceptedArrangement
        ? acceptedArrangementBinding({ stored: asset.acceptedArrangement, project: projects[slot], revision: workspace.revision, sourceSha256: source.sha256, derived: acceptedArrangement })
        : null,
      error,
    });
  }
  return entries;
}

// Delivery identity, decided in exactly one place.
//
// A candidate written in MML and a delivery MML are different things. The
// candidate is a source representation; the delivery is the exact text that is
// pasted into the game. Reading the candidate's own bytes while an explicit
// delivery exists grades a string nobody delivers -- and because the readback
// re-normalizes those same bytes with the same meter, it also reduces
// `deliveryIdentity` to a comparison of the candidate with itself.
//
// An explicit delivery therefore always wins. The candidate's own text stays the
// fallback only when no separate delivery exists, which remains the useful
// behavior for a project whose candidate is itself the delivered score.
function currentDelivery(w) {
  if (typeof w.deliveryMml !== 'string' || !w.deliveryMml.trim()) return null;
  const binding = w.deliveryBinding;
  // A record stored before delivery binding existed, or restored from a backup,
  // carries no binding. It is read as a pasted delivery at the current revision:
  // nothing about it is trusted either way, because every delivery is
  // re-validated and read back below whatever its origin.
  if (!binding) return { mml: w.deliveryMml, origin: 'pasted' };
  // Bound to a superseded revision. `invalidate` already drops the delivery, so
  // this only catches a result applied across a revision change -- but a stale
  // delivery must never be able to present itself as the current Final.
  if (binding.revision !== w.revision) return null;
  return { mml: w.deliveryMml, origin: binding.origin === 'generated' ? 'generated' : 'pasted' };
}

function selectDelivery(w, asset) {
  return currentDelivery(w)
    ?? (asset.format === 'MML' ? { mml: asset.content, origin: 'candidate-source' } : { mml: undefined, origin: null });
}

// The authoritative delivery check: technical syntax, then exact symbolic
// readback against the candidate. Analysis and Final generation both call this
// one function, so a generated delivery is verified by the same code that
// verifies a pasted one. There is no second validator.
function verifyDelivery(candidate, rawMml, meterText) {
  const technical = rawMml ? validateMML(rawMml, { meterText }) : null;
  let deliveryMatches = false;
  if (technical?.ok) {
    const delivered = mmlFragmentToProject(normalizeMMLSource(rawMml, { sourceId: 'delivery-readback', meterText }));
    const diff = compareCanonicalVersions(candidate, delivered);
    const meters = p => JSON.stringify(p.meterEvents.map(e => [e.beat, e.numerator, e.denominator]));
    deliveryMatches = diff.structurallyIdentical && meters(candidate) === meters(delivered);
  }
  return { technical, deliveryMatches };
}

// ─── Gate 6 player readback ─────────────────────────────────────────────────
//
// N/A only on the existing path: the user declared no player/preview was used
// and the Tempo review is current. PASS only when the user declared the player
// was used, the Tempo review is current, and a stored capture of what the
// preview engine processed -- for this revision and this exact delivery
// string, the whole song from the start with no role muted -- matches an
// independent parse of that string. The comparison is recomputed here on every
// analysis; a stored verdict is never read. Anything else stays PENDING.
function playerReadbackGate(w, rawMml, technical, deliveryMatches) {
  const tempo = reviewed(w, 'tempo');
  const result = (status, reason, summary = null) => ({ status, reason, summary });
  if (w.settings.preview === 'none') return tempo ? result('N/A', 'USER_DECLARED_NO_PREVIEW') : result('PENDING', 'TEMPO_REVIEW_REQUIRED');
  if (w.settings.preview !== 'used') return result('PENDING', 'PREVIEW_USE_NOT_DECLARED');
  const record = w.playerReadback;
  if (!record) return result('PENDING', 'PLAYER_READBACK_NOT_RECORDED');
  const exact = technical?.ok && deliveryMatches && typeof rawMml === 'string' ? rawMml.trim() : null;
  if (record.revision !== w.revision || record.workspaceId !== w.id) return result('PENDING', 'PLAYER_READBACK_STALE_REVISION');
  if (!exact || record.exactMml !== exact) return result('PENDING', 'PLAYER_READBACK_MML_CHANGED');
  let capture;
  try { capture = normalizeCapture(record.capture); } catch (error) { return result('PENDING', `PLAYER_READBACK_INVALID: ${error.message}`); }
  const comparison = compareReadback(technical.song, capture);
  const summary = { recordedAt: record.recordedAt, bank: capture.bank, engine: capture.engine, program: capture.program, scope: capture.scope,
    gameTimbreEquivalent: false, comparison };
  if (!comparison.ok) return result('PENDING', `PLAYER_READBACK_MISMATCH: ${comparison.errors.join(' · ')}`, summary);
  return tempo ? result('PASS', 'ENGINE_EVENTS_MATCH_EXACT_MML', summary) : result('PENDING', 'TEMPO_REVIEW_REQUIRED', summary);
}

// Store one capture of the preview engine as the readback for the applied
// delivery. The binding (workspace, revision, exact string) is checked against
// what is loaded now; a capture of anything else is refused, not stored. A
// capture that does not match is stored all the same -- it is what the engine
// did -- and the gate reports the mismatch.
export function recordPlayerReadback(w, capture, { workspaceId, revision, exactMml } = {}) {
  if (w.settings.preview !== 'used') throw Error('請先在專案設定將「驗證播放器」設為「有使用」，再記錄回讀');
  if (workspaceId !== w.id || revision !== w.revision) throw Error('STALE_PLAYER_READBACK: 專案或 revision 已變更，請重新播放整首');
  const context = analysisContext(w);
  const exact = context.report.rawMml;
  if (!exact) throw Error('需要已通過驗證的交付 MML，才能記錄播放器回讀');
  if (exactMml !== exact) throw Error('STALE_PLAYER_READBACK: 回讀的 MML 不是目前套用的交付 MML');
  const clean = normalizeCapture(capture);
  if (!clean.complete || clean.from !== 0 || clean.muted.some(Boolean)) throw Error(`回讀未涵蓋整首（${clean.incomplete.join('、') || '未從頭播放或有角色靜音'}）；請從頭完整播放一次`);
  return { ...copy(w), playerReadback: { workspaceId: w.id, revision: w.revision, exactMml: exact, recordedAt: new Date().toISOString(), capture: clean } };
}

export function clearPlayerReadback(w) {
  const next = copy(w);
  delete next.playerReadback;
  return next;
}

// One reconstruction, one analysis, two consumers.
//
// `analyzeWorkspace` reports this context; `generateFinalDelivery` emits from
// it. Deriving the project a second time is the hazard being avoided here:
// generation would then serialize a project subtly different from the one the
// arbitration decisions, the Source-Faithful Baseline snapshot, the reviews, G10
// and readiness were computed against, and nothing would report the divergence.
//
// The reconstructed `project` stays inside this module and the Worker. It is
// deliberately not part of the reported result, which crosses postMessage and is
// persisted.
function analysisContext(w) {
  const asset = w.assets?.candidate;
  if (!asset) {
    const gates = { intake: pending('CANDIDATE_MISSING') };
    return { asset: null, candidate: null, project: null, readiness: null, gates,
      report: { state: 'CANDIDATE', gates, blockers: ['intake'], tracks: null, rawMidi: [] } };
  }
  // Validate even locally restored objects and disregard imported acceptance.
  let candidate = readCanonical(asset.project);
  const baseline = w.assets.baseline ? readCanonical(w.assets.baseline.project) : null;
  const previous = w.assets.previous ? readCanonical(w.assets.previous.project) : null;
  // Reduction first, then Mobile adaptation. The two layers stay separate and
  // stay in this order: reduction resolves role and six-role capacity, and
  // adaptation then answers target register and volume for the roles that
  // survived it. Running adaptation first would offset material whose role the
  // reduction is still deciding.
  let finalReduction = null, finalReductionError = null;
  if (w.finalReduction) {
    try {
      const { decisions, expectedPlanId, acceptedBy } = w.finalReduction;
      const application = applyFinalReduction({ baseline, candidate, decisions, expectedPlanId, acceptedBy });
      // A refused application is a refusal, not a reduction with a plan beside
      // it. Keeping the returned object would let the UI render its recomputed
      // plan -- which can read PASS -- under a heading that says the reduction
      // was applied. The report carries the error instead.
      if (!application.didApply) throw Error(application.blockers?.map(item => item.code).join(', ') || 'FINAL_REDUCTION_NOT_APPLIED');
      finalReduction = application;
      candidate = finalReduction.candidate;
    } catch (error) { finalReduction = null; finalReductionError = error.message; }
  }
  let mobileAdaptation = null, mobileAdaptationError = null;
  // Adaptation runs on the candidate the reduction produced. When the stored
  // reduction could not be replayed, that candidate does not exist, so the
  // adaptation is not silently applied to the unreduced one instead.
  if (w.mobileAdaptation && !finalReductionError) {
    try {
      const { profile, expectedPlanId, acceptedBy } = w.mobileAdaptation;
      const application = applyMobileAdaptation({ baseline, candidate, profile, expectedPlanId, acceptedBy });
      if (!application.didApply) throw Error(application.blockers?.map(item => item.code).join(', ') || 'MOBILE_ADAPTATION_NOT_APPLIED');
      mobileAdaptation = application;
      candidate = mobileAdaptation.candidate;
    } catch (error) { mobileAdaptation = null; mobileAdaptationError = error.message; }
  } else if (w.mobileAdaptation) {
    mobileAdaptationError = 'MOBILE_ADAPTATION_NOT_REPLAYED: the stored Final Six-Role Reduction could not be replayed, so the candidate it adapts does not exist.';
  }
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
  const { mml: rawMml, origin: deliveryOrigin } = selectDelivery(w, w.mobileAdaptation || w.finalReduction ? { ...asset, format: 'Canonical IR' } : asset);
  const { technical, deliveryMatches } = verifyDelivery(candidate, rawMml, w.settings.meterText);
  const lineage = baseline ? compareCandidateLineage({ sourceBaseline: baseline, acceptedPrevious: previous, candidate }) : null;
  const core3 = baseline ? evaluateCore3Continuity({ baseline, candidate, approvedChanges: (w.core3Approvals ?? []).filter(a => a.revision === w.revision) }) : pending('BASELINE_MISSING');
  // Gate 4's own question, beside the source-continuity audit above. The Web
  // `core3` review is the candidate-bound, evidence-backed reviewer judgement
  // that resolves the residue the evaluator could not certify, a missing
  // Chord1/Chord2 function included. It can never clear an absent Lead or a
  // Core3 whose identity depends on enrichment: the gate FAILs on those.
  const core3Completeness = evaluateCore3Completeness({ candidate, reviewed: reviewed(w, 'core3') });
  const harmony = analyzeCrossSourceHarmony(project);
  // Stored Lead evidence is data. Each record is judged on every analysis by
  // the Lead Demotion Gate against the baseline event it names; the gate binds
  // the record's source identity to that exact event itself, so a record whose
  // citation belongs to another event, or whose identity was rewritten in
  // storage, is PENDING here under this event's id rather than PASS. A record
  // the gate cannot even read (an unknown baseline event, an invalid section
  // role) is a PENDING report too, never a thrown analysis: fail closed, and
  // visibly, instead of taking the whole workspace down with the record.
  const leadReports = (w.leadEvidence ?? []).filter(e => e.revision === w.revision).map(e => {
    const eventId = typeof e?.eventId === 'string' ? e.eventId : null;
    const event = eventId ? baseline?.events.find(event => event.id === eventId) : null;
    if (!event) return { status: 'PENDING', pass: false, eventId, destinationRole: e?.destinationRole ?? null, blockers: ['LEAD_EVIDENCE_EVENT_NOT_IN_BASELINE'], warnings: [] };
    const move = lineage.sourceToCandidate.notes.roleMoved.find(pair => pair.before.id === event.id);
    const removed = lineage.sourceToCandidate.notes.removed.some(item => item.id === event.id);
    const destination = move?.after.role ?? (removed ? 'omitted' : null);
    if (destination !== e.destinationRole) return { status: 'PENDING', pass: false, eventId: event.id, destinationRole: e.destinationRole ?? null, blockers: ['LEAD_DESTINATION_DOES_NOT_MATCH_CANDIDATE'], warnings: [] };
    try { return evaluateLeadDemotion({ ...e, event }); }
    catch (error) { return { status: 'PENDING', pass: false, eventId: event.id, destinationRole: e.destinationRole ?? null, blockers: [`LEAD_DEMOTION_EVIDENCE_INVALID: ${error.message}`], warnings: [] }; }
  });
  // The promotion mirror of the block above, through the same shared grader.
  // Four things must hold before the evidence is graded at all, and each
  // failure is a visible PENDING report rather than a thrown analysis:
  // the promoted event is still a Melody event of the candidate; the candidate
  // diff actually shows it arriving in Melody (so a record cannot outlive the
  // move it describes); its origin still resolves to a baseline event; and the
  // promoted event is still the note that origin describes.
  // The grade itself is `evaluateLeadPromotion` against the origin provenance,
  // and the report is re-keyed to the candidate event id afterwards because
  // that is the id shared readiness matches on.
  const leadPromotionReports = (w.leadPromotionEvidence ?? []).filter(e => e.revision === w.revision).map(e => {
    const promotedEventId = typeof e?.promotedEventId === 'string' ? e.promotedEventId : null;
    const stale = blockers => ({ status: 'PENDING', pass: false, eventId: promotedEventId, destinationRole: 'Melody', blockers, warnings: [] });
    const promoted = promotedEventId ? candidate.events.find(event => event.id === promotedEventId) : null;
    if (!promoted || promoted.role !== 'Melody') return stale(['LEAD_PROMOTION_EVENT_NOT_IN_CANDIDATE']);
    const arrived = (lineage?.sourceToCandidate.notes.added ?? []).some(event => event.id === promotedEventId)
      || (lineage?.sourceToCandidate.notes.roleMoved ?? []).some(pair => pair.after.id === promotedEventId && pair.after.role === 'Melody' && pair.before.role !== 'Melody');
    if (!arrived) return stale(['LEAD_PROMOTION_NOT_PRESENT_IN_CANDIDATE_DIFF']);
    const origin = baseline ? baselineOriginEvent(baseline, candidate, e.originEventId || promotedEventId) : null;
    if (!origin) return stale(['LEAD_PROMOTION_ORIGIN_NOT_IN_BASELINE']);
    // The citation is bound to the origin's provenance, so the promoted event
    // must still be the same note the origin describes. Role is excluded: the
    // role change is the move the evidence argues for. Everything else moving
    // means the citation is about a note that is no longer there.
    const sameNote = ['pitch', 'start', 'end', 'volume'].every(key => String(promoted[key] ?? '') === String(origin[key] ?? ''))
      && JSON.stringify([...(promoted.sourceIds ?? [])].sort()) === JSON.stringify([...(origin.sourceIds ?? [])].sort())
      && JSON.stringify([...(promoted.sourceEventIds ?? [])].sort()) === JSON.stringify([...(origin.sourceEventIds ?? [])].sort());
    if (!sameNote) return stale(['LEAD_EVIDENCE_EVENT_CHANGED']);
    try {
      // Graded as the event stood before the move: the shared gate answers N/A
      // for an event that is already Melody, so handing it the candidate event
      // would silently drop the requirement instead of grading it.
      const report = evaluateLeadPromotion({ ...e, event: { ...origin, id: origin.id, role: origin.role }, destinationRole: 'Melody' });
      return { ...report, eventId: promotedEventId, originEventId: origin.id };
    } catch (error) {
      return stale([`LEAD_PROMOTION_EVIDENCE_INVALID: ${error.message}`]);
    }
  });
  const playerReadback = playerReadbackGate(w, rawMml, technical, deliveryMatches);
  const audioPresent = Object.values(w.assets).some(a => a.project.sources.some(s => s.kind === 'original-audio')) || Boolean(w.audio);
  const audioRequired = audioPresent || w.settings.audioRequired !== 'no';
  // Machine delivery is ready only when the Final emitter writes this project,
  // so readiness asks it once nothing else stops machine delivery (the
  // technical gate included, so only while a valid delivery is in hand) -- and
  // asks it the way this Web delivers: exactly the call generation makes,
  // handed the report as it stands. The answer is kept so generation reuses it
  // instead of emitting twice. It is the machine-delivery answer only: a valid
  // pasted delivery is still graded by the Web gates below, and a refusal to
  // write the candidate does not change what they say about it.
  let emission = null;
  const emitFinal = before => (emission = emitWebFinal(project, before));
  const readiness = evaluateProjectReadiness({ project, mmlValidation: technical, core3Report: core3, core3CompletenessReport: core3Completeness, harmonyReport: harmony, leadDemotionReports: leadReports, leadPromotionReports, lineageReport: lineage, versionDriftReviewed: reviewed(w, 'version'), originalAudioRequired: audioRequired, originalAudioReviewed: reviewed(w, 'audio'), playerReadback: playerReadback.status, mobileAdaptation: reviewed(w, 'adaptation') ? 'PASS' : 'PENDING', regressionReviewed: reviewed(w, 'regression'), emitFinal });
  const gates = { ...readiness.gates };
  gates.playerReadback = { ...gates.playerReadback, reason: playerReadback.reason };
  if (finalReductionError) gates.finalReductionIntegrity = pending(finalReductionError);
  if (mobileAdaptationError) gates.mobileAdaptationIntegrity = pending(mobileAdaptationError);
  delete gates.inGameAcceptance;
  // The shared readiness name is `mobileAdaptation`; the Web UI's long-lived
  // public review name is `adaptation`. Present exactly one blocker here while
  // keeping the full shared verdict intact on `readiness.gates`.
  delete gates.mobileAdaptation;
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
  gates.adaptation = reviewed(w, 'adaptation')
    ? { ...readiness.gates.mobileAdaptation, reason: w.reviews.adaptation.note }
    : { ...readiness.gates.mobileAdaptation, reason: 'ADAPTATION_REVIEW_REQUIRED' };
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
  // Every status here is recomputed from the workspace on this run. Nothing is
  // read from `w.finalDelivery`: a stored, imported or edited generation record
  // claiming PASS is data about a past attempt, never a gate and never a state.
  const report = { state: accepted ? 'IN_GAME_ACCEPTED' : validated ? 'VALIDATED' : 'CANDIDATE', gates, blockers, technical, core3, core3Completeness, harmony, lineage, leadReports, leadPromotionReports, readiness, rawMidi,
    tracks: technical?.ok && deliveryMatches ? splitMML(rawMml) : null, rawMml: technical?.ok && deliveryMatches ? rawMml.trim() : null, deliveryOrigin,
    mobileAdaptation: mobileAdaptation ? { plan: mobileAdaptation.plan, diffFromBaseline: mobileAdaptation.diffFromBaseline, diffFromParent: mobileAdaptation.diffFromParent } : null,
    finalReduction: finalReduction ? { plan: finalReduction.plan, accounting: finalReduction.accounting, diffFromBaseline: finalReduction.diffFromBaseline, diffFromParent: finalReduction.diffFromParent } : null,
    playerReadback: playerReadback.summary,
    historicalRegression: 'FIXTURE_PENDING', audioError, importedDecisions: candidate.decisions,
    // Display projection for the review roll; carries no gate or review meaning.
    roll: buildRollProjection(candidate, { harmony }),
    // The same projection over the verified G11-D head, when every recorded
    // decision applied. Display only: it is not the analysed candidate.
    acceptedRoll: acceptedRollOf(rawMidi) };
  return { asset, candidate, project, readiness, gates, report, emission };
}

function acceptedRollOf(rawMidi) {
  const accepted = rawMidi.find(item => item.slot === 'candidate')?.acceptedArrangement;
  return accepted?.status === 'PASS' && accepted.application?.candidate ? buildRollProjection(accepted.application.candidate) : null;
}

export function analyzeWorkspace(w) {
  return analysisContext(w).report;
}

// Gates that cannot be required before the Final MML exists, because they are
// the gates that grade it. Requiring either here would be circular: generation
// could never start, so the output they grade could never be produced. The
// backend emitter drops `technical` from a supplied readiness report for exactly
// this reason; `deliveryIdentity` is the Web's own equivalent, and the backend
// never sees it.
//
// Nothing else is exempt. All nine human reviews, intake/version identity, the
// Source-Faithful Baseline, G10 micro-timing, Lead demotion evidence,
// cross-source harmony, version drift, original audio, player readback, pending
// arbitration and Raw MIDI byte identity all stay blocking, so a clear backend
// readiness report can never by itself authorize generation.
export const PRE_EMISSION_EXEMPT_GATES = Object.freeze(['technical', 'deliveryIdentity']);
export const STALE_FINAL_DELIVERY = 'STALE_FINAL_DELIVERY_DISCARDED';

// The one call this Web writes a Final with: the emitter, handed the readiness
// report and nothing else. The Web never opts into the machine-delivery path's
// provisional release rendering or Tempo-restatement collapse
// (final/emitter-contract.mjs): its delivery check reads the emitted string
// back against the candidate as it stands. Readiness is asked about exactly
// this call and generation makes exactly this call, so the two cannot disagree
// about whether the emitter writes the candidate.
const emitWebFinal = (project, readiness) => emitFinalMml(project, { readiness });

// Integration-level diagnostics. They use the emitter's own severity vocabulary
// and result shape rather than a second one, and they never restate an emitter
// verdict: each says something the emitter is not in a position to say.
const webDiagnostic = (code, severity, message, details = {}) => Object.freeze({ code, severity, message, ...details });
const generationResult = (w, fields) => ({
  projectId: w.id, revision: w.revision, at: new Date().toISOString(),
  status: EMIT_STATUS.FAIL, blockedGates: [], combinedMml: null, roles: [], characterCounts: null,
  microGap: null, roundTrip: null, canonical: null, delivery: null, diagnostics: [], ...fields,
});

/**
 * Canonical project -> exact Final delivery MML, or a structured refusal.
 *
 * The only path from this workspace to a Final string. It emits nothing and
 * writes nothing unless every required Web gate is already satisfied, the
 * emitter returns PASS, and the exact emitted string then passes the same
 * delivery check a pasted delivery gets. Nothing is transformed after the
 * emitter passes.
 */
export function generateFinalDelivery(w) {
  const context = analysisContext(w);
  const blockedGates = Object.entries(context.gates)
    .filter(([name, gate]) => !PRE_EMISSION_EXEMPT_GATES.includes(name) && !good(gate))
    .map(([name, gate]) => ({ name, status: gate.status, reason: gate.reason ?? null, blockers: gate.blockers ?? [] }));
  if (blockedGates.length) return generationResult(w, { status: EMIT_STATUS.PENDING, blockedGates, diagnostics: [webDiagnostic(
    'FINAL_GENERATION_BLOCKED', DIAGNOSTIC_SEVERITY.PENDING,
    `Final generation is blocked on: ${blockedGates.map(gate => gate.name).join(', ')}. Required Web gates are not satisfied, so nothing was emitted.`,
    { blocking: blockedGates.map(gate => gate.name) })] });

  // Readiness is always supplied. The backend contract allows it to be omitted;
  // omitting it here would let a song this analysis has already found unready be
  // emitted anyway. When the analysis already asked the emitter -- the same
  // call on the same project, handed the same report before its own answer was
  // added, which the emitter does not read -- that answer is reused.
  const emitted = context.emission ?? emitWebFinal(context.project, context.readiness);
  const carried = { roles: emitted.roles, characterCounts: emitted.characterCounts, microGap: emitted.microGap,
    roundTrip: emitted.roundTrip, canonical: emitted.canonical, diagnostics: [...emitted.diagnostics] };
  // The emitter's own refusals are reported exactly as it phrased them. A
  // bounded-search miss stays a bounded-search miss here.
  if (emitted.status !== EMIT_STATUS.PASS) return generationResult(w, { ...carried, status: emitted.status });

  const combinedMml = emitted.combinedMml;
  // Redundant today, and therefore in need of its own coverage. The emitter
  // builds `MML@<bodies>;` with nothing around it, so this holds; it is here so
  // that if that ever stops being true the integration fails closed instead of
  // quietly trimming, which would break the byte-for-byte identity between what
  // is displayed, copied, downloaded, validated and accepted.
  if (typeof combinedMml !== 'string' || !combinedMml.length || combinedMml !== combinedMml.trim()) {
    return generationResult(w, { ...carried, status: EMIT_STATUS.FAIL, diagnostics: [...carried.diagnostics, webDiagnostic(
      'FINAL_OUTPUT_NOT_EXACT', DIAGNOSTIC_SEVERITY.ERROR,
      'The emitter reported PASS but its combined MML is not a string this integration can carry unchanged. No output was kept.')] });
  }

  // The exact emitted string, checked by the same delivery verification a pasted
  // delivery gets. It is not normalized, repaired or reformatted first.
  const delivery = verifyDelivery(context.candidate, combinedMml, w.settings.meterText);
  if (!delivery.technical?.ok || !delivery.deliveryMatches) {
    return generationResult(w, { ...carried, status: EMIT_STATUS.FAIL, delivery, diagnostics: [...carried.diagnostics, webDiagnostic(
      'FINAL_DELIVERY_READBACK_FAILED', DIAGNOSTIC_SEVERITY.ERROR,
      'The emitted MML did not pass the Web delivery check: it must be technically valid and read back as the same events as the candidate.',
      { technicalOk: delivery.technical?.ok === true, deliveryMatches: delivery.deliveryMatches })] });
  }
  return generationResult(w, { ...carried, status: EMIT_STATUS.PASS, combinedMml, delivery });
}

/**
 * Apply a generation result to the workspace it was computed for.
 *
 * Separate from generation so the result can be checked against the workspace
 * that is actually on screen. Generation runs off the main thread and the
 * workspace can move while it runs; a result that no longer describes the same
 * project and revision is refused rather than written, so newer work is never
 * overwritten by older derived output.
 */
export function applyFinalDelivery(w, result) {
  if (!result || result.projectId !== w.id || result.revision !== w.revision) throw Error(STALE_FINAL_DELIVERY);
  const next = copy(w);
  // Derived and informational. What makes a delivery current is the analysis
  // that runs after this, never this record: `analyzeWorkspace` does not read it.
  next.finalDelivery = { status: result.status, at: result.at, revision: w.revision, blockedGates: result.blockedGates,
    roles: result.roles, characterCounts: result.characterCounts, microGap: result.microGap,
    roundTrip: result.roundTrip, canonical: result.canonical, diagnostics: result.diagnostics,
    // The Web delivery check's own verdict, kept so a refusal can be shown in
    // the words the validator used. The emitter can pass and this still refuse:
    // they answer different questions, and paraphrasing the second one as the
    // first is how a validator finding turns into an imagined engine rule.
    deliveryCheck: result.delivery
      ? { technicalOk: result.delivery.technical?.ok === true, deliveryMatches: result.delivery.deliveryMatches,
        errors: (result.delivery.technical?.errors ?? []).map(error => error?.message ?? String(error)) }
      : null };
  // A blocked or failed attempt emits nothing and overwrites nothing: whatever
  // delivery the workspace already held is still the delivery it holds.
  if (result.status !== EMIT_STATUS.PASS) return next;
  next.deliveryMml = result.combinedMml;
  next.deliveryBinding = { revision: w.revision, origin: 'generated' };
  // The exact delivery MML changed, so an acceptance or a player readback
  // recorded against the old one no longer describes what would be pasted.
  next.acceptance = null;
  delete next.playerReadback;
  return next;
}

export function recordAcceptance(w, details) {
  const report = analyzeWorkspace(w);
  if (report.state !== 'VALIDATED' && report.state !== 'IN_GAME_ACCEPTED') throw Error('所有必要非實機 Gate 通過後，才能記錄實機接受');
  if (!['client', 'instrument', 'evidence'].every(k => text(details[k]))) throw Error('需要 client／樂器及實機證據');
  return { ...copy(w), acceptance: { ...details, revision: w.revision, exactMml: report.rawMml, outcome: 'accepted', at: new Date().toISOString() } };
}
