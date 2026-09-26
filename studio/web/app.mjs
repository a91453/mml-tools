import { listProjectSummaries, loadProject, requestPersistence, saveProject, storageHealth } from './storage.mjs';
import { portableBackup, unzipFiles, zipFiles } from './backup-zip.mjs';
import { createWorkerClient, WORKER_UNAVAILABLE } from './worker-client.mjs';
import { createTaskQueue } from './task-queue.mjs';
import { createUpdateFlow } from './pwa-update.mjs';
import { buildRoles, diagnosticsFromValidation, renderHTML, roleCharacterCounts, segmentRoles } from './mml-highlight.mjs';
import { mountReviewRoll } from './review-roll.mjs';
import { PROBES, buildObservation, summarize } from './engine-probe.mjs';
import { compareReadback, normalizeCapture } from './preview/readback.mjs';
import { DEFAULT_BANK_LABEL, DEFAULT_BANK_NAME, DEFAULT_INSTRUMENT, GAME_STYLE_BANK_LABEL, GAME_STYLE_BANK_NAME, ROLE_GROUPS, ROLE_GROUP_LABELS, groupChoice, instrumentOptions, resolveRoleVoices, uniformProgram } from './preview/instruments.mjs';
import { DEFAULT_BANK_DOWNLOAD_NOTICE, DEFAULT_BANK_SUBSET, loadDefaultBank } from './preview/default-bank.mjs';
import { GAME_STYLE_BANK, GAME_STYLE_DOWNLOAD_NOTICE, loadGameStyleBank } from './preview/game-style-bank.mjs';
import { createListening } from './listen-ui.mjs';
import { markersFromReport, sanitizeStoredNotes } from './listen-notes.mjs';
// Request identity only. The MIDI decoder, the Canonical conversion and the
// G11-B/G11-C derivation all live behind the Worker, so the main thread never
// imports a backend source decoder and never parses a source file itself.
import { createSourceRequestLedger } from './source-requests.mjs';
// The Workshop editor (studio/web/workshop/) is outside the Canonical
// pipeline. This small adapter only opens a copy there and brings an edit back
// through the ordinary intake below; see workshop-link.mjs.
import { UNVERIFIED_LABEL, parseReturnHash, returnFileName, takeReturn, workshopUrl } from './workshop-link.mjs';
// Language and theme (i18n.mjs, ui-prefs.mjs). Every string this page writes
// goes through t(); codes such as PASS, PENDING or VALIDATED stay as they are.
import { has, t, use as useLanguage } from './i18n.mjs';
import { LANGS, LANG_NAMES, translateStatic } from './i18n-core.mjs';
import { THEMES, applyTheme, langChoice, savePrefs, themeChoice, setTheme } from './ui-prefs.mjs';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = value => `<pre>${esc(JSON.stringify(value, null, 2))}</pre>`;
const badge = status => `<span class="badge ${status === 'N/A' ? 'na' : esc(status)}">${esc(status)}</span>`;
const detail = (label, value) => `<details><summary>${esc(label)}</summary>${json(value)}</details>`;
const options = (values, selected) => values.map(([value, label]) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`).join('');
const roles = ['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5'];
// Syntax-highlight layer (mml-highlight.mjs) painted behind a transparent
// textarea. The textarea keeps the exact string for selection and copy; the
// layer adds colour and the parser's own error/caution positions, nothing else.
const technicalDiagnostics = () => diagnosticsFromValidation(report?.technical, roles);
const roleDiagnostics = index => technicalDiagnostics().filter(d => d.role === index).map(d => ({ ...d, role: 0 }));
const mmlLayer = (value, diagnostics = []) => `<pre class="mml-hl-layer" aria-hidden="true">${renderHTML(value ?? '', buildRoles(value ?? '', { diagnostics }))}</pre>`;
// Display names only; the gate and review names themselves are the codes.
const REVIEW_NAMES = ['source', 'version', 'lead', 'core3', 'full6', 'tempo', 'audio', 'adaptation', 'regression'];
const reviewLabels = () => Object.fromEntries(REVIEW_NAMES.map(name => [name, t(`reviewLabel.${name}`)]));
const gateLabel = name => (has(`gateLabel.${name}`) ? t(`gateLabel.${name}`) : name);
let workspace, report, identity, projects = [], audioFile = null, uploadController = null, busy = 0;
let mobilePreview = null;
let reductionPreview = null;
let reductionDecisions = [];
// Listening sessions (listen-ui.mjs); created once the page is wired below.
let listening = null;
// Decision Composer (section 04): the events gathered on the roll, the form
// as typed, and the last dry run. A dry run is dropped on every commit and on
// every edit, so 「接受」 only ever records the record that was just previewed.
const composer = { eventIds: [], view: 'source', draft: { type: 'ASSIGN_ROLE', toRole: 'Chord1', toRoles: [], reason: '', evidence: '', note: '' }, preview: null, previewDraft: null };
const queued = createTaskQueue();
// Service Worker release handling (pwa-update.mjs). A stale tab kept running
// the previous release after another tab applied a new one; it must reload
// before doing more work so it never drives new modules with old ones.
let updateFlow = null;
let applyingUpdate = false;
const midiRequests = createSourceRequestLedger();
const MAX_SOURCE_BYTES = 4194304;
const { call } = createWorkerClient({ spawn: () => new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' }) });
let messageTimer;
function message(value, persistent = false) { clearTimeout(messageTimer); $('#message').textContent = value; if (!persistent) messageTimer = setTimeout(() => { $('#message').textContent = ''; }, 7000); }
// aria-busy is this app's only settled/unsettled signal, so it has to cover a
// commit whoever started it. Without this a boot commit's
// ANALYSIS_RUNNING placeholder renders a CANDIDATE badge while the app claims
// to be idle: a restored VALIDATED/IN_GAME_ACCEPTED project reads as demoted
// until the real analysis lands. It is also what run() serializes against, so
// an action taken during boot is held rather than racing that first analysis.
function markBusy(active) {
  busy += active ? 1 : -1;
  $('#app').setAttribute('aria-busy', busy > 0 ? 'true' : 'false');
}
// A Files/input action is a choice the user already made through a native
// picker, and the input it came from is replaced by the next render, so dropping
// it while a commit is in flight loses that choice with nothing left to retry.
// Serialize instead: retain every action in FIFO order and run them when the
// current one settles.
//
// A held action was chosen against the revision that was on screen. Evidence
// actions (reviews, arbitration, Lead demotion, acceptance) attach to that exact
// revision, so if it moved while they waited they are refused rather than
// silently re-pointed at whatever replaced it. Intake actions carry their own
// captured content and invalidate on their own, so they stay valid across
// revisions of the same project. Only explicit project navigation is unbound
// from the project ID; equal revision numbers never identify equal projects.
function run(fn, { revisionBound = true, projectBound = true } = {}) {
  if (updateFlow?.stale) return message(t('msg.staleTab'), true);
  if (applyingUpdate) return message(t('msg.applyingUpdate'), true);
  const task = { fn, revisionBound, projectBound, projectId: workspace?.id, revision: workspace?.revision };
  if (!busy) return drain(task);
  queued.enqueue(task);
  return message(t('msg.queued'));
}
async function drain(task) {
  markBusy(true);
  try {
    while (task) {
      if ((task.projectBound && task.projectId !== workspace?.id) || (task.revisionBound && task.revision !== workspace?.revision)) message(t('msg.staleAction'), true);
      else try { await task.fn(); } catch (error) { message(error.message, true); }
      task = queued.dequeue();
    }
  } finally { markBusy(false); }
}
function download(name, value, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function refreshProjects() {
  projects = await listProjectSummaries();
  $('#projects').innerHTML = options(projects.map(p => [p.id, p.title]), workspace?.id);
  showSaveState();
}
async function showSaveState() {
  const pill = $('#save-state');
  if (!pill) return;
  const saved = workspace?.savedAt ? t('side.savedAt', { time: new Date(workspace.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : workspace ? t('side.unsaved') : '';
  pill.textContent = saved;
  pill.className = `save-state ${workspace?.savedAt ? 'ok' : 'warn'}`;
  const health = await storageHealth().catch(() => null);
  const detail = $('#storage-detail');
  if (detail && health) detail.textContent = [health.usage !== null && health.quota ? t('side.usage', { used: bytesLabel(health.usage), quota: bytesLabel(health.quota) }) : null, health.persisted === true ? t('side.persisted') : health.persisted === false ? t('side.notPersisted') : null].filter(Boolean).join(' · ');
}
async function commit(next) {
  mobilePreview = null;
  reductionPreview = null;
  reductionDecisions = [];
  composer.preview = null; composer.previewDraft = null;
  if (composer.view === 'preview') composer.view = 'source';
  markBusy(true);
  try {
    const canonicalKey=JSON.stringify(identity.metadata);
    if(next.savedAt && next.canonicalKey!==canonicalKey)next=await call('invalidate',next);
    next.canonicalKey=canonicalKey;
    // Analyze before replacing a displayed result. A thrown analysis never leaves
    // the previous green gates associated with edited data.
    workspace = { ...next, savedAt: null }; report = { state: 'CANDIDATE', gates: { analysis: { status: 'PENDING', reason: 'ANALYSIS_RUNNING' } }, blockers: ['analysis'], tracks: null };
    render();
    try { report = await call('analyzeWorkspace', workspace); }
    // aria-busy is about to go false, so what stays on screen has to be a
    // settled verdict. Leaving the ANALYSIS_RUNNING placeholder would claim an
    // analysis is still running while the app reports itself idle, and no
    // further render is coming to correct it.
    catch (error) { report = { state: 'CANDIDATE', gates: { analysis: { status: 'PENDING', reason: `ANALYSIS_FAILED: ${error.message}` } }, blockers: ['analysis'], tracks: null }; render(); throw error; }
    try { workspace = await saveProject(workspace); await refreshProjects(); }
    catch (error) { workspace.savedAt=null;await refreshProjects().catch(()=>{});message(t('msg.saveFailed', { error: error.message }), true); }
    render();
  } finally { markBusy(false); }
}
const input = (name, label, value, attrs = '') => `<label>${esc(label)}<input name="${name}" value="${esc(value)}" ${attrs}></label>`;
const bytesLabel = value => value >= 1048576 ? `${(value / 1048576).toFixed(2)} MiB` : `${(value / 1024).toFixed(1)} KiB`;
function intakeCard(slot, title, hint) {
  const asset = workspace.assets[slot];
  // A Raw MIDI asset has no text representation, so its identity is stated as
  // the byte count and the digest of the bytes that were actually parsed.
  const source = asset?.source?.sha256 ? `<p class="meta">${bytesLabel(asset.source.byteLength)} · SMF ${esc(asset.midi?.smfFormat ?? '?')} · ${asset.midi?.trackCount ?? '?'} tracks<br><code class="digest">sha256 ${esc(asset.source.sha256.slice(0, 16))}…</code></p>` : '';
  const workshop = asset?.format === 'MML' && /MML@/i.test(asset.content ?? '') ? `<p><a class="file-button quiet workshop-link" href="${esc(workshopUrl(workspace.id, slot))}">${t('common.openInWorkshop')}</a></p>` : '';
  // The picker has no accept list: iPhone/iPad map one to their own document
  // types and grey out an .xml they do not associate with it. The bytes decide
  // the reader (MIDI or ZIP header, else text intake), as for a dropped file.
  return `<div class="card"><h3>${title}</h3><p class="meta">${hint}</p>${asset ? `<p><strong>${esc(asset.name)}</strong></p><p class="meta">${esc(asset.format)} · ${asset.project.events.length} events</p>${source}${workshop}${badge(asset.unsupported.length ? 'UNSUPPORTED' : 'PENDING')} <small>${asset.complete ? t('intake.parsedAwaitingReview') : t('intake.sourceIncomplete')}</small>${detail(t('intake.sourceDetail'), { sources: asset.project.sources, warnings: asset.warnings, errors: asset.errors, unsupported: asset.unsupported })}` : `<div class="empty">${t('intake.empty')}<br>MusicXML · MML · MIDI · Canonical IR</div>`}<label class="file-button secondary">${asset ? t('intake.replace') : t('intake.choose')}<input type="file" data-intake="${slot}" aria-label="${esc(t('intake.fileAria', { title }))}"></label>${asset ? `<button class="quiet" data-download-ir="${slot}">${t('intake.exportIr')}</button>` : ''}${asset?.format === 'MML' ? `<button class="quiet" data-listen-asset="${slot}">${t('common.sendToListening')}</button>` : ''}</div>`;
}
// ─── Raw MIDI presentation ──────────────────────────────────────────────────
//
// Three things this section must not do, because each of them would be the UI
// contradicting the backend it is displaying:
//
//   * present the G11-C candidate as an accepted arrangement;
//   * present Melody as required and Chord1/Chord2 as optional, or let
//     Chord3-Chord5 make an incomplete Core3 look finished;
//   * hide PENDING, unsupported, percussion or overflow material to make the
//     page read as complete.
//
// It also invents no readiness of its own. Every status shown here is a status
// the backend computed.
const LEDGER_DISPLAY_LIMIT = 500;
const slotLabel = slot => (has(`slot.${slot}`) ? t(`slot.${slot}`) : slot);
const facts = entries => `<dl class="facts">${entries.filter(([, value]) => value !== undefined && value !== null).map(([label, value]) => `<div class="fact"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
const countList = counts => Object.entries(counts ?? {}).map(([code, count]) => `<li><code>${esc(code)}</code> × ${count}</li>`).join('');

function midiSourceCard(entry) {
  const m = entry.midi ?? {};
  const division = m.division?.type === 'ppq' ? `PPQ ${m.division.ticksPerQuarter}` : `${m.division?.type ?? '?'} ${m.division?.raw ?? ''}`;
  const integrity = entry.integrity.verified ? 'PASS' : 'UNSUPPORTED';
  const parse = entry.error ? 'UNSUPPORTED' : entry.complete ? 'PENDING' : 'UNSUPPORTED';
  return `<div class="card">
    <div class="row"><h3>${esc(slotLabel(entry.slot))} · ${esc(entry.name)}</h3>${badge(integrity)}</div>
    <p class="meta">${integrity === 'PASS' ? t('midi.integrityPass') : t('midi.integrityFail', { reasons: esc(entry.integrity.reasons.join(', ')) })}</p>
    ${(entry.integrity.reasons ?? []).includes('STORED_PROJECT_DOES_NOT_MATCH_SOURCE_BYTES') ? `<p class="meta">${t('midi.storedMismatch')}</p>` : ''}
    ${facts([
      [t('midi.fileBytes'), entry.source.byteLength === null ? null : `${entry.source.byteLength} bytes（${bytesLabel(entry.source.byteLength)}）`],
      ['sha256', entry.source.sha256],
      [t('midi.sourceKind'), entry.source.kind === null ? null : `${entry.source.kind} · ${entry.source.authority}`],
      ['SMF format', m.smfFormat],
      ['Division', division],
      [t('midi.tracksDeclared'), `${m.declaredTrackCount} / ${m.trackCount}`],
      ['Note events', m.noteEventCount],
      ['Tempo / Meter events', `${m.tempoEventCount} / ${m.meterEventCount}`],
      ['Sustain pedal evidence', m.pedalEventCount],
      [t('midi.sourceVoices'), m.sourceVoices?.length ?? 0],
      [t('midi.parseComplete'), entry.complete ? t('common.yes') : t('midi.parseCompleteNo')],
    ])}
    <p>${badge(parse)} <small>${entry.complete ? t('midi.parsedNeedsReview') : t('midi.incompleteListed')}</small></p>
    ${entry.claimedComplete !== entry.complete ? `<p class="note">${t('midi.claimedComplete', { claimed: entry.claimedComplete, actual: entry.complete })}</p>` : ''}
    <details><summary>${t('midi.perTrack')}</summary><div class="scroll"><table><thead><tr><th>#</th><th>${t('midi.trackName')}</th><th>raw</th><th>note</th><th>percussion</th><th>channels</th><th>program changes</th><th>EoT</th></tr></thead><tbody>${(m.tracks ?? []).map(track => `<tr><td>${track.index}</td><td>${esc(track.name ?? '—')}</td><td>${track.rawEvents}</td><td>${track.noteEvents}</td><td>${track.percussionEvents}</td><td>${esc(track.channels.join(', ') || '—')}</td><td>${track.programChanges.length}</td><td>${track.sawEndOfTrack ? t('midi.eotYes') : t('midi.eotMissing')}</td></tr>`).join('')}</tbody></table></div></details>
    ${detail(t('midi.sourceRecordDetail'), { source: entry.source, integrity: entry.integrity, warnings: entry.warnings, unsupported: entry.unsupported })}
  </div>`;
}

function percussionCard(entry) {
  const m = entry.midi ?? {};
  if (!m.percussionEventCount) return '';
  return `<div class="card"><div class="row"><h3>${t('midi.percussionTitle')}</h3>${badge('UNSUPPORTED')}</div>
    <p class="meta">${t('midi.percussionNote')}</p>
    ${facts([[t('midi.percussionEvents'), m.percussionEventCount], ['Channel', m.percussionChannels?.join(', ')], ['Note numbers', m.percussionNoteNumbers?.join(', ')]])}
    ${detail(t('midi.percussionDetail'), entry.unsupported.filter(item => item.code === 'PERCUSSION_CHANNEL_EVENT'))}</div>`;
}

function unsupportedCard(entry) {
  const codes = Object.entries(entry.midi?.unsupportedCounts ?? {}).filter(([code]) => code !== 'PERCUSSION_CHANNEL_EVENT');
  const warnings = Object.entries(entry.midi?.warningCounts ?? {});
  if (!codes.length && !warnings.length) return '';
  return `<div class="card"><div class="row"><h3>${t('midi.unsupportedTitle')}</h3>${badge(codes.length ? 'UNSUPPORTED' : 'PENDING')}</div>
    <p class="meta">${t('midi.unsupportedNote')}</p>
    ${codes.length ? `<p><strong>${t('midi.unsupported')}</strong></p><ul class="codes">${countList(Object.fromEntries(codes))}</ul>` : ''}
    ${warnings.length ? `<p><strong>${t('midi.warnings')}</strong></p><ul class="codes">${countList(Object.fromEntries(warnings))}</ul>` : ''}
    ${detail(t('midi.fullEvidence'), { unsupported: entry.unsupported, warnings: entry.warnings })}</div>`;
}

function voiceSplitCard(split) {
  const lossless = !split.missingEventIds.length && !split.duplicatedEventIds.length;
  return `<div class="card"><div class="row"><h3>${t('split.title')}</h3>${badge(lossless && split.complete ? 'PASS' : 'UNSUPPORTED')}</div>
    <p class="meta">${t('split.note')}</p>
    ${facts([
      [t('split.sourceVoices'), split.sourceVoiceCount],
      [t('split.lanes'), split.laneCount],
      [t('split.maxPolyphony'), split.maxPolyphony],
      [t('split.events'), `${split.inputEventCount} / ${split.outputEventCount}`],
      [t('split.missing'), split.missingEventIds.length],
      [t('split.duplicated'), split.duplicatedEventIds.length],
    ])}
    <div class="scroll"><table><thead><tr><th>${t('split.sourceVoice')}</th><th>lane</th><th>${t('common.events')}</th><th>${t('split.averagePitch')}</th><th>${t('split.silenceJunctions')}</th></tr></thead><tbody>${split.groups.flatMap(group => group.lanes.map(lane => `<tr><td><code>${esc(group.sourceVoice)}</code></td><td>#${lane.index}</td><td>${lane.noteCount}</td><td>${esc(lane.averagePitchExact)}</td><td>${lane.silenceJunctions.length}</td></tr>`)).join('')}</tbody></table></div>
    ${split.groups.some(group => group.diagnostics.length) ? detail(t('split.diagnostics'), split.groups.flatMap(group => group.diagnostics)) : ''}</div>`;
}

// An assigned role is a suggestion, so it renders PENDING rather than PASS. An
// empty one is only N/A where the role really is optional: an empty Core3 role
// is an unmet requirement, and "not applicable" would misdescribe it.
function roleRow(role, view, candidate, group) {
  const lanes = candidate.lanes.filter(lane => view.laneIds.includes(lane.id));
  const events = view.eventIds.length;
  const status = view.status === 'ASSIGNED' ? 'PENDING' : view.status === 'EMPTY' ? (group === 'core3' ? 'PENDING' : 'N/A') : view.status;
  return `<tr><th scope="row">${esc(role)}</th><td>${badge(status)}</td><td>${view.laneIds.length}</td><td>${events}</td><td>${esc(view.evidenceTierName ?? (view.evidenceTier === null ? '—' : String(view.evidenceTier)))}</td><td>${esc(view.reasons.join(' · ') || '—')}</td><td>${esc(lanes.map(lane => lane.sourceVoice).join(', ') || '—')}</td></tr>`;
}

const roleTableHead = () => `<tr><th>${t('common.role')}</th><th>${t('common.status')}</th><th>lane</th><th>${t('common.events')}</th><th>${t('common.evidenceTier')}</th><th>${t('common.reason')}</th><th>${t('split.sourceVoice')}</th></tr>`;
function core3Card(candidate) {
  const core3 = candidate.core3;
  const rows = ['Melody', 'Chord1', 'Chord2'].map(role => roleRow(role, candidate.roles[role], candidate, 'core3')).join('');
  return `<div class="card"><div class="row"><h3>${t('core3.title')}</h3>${badge(core3.status === 'COMPLETE' ? 'PASS' : core3.status)}</div>
    <p class="meta">${t('core3.note')}</p>
    <div class="scroll"><table><thead>${roleTableHead()}</thead><tbody>${rows}</tbody></table></div>
    ${facts([
      [t('core3.missing'), core3.missingFunctions.join(', ') || '—'],
      [t('core3.unproven'), core3.unprovenFunctions.join(', ') || '—'],
      [t('core3.identityDepends'), core3.identityDependsOnEnrichment ? t('common.yes') : core3.identityMayDependOnEnrichment ? t('common.undetermined') : t('common.no')],
      [t('core3.allThree'), core3.architecture.allThreeRequiredForComplete ? t('common.yes') : t('common.no')],
      [t('core3.priority'), core3.architecture.priorityAmongRoles],
    ])}
    ${detail(t('core3.detail'), { functions: core3.functions, rationale: core3.rationale, unresolvedHarmony: core3.unresolvedHarmony, conflicts: core3.conflicts, pending: core3.pending })}</div>`;
}

function full6Card(candidate) {
  const full6 = candidate.full6;
  const core3Incomplete = candidate.core3.status !== 'COMPLETE';
  const rows = ['Chord3', 'Chord4', 'Chord5'].map(role => roleRow(role, candidate.roles[role], candidate, 'full6')).join('');
  return `<div class="card"><div class="row"><h3>${t('full6.title')}</h3>${badge(full6.status === 'USEFUL' ? 'PENDING' : full6.status === 'NONE' ? 'N/A' : full6.status)}</div>
    <p class="meta">${t('full6.note')}</p>
    ${core3Incomplete ? `<p class="note">${t('full6.core3Incomplete', { status: esc(candidate.core3.status) })}</p>` : ''}
    <div class="scroll"><table><thead>${roleTableHead()}</thead><tbody>${rows}</tbody></table></div>
    ${detail(t('full6.detail'), { rolesUsed: full6.rolesUsed, roleContributions: full6.roleContributions, duplicationRisks: full6.duplicationRisks, conflictSignals: full6.conflictSignals, core3DependencyLaneIds: full6.core3DependencyLaneIds })}</div>`;
}

function pendingCard(candidate) {
  const coverage = candidate.coverage;
  return `<div class="card"><div class="row"><h3>${t('pending.title')}</h3>${badge(candidate.pending.length || candidate.unassigned.length || candidate.unsupportedSourceMaterial.length ? 'PENDING' : 'PASS')}</div>
    <p class="meta">${t('pending.note')}</p>
    ${facts([
      [t('pending.sourceEvents'), coverage.sourceEventCount],
      [t('pending.assigned'), coverage.assignedEventCount],
      [t('pending.pending'), coverage.pendingEventCount],
      [t('pending.unassigned'), coverage.unassignedEventCount],
      [t('midi.unsupported'), coverage.unsupportedEventCount],
      [t('pending.complete'), coverage.complete ? t('common.yes') : t('common.no')],
    ])}
    ${candidate.pending.length ? `<div class="scroll"><table><thead><tr><th>lane</th><th>${t('pending.proposedRole')}</th><th>${t('pending.blockers')}</th><th>Gate</th></tr></thead><tbody>${candidate.pending.map(item => `<tr><td><code>${esc(item.laneId)}</code></td><td>${esc(item.proposedRole ?? '—')}</td><td>${esc(item.blockers.join(' · '))}</td><td><code>${esc(item.gate ?? '—')}</code></td></tr>`).join('')}</tbody></table></div>` : `<p class="empty">${t('pending.none')}</p>`}
    ${candidate.unassigned.length ? detail(t('pending.unassignedDetail', { n: candidate.unassigned.length }), candidate.unassigned) : ''}
    ${candidate.unsupportedSourceMaterial.length ? detail(t('pending.unsupportedDetail', { n: candidate.unsupportedSourceMaterial.length }), candidate.unsupportedSourceMaterial) : ''}
    ${detail(t('pending.diagnostics'), candidate.diagnostics)}
    ${candidate.ledger.length <= LEDGER_DISPLAY_LIMIT
      ? detail(t('pending.ledger', { n: candidate.ledger.length }), candidate.ledger)
      : `<p class="meta">${t('pending.ledgerTooLong', { n: candidate.ledger.length, limit: LEDGER_DISPLAY_LIMIT })}</p>`}</div>`;
}

function rawMidiSection(entries) {
  if (!entries?.length) return '';
  return `<section id="raw-midi"><div class="section-heading"><h2>02　${t('rawMidi.title')}</h2><small>${t('rawMidi.local')}</small></div>
    <p class="note safe">${t('rawMidi.privacy')}</p>
    ${entries.map(entry => `<div class="raw-midi-slot">
      ${midiSourceCard(entry)}
      ${percussionCard(entry)}
      ${unsupportedCard(entry)}
      ${entry.error ? `<div class="card"><div class="row"><h3>G11-B／G11-C</h3>${badge('UNSUPPORTED')}</div><p>${esc(entry.error)}</p></div>`
        : !entry.arrangement ? `<div class="card"><div class="row"><h3>G11-B／G11-C</h3>${badge('UNSUPPORTED')}</div><p class="meta">${t('rawMidi.integrityBlocked', { reasons: esc(entry.integrity.reasons.join(', ')) })}</p></div>`
        : `${voiceSplitCard(entry.arrangement.voiceSplit)}
      <div class="card candidate-banner"><div class="row"><h3>${t('candidate.title')}</h3>${badge('PENDING')}</div>
        <p>${t('candidate.banner')}</p>
        <p class="meta">${t('candidate.threeThings')}</p>
        ${facts([[t('candidate.stage'), entry.arrangement.stage], [t('candidate.kind'), entry.arrangement.stageKind], [t('candidate.accepted'), entry.arrangement.accepted ? t('common.yes') : t('common.no')], [t('candidate.certifies'), entry.arrangement.certifiesGates.length ? entry.arrangement.certifiesGates.join(', ') : t('common.none')], ['derivation', `${entry.arrangement.pipeline} · ${entry.arrangement.derivation.eventCount} events`]])}
        ${entry.persistedArrangement && !entry.persistedArrangement.current ? `<p class="note">${t('candidate.discarded', { reasons: esc(entry.persistedArrangement.reasons.join(', ')) })}</p>` : ''}</div>
      ${core3Card(entry.arrangement.candidate)}
      ${full6Card(entry.arrangement.candidate)}
      ${pendingCard(entry.arrangement.candidate)}`}
    </div>`).join('')}
    <p class="note">${t('rawMidi.scope')}</p></section>`;
}

function diffTable(diff) {
  if (!diff) return `<p class="empty">${t('diff.empty')}</p>`;
  return `<div class="scroll"><table><thead><tr><th>${t('diff.added')}</th><th>${t('diff.removed')}</th><th>${t('diff.modified')}</th><th>${t('diff.roleMoved')}</th><th>${t('diff.tempo')}</th></tr></thead><tbody><tr><td>${diff.summary.noteAdded}</td><td>${diff.summary.noteRemoved}</td><td>${diff.summary.noteModified}</td><td>${diff.summary.roleMoved}</td><td>${diff.summary.tempoChanged + diff.summary.tempoAdded + diff.summary.tempoRemoved}</td></tr></tbody></table></div>${detail(t('diff.detail'), diff)}`;
}
// ─── Final MML generation and export ────────────────────────────────────────
//
// Two states live in this section and must never be read as one:
//
//   * the *latest generation attempt* — what the emitter last said about this
//     candidate, including a FAIL or PENDING with its diagnostics;
//   * the *currently applied delivery* — the delivery string this analysis has
//     verified against the candidate, which is the string `recordAcceptance`
//     binds.
//
// A refused attempt writes nothing, so an earlier applied delivery survives it
// and the two can legitimately disagree. The panel states that in words rather
// than letting the newer badge colour the older output.
//
// Nothing here counts characters, checks syntax or repairs anything: every
// number shown is one the emitter reported.
//
// What is exported is the analysis-verified, acceptance-bound delivery string --
// deliberately not the raw stored field, because a pasted delivery is stored
// exactly as typed and may carry surrounding whitespace that the verified and
// bound form does not. For emitter output the distinction is inert: generation
// fails closed unless the emitted string is already free of surrounding
// whitespace, so a generated delivery is exported byte for byte as the emitter
// produced it, and nothing between emitter PASS and export may alter it.
// The published per-role limit, restated here only so a count can be displayed
// when no emitter result is available -- a pasted delivery has none. Where an
// emitter result exists, its own `characterCounts.limit` is used instead, so the
// authoritative number always comes from the rules module rather than from here.
const PUBLISHED_ROLE_CHARACTER_LIMIT = 2400;
// Shared P1 wording. The unit is the same in both places; where the number comes
// from is not, and saying "the emitter reported this" about a number this page
// computed would be its own small false claim.
const P1_CHARACTER_NOTE = () => t('p1.character');
const P1_EMITTER_NOTE = () => `${P1_CHARACTER_NOTE()} ${t('p1.emitter')}`;
const P1_LOCAL_NOTE = () => `${P1_CHARACTER_NOTE()} ${t('p1.local')}`;
const severityBadge = severity => (severity === 'error' ? 'FAIL' : severity === 'pending' ? 'PENDING' : 'N/A');
// The exact applied delivery, decided by two questions.
//
// *Which* string: the one the analysis verified and `recordAcceptance` binds --
// not a re-render, not a re-join of the role bodies, and deliberately not the
// raw stored field. A pasted delivery can be stored with surrounding
// whitespace, and handing that out here while `#copy-mml` and the acceptance
// record use the trimmed form would put two different strings behind two
// buttons that both read as "the complete MML". For a generated delivery the
// two are byte-identical anyway: generation fails closed unless the emitter's
// output is already free of surrounding whitespace.
//
// *Whether* there is one: only a delivery in its own right counts, generated or
// user-supplied. A candidate that merely happens to be written in MML is a
// source representation, and section 07 already offers it; treating it as this
// panel's output would put a verified-looking Final on screen before anything
// had been emitted.
const appliedDelivery = () => (['generated', 'pasted'].includes(report.deliveryOrigin) ? report.rawMml ?? null : null);
const originLabel = origin => (origin && has(`origin.${origin}`) ? t(`origin.${origin}`) : origin ?? '—');

function diagnosticsTable(items) {
  if (!items?.length) return `<p class="meta">${t('final.noDiagnostics')}</p>`;
  return `<div class="scroll"><table><thead><tr><th>${t('final.code')}</th><th>${t('final.severity')}</th><th>${t('common.role')}</th><th>${t('final.message')}</th></tr></thead><tbody>${items.map(item => `<tr><td><code>${esc(item.code)}</code></td><td>${badge(severityBadge(item.severity))}</td><td>${esc(item.role ?? '—')}</td><td>${esc(item.message)}${detail(t('final.structured'), item)}</td></tr>`).join('')}</tbody></table></div>`;
}

function finalRoleTable(attempt) {
  if (!attempt.roles?.length || !attempt.characterCounts) return `<p class="meta">${t('final.noRoles')}</p>`;
  // The emitter's own limit, never a local restatement of it.
  const limit = attempt.characterCounts.limit;
  return `<div class="scroll"><table><thead><tr><th>${t('common.role')}</th><th>${t('final.characters', { limit })}</th><th>${t('final.attacks')}</th><th>${t('final.end')}</th><th>${t('common.status')}</th></tr></thead><tbody>${attempt.roles.map(entry => `<tr><th scope="row">${esc(entry.role)}</th><td class="${entry.characters > limit ? 'over' : ''}">${entry.characters === null ? '—' : `${entry.characters} / ${limit}`}</td><td>${entry.attacks ?? '—'}</td><td>${esc(entry.end ?? '—')}</td><td>${entry.empty ? t('final.emptyRole') : entry.characters === null ? t('final.notGenerated') : t('final.hasContent')}</td></tr>`).join('')}</tbody></table></div>`;
}

function generationAttemptCard(attempt) {
  if (!attempt) return `<div class="card"><h3>${t('final.lastAttempt')}</h3><div class="empty">${t('final.noAttempt')}</div></div>`;
  const g10 = attempt.microGap ?? {};
  return `<div class="card">
    <div class="attempt-head"><h3>${t('final.lastAttempt')}</h3>${badge(attempt.status)}<span class="meta">${esc(new Date(attempt.at).toLocaleString())} · Revision ${attempt.revision}</span></div>
    <p class="note">${t('final.attemptNote')}</p>
    ${attempt.blockedGates?.length ? `<p><strong>${t('final.blockedBefore')}</strong></p><ul class="codes">${attempt.blockedGates.map(gate => `<li><code>${esc(gateLabel(gate.name))}</code> · ${esc(gate.status)}${gate.reason ? ` · ${esc(gate.reason)}` : ''}${gate.blockers?.length ? ` · ${esc(gate.blockers.join(', '))}` : ''}</li>`).join('')}</ul>` : ''}
    <h3>${t('final.perRole')}</h3>
    ${finalRoleTable(attempt)}
    <p class="note">${P1_EMITTER_NOTE()}</p>
    <h3>${t('final.diagnostics')}</h3>
    ${diagnosticsTable(attempt.diagnostics)}
    ${attempt.deliveryCheck && !(attempt.deliveryCheck.technicalOk && attempt.deliveryCheck.deliveryMatches) ? `<h3>${t('final.rejectedTitle')}</h3>
    <p class="note">${t('final.rejectedNote')}</p>
    ${facts([[t('final.technical'), attempt.deliveryCheck.technicalOk ? 'PASS' : 'FAIL'], [t('final.readbackMatches'), attempt.deliveryCheck.deliveryMatches ? 'PASS' : 'FAIL']])}
    ${attempt.deliveryCheck.errors.length ? `<ul class="codes">${attempt.deliveryCheck.errors.map(error => `<li>${esc(error)}</li>`).join('')}</ul>` : ''}` : ''}
    <h3>${t('final.g10Title')}</h3>
    ${facts([
      [t('final.g10Status'), g10.status],
      [t('final.g10Grid'), g10.safeGrid],
      [t('final.g10Preserved'), g10.preservedIntervalKeys?.length],
      [t('final.g10Rejected'), g10.rejectedIntervalKeys?.length],
      [t('final.g10Blocked'), g10.blockedIntervalKeys?.length],
      [t('final.g10Policy'), g10.policyConformant === null || g10.policyConformant === undefined ? null : g10.policyConformant ? t('common.yes') : t('common.no')],
    ])}
    <h3>${t('final.roundTrip')}</h3>
    ${attempt.roundTrip
      ? `${facts([[t('common.status'), attempt.roundTrip.status], [t('final.mismatches'), attempt.roundTrip.mismatches?.length ?? 0]])}${detail(t('final.mismatchDetail'), attempt.roundTrip)}`
      : `<p class="meta">${t('final.noRoundTrip')}</p>`}
    <h3>${t('final.canonicalTitle')}</h3>
    ${attempt.canonical ? facts([['canonical_version', attempt.canonical.canonical_version], ['canonical_status', attempt.canonical.canonical_status], ['rules_snapshot_sha', attempt.canonical.rules_snapshot_sha]]) : `<p class="meta">${t('final.noCanonical')}</p>`}
  </div>`;
}

function appliedDeliveryCard(attempt) {
  const applied = appliedDelivery();
  const supersededNote = attempt && attempt.status !== 'PASS' && applied
    ? `<p class="note">${t('final.superseded')}</p>`
    : '';
  if (!applied) {
    return `<div class="card"><div class="attempt-head"><h3>${t('final.appliedTitle')}</h3>${badge('PENDING')}</div>${supersededNote}
      <div class="empty">${t('final.noApplied')}${report.deliveryOrigin === 'candidate-source' ? `<br><br>${t('final.candidateIsMml')}` : ''}</div>
      <div class="actions"><button id="copy-final" disabled>${t('final.copy')}</button><button id="download-final" class="secondary" disabled>${t('final.download')}</button></div></div>`;
  }
  return `<div class="card"><div class="attempt-head"><h3>${t('final.appliedTitle')}</h3>${badge('PASS')}<span class="meta">${t('final.origin', { origin: esc(originLabel(report.deliveryOrigin)) })}</span></div>
    ${supersededNote}
    <p class="meta">${t('final.appliedMeta')}</p>
    <p class="note">${t('final.appliedNote')}</p>
    <label for="final-mml">${t('final.wholeLabel')}</label><div class="mml-hl">${mmlLayer(applied, technicalDiagnostics())}<textarea id="final-mml" class="code final" readonly spellcheck="false">${esc(applied)}</textarea></div>
    <div class="actions"><button id="copy-final">${t('final.copy')}</button><button id="download-final" class="secondary">${t('final.download')}</button><button id="listen-final" class="secondary">${t('common.sendToListening')}</button><a class="file-button quiet workshop-link" id="open-final-workshop" href="${esc(workshopUrl(workspace.id, 'delivery'))}">${t('common.openInWorkshop')}</a></div>
    <p class="meta">${t('final.listenNote')}</p>
    <p class="meta">${t('final.workshopNote', { label: esc(UNVERIFIED_LABEL) })}</p>
    <p class="meta">${t('final.perRoleNote')}</p>
    ${(report.tracks ?? []).map((track, index) => `<div class="role-body"><div class="row"><label for="final-role-${index}">${roles[index]}${track ? '' : ` <small>${t('final.emptyTrack')}</small>`}</label><button data-copy-role="${index}" class="quiet" ${track ? '' : 'disabled'}>${t('final.copyRole')}</button></div><div class="mml-hl">${mmlLayer(track, roleDiagnostics(index))}<textarea id="final-role-${index}" class="code" readonly spellcheck="false">${esc(track)}</textarea></div></div>`).join('')}
  </div>`;
}


// The reduction review surface: enough to read the plan, accept decisions and
// apply or roll back. Deliberately not an arrangement editor -- no drag and
// drop, no piano roll. What it must never do is present a PENDING or an
// OVERFLOW as if it were settled, so every bucket is shown with its own count
// and its own reason codes, and nothing here turns a plan PASS into a gate.
function reductionItemRows(items, outcome) {
  const rows = items.filter(item => item.outcome === outcome);
  if (!rows.length) return `<p class="empty">${t('common.none')}</p>`;
  // A source event an earlier revision duplicated reaches this stage as more
  // than one candidate event. It is one ledger entry -- the accounting is about
  // the source event -- so each copy is listed beneath it rather than the entry
  // being repeated, which would make the source-event count read wrong.
  const roleCell = item => item.manifestationCount > 1
    ? `${item.manifestations.map(entry => `${esc(entry.currentRole ?? '—')} → ${esc(entry.proposedRole ?? '—')}${entry.derived ? ` <span class="muted">${t('reduction.copy')}</span>` : ''}`).join('<br>')}`
    : `${esc(item.currentRole ?? '—')} → ${esc(item.proposedRole ?? '—')}`;
  const sourceCell = item => `<code>${esc(item.baselineEventId)}</code>${item.manifestationCount > 1 ? ` <span class="muted">×${item.manifestationCount}</span>` : ''}<br><span class="muted">${esc((item.sourceEventIds ?? []).join(' · '))}</span>`;
  return `<table class="reduction-ledger"><thead><tr><th>${t('reduction.sourceEvent')}</th><th>${t('common.role')}</th><th>${t('reduction.reason')}</th><th>Lead</th><th>Core3</th></tr></thead><tbody>${rows.slice(0, 200).map(item => `<tr>
    <td>${sourceCell(item)}</td>
    <td>${roleCell(item)}</td>
    <td>${esc(item.reasonCode)}</td>
    <td>${item.leadImpact?.affectsLead ? `${esc(item.leadImpact.kind)} · ${esc(item.leadImpact.resolvedBy ?? t('reduction.awaitingEvidence'))}` : '—'}</td>
    <td>${item.core3Impact?.leavesCore3 ? t('reduction.leavesCore3') : item.core3Impact?.entersCore3 ? t('reduction.entersCore3') : '—'}</td>
  </tr>`).join('')}</tbody></table>${rows.length > 200 ? `<p class="meta">${t('reduction.more', { n: rows.length - 200 })}</p>` : ''}`;
}

function finalReductionSection() {
  const plan = reductionPreview?.plan ?? report.finalReduction?.plan;
  const applied = Boolean(workspace.finalReduction);
  const a = plan?.accounting;
  return `<section id="final-reduction"><div class="section-heading"><h2>${t('reduction.title')}</h2><small>${t('reduction.subtitle')}</small></div><div class="card">
    <p class="meta">${t('reduction.intro')}</p>
    <div class="actions"><button id="preview-reduction" ${workspace.assets?.baseline && workspace.assets?.candidate ? '' : 'disabled'}>${t('reduction.preview')}</button>${reductionDecisions.length ? `<button id="clear-reduction-decisions" class="quiet">${t('reduction.clearPending', { n: reductionDecisions.length })}</button>` : ''}</div>
    ${applied ? `<p class="meta">${t('reduction.appliedCount', { n: workspace.finalReduction.decisions.length })}</p>` : ''}
    ${plan ? `<p>${badge(plan.status)} · ${t('reduction.accounting', { total: a.total, retained: a.retained, redistributed: a.redistributed, overflow: a.overflow, pending: a.pending, omitted: a.omitted })}</p>
      ${a.manifestationCount > a.total ? `<p class="meta">${t('reduction.duplicated', { n: a.duplicatedBaselineEventIds.length, count: a.manifestationCount })}</p>` : ''}
      <p class="meta">${t('reduction.parent')}<code>${esc(plan.parentRevisionId ?? t('reduction.parentBaseline'))}</code> · ${t('reduction.plan')}<code>${esc(plan.id)}</code></p>
      ${plan.blockers.length ? detail(t('reduction.blockers', { n: plan.blockers.length }), plan.blockers) : ''}
      ${plan.warnings.length ? detail(t('reduction.warnings', { n: plan.warnings.length }), plan.warnings) : ''}
      <details open><summary>${t('reduction.bucketPending', { n: a.pending })}</summary>${reductionItemRows(plan.items, 'PENDING')}</details>
      <details><summary>${t('reduction.bucketOverflow', { n: a.overflow })}</summary>${reductionItemRows(plan.items, 'OVERFLOW')}</details>
      <details><summary>${t('reduction.bucketRedistribute', { n: a.redistributed })}</summary>${reductionItemRows(plan.items, 'REDISTRIBUTE')}</details>
      <details><summary>${t('reduction.bucketOmit', { n: a.omitted })}</summary>${reductionItemRows(plan.items, 'OMIT')}</details>
      <details><summary>${t('reduction.bucketKeep', { n: a.retained })}</summary>${reductionItemRows(plan.items, 'KEEP')}</details>
      ${detail(t('reduction.core3Detail'), plan.core3)}
      ${detail(t('reduction.harmonyDetail'), { harmony: plan.harmony, overlapRisks: plan.overlapRisks })}
      ${detail(t('reduction.capacityDetail'), { roleCapacity: plan.roleCapacity, characterBudget: plan.characterBudget })}
      ${detail(t('reduction.mergeDetail'), plan.legacyMergeDiagnostics ?? [])}
      ${detail(t('reduction.ledgerDetail'), plan.items)}
      <p class="note">${badge(plan.status)} ${t('reduction.passNote')}</p>` : `<p class="empty">${t('reduction.notPreviewed')}</p>`}
    <details><summary>${t('reduction.recordTitle')}</summary>
      <p class="meta">${t('reduction.recordNote')}</p>
      <p class="note">${t('reduction.leadNote')}</p>
      <form id="reduction-decision"><div class="field-grid">
        <label>${t('reduction.action')}<select name="action">${options([['REDISTRIBUTE',t('reduction.actionRedistribute')],['ACCEPT_OVERFLOW',t('reduction.actionOverflow')],['OMIT',t('reduction.actionOmit')],['KEEP',t('reduction.actionKeep')]],'REDISTRIBUTE')}</select></label>
        <label>${t('common.targetRole')}<select name="toRole">${options([['',t('reduction.notApplicable')],...roles.map(role=>[role,role])],'')}</select></label>
        ${input('eventIds',t('reduction.eventIds'),'')}
        ${input('evidence',t('reduction.evidence'),'')}
        <label class="wide">${t('common.reason')}<textarea name="reason" required></textarea></label>
      </div><button class="secondary">${t('reduction.addDecision')}</button></form>
      ${reductionDecisions.length ? detail(t('reduction.pendingDecisions', { n: reductionDecisions.length }), reductionDecisions) : ''}
    </details>
    ${reductionPreview && plan?.status === 'PASS' && plan.decisions.length ? `<button id="apply-reduction">${t('reduction.apply')}</button>` : ''}
    ${applied ? `<button id="clear-reduction" class="secondary">${t('reduction.restore')}</button>` : ''}
    <p class="meta">${t('reduction.storageNote')}</p>
  </div></section>`;
}

function mobileAdaptationSection() {
  const plan = mobilePreview?.plan ?? report.mobileAdaptation?.plan;
  const profile = mobilePreview?.profile ?? workspace.mobileAdaptation?.profile;
  return `<section id="mobile-adaptation"><div class="section-heading"><h2>${t('mobile.title')}</h2><small>${t('mobile.subtitle')}</small></div><div class="card">
    <p class="meta">${t('mobile.intro')}</p>
    <form id="mobile-profile"><div class="field-grid">${input('profileId',t('mobile.profileId'),profile?.id ?? '')}${input('reason',t('mobile.reason'),profile?.reason ?? '')}${input('evidence',t('mobile.evidence'),profile?.evidence?.join('; ') ?? '')}</div>
    ${roles.map(role => { const rule = profile?.roles?.[role] ?? {}; return `<details><summary>${esc(role)}</summary><div class="field-grid">${input(`${role}-min`,t('mobile.min'),rule.pitchRange?.[0] ?? '', 'type="number" min="0" max="107" step="1"')}${input(`${role}-max`,t('mobile.max'),rule.pitchRange?.[1] ?? '', 'type="number" min="0" max="107" step="1"')}${input(`${role}-delta`,t('mobile.delta'),rule.volumeDelta ?? '', 'type="number" min="-15" max="15" step="1"')}${input(`${role}-default`,t('mobile.default'),rule.defaultVolume ?? '', 'type="number" min="0" max="15" step="1"')}</div></details>`; }).join('')}
    <div class="actions"><button id="preview-mobile" ${workspace.assets?.baseline && workspace.assets?.candidate ? '' : 'disabled'}>${t('mobile.preview')}</button></div></form>
    ${plan ? `<p>${badge(plan.status)} · ${mobilePreview ? t('mobile.toAdjust', { n: plan.changes.length }) : t('mobile.adjusted', { n: plan.changes.length })}</p>${plan.blockers.length ? detail(t('mobile.blockers'), plan.blockers) : ''}${plan.warnings.length ? detail(t('mobile.warnings'),plan.warnings) : ''}${detail(t('mobile.changes'),plan.changes)}<p class="meta">${t('mobile.applyNote')}</p>` : ''}
    ${mobilePreview && plan.status === 'PASS' && plan.changes.length ? `<button id="apply-mobile">${t('mobile.apply')}</button>` : ''}
    ${workspace.mobileAdaptation ? `<button id="clear-mobile" class="secondary">${t('mobile.restore')}</button>` : ''}
    <p class="meta">${t('mobile.storageNote')}</p>
  </div></section>`;
}

function finalDeliverySection() {
  const attempt = workspace.finalDelivery ?? null;
  const blocked = (report.blockers ?? []).filter(name => !['technical', 'deliveryIdentity'].includes(name));
  return `<section id="final-delivery"><div class="section-heading"><h2>06　${t('final.title')}</h2><small>${t('final.subtitle')}</small></div>
    <div class="card">
      <p class="meta">${t('final.intro')}</p>
      ${blocked.length ? `<p class="note">${t('final.blockedNote', { n: blocked.length })}</p>` : ''}
      <div class="actions"><button id="generate-final">${t('final.generate')}</button></div>
    </div>
    ${generationAttemptCard(attempt)}
    ${appliedDeliveryCard(attempt)}
    ${timbrePreviewCard()}
  </section>`;
}
function render() {
  const r = report, w = workspace, s = w.settings;
  const gates = Object.entries(r.gates ?? {});
  const leadFields = (idField, idLabel, extraField, reasonLabel) => `${input(idField, idLabel, '')}${extraField}<label>${t('lead.sectionRole')}<select name="sectionRole">${options(['unknown','vocal-active','vocal-rest','instrumental','intro','interlude','solo','outro'].map(x=>[x,x]),'unknown')}</select></label><label>${t('lead.scoreClass')}<select name="scoreClass">${options(['unknown','lead','accompaniment','inner','counter','duplicate'].map(x=>[x,x]),'unknown')}</select></label>${input('scoreCitation',t('lead.scoreCitation'),'')}<label>${t('lead.audioClass')}<select name="audioClass">${options(['unknown','foreground','background','mixed'].map(x=>[x,x]),'unknown')}</select></label>${input('audioCitation',t('lead.audioCitation'),'')}${input('positiveReason',reasonLabel,'')}<label>${t('lead.continuity')}<select name="continuity"><option value="unknown">${t('common.notConfirmed')}</option><option value="checked">${t('lead.continuityChecked')}</option></select></label>`;
  $('#app').innerHTML = `
    <div class="hero"><p class="eyebrow">LOCAL-FIRST / STUDIO V1</p><div class="hero-line"><h1>${esc(w.title)}</h1>${badge(r.state)}</div><p>${t('hero.tagline')}</p><div class="state-path"><span class="${r.state === 'CANDIDATE' ? 'current' : ''}">01　Candidate</span><span class="${r.state === 'VALIDATED' ? 'current' : ''}">02　Validated</span><span class="${r.state === 'IN_GAME_ACCEPTED' ? 'current' : ''}">03　In-game Accepted</span></div><p class="meta">${w.savedAt ? t('hero.savedAt', { time: esc(new Date(w.savedAt).toLocaleString()) }) : t('hero.unsaved')} · Revision ${w.revision}</p></div>
    <section id="intake"><div class="section-heading"><h2>01　${t('intake.title')}</h2><small>${t('intake.local')}</small></div>
      <div class="card"><form id="settings"><div class="field-grid">${input('title', t('settings.title'), w.title)}${input('recording', t('settings.recording'), s.recording)}${input('offset', t('settings.offset'), s.offset, 'type="number" min="0" step="any"')}${input('end', t('settings.end'), s.end, 'type="number" min="0" step="any"')}<label>${t('settings.meter')}<textarea name="meterText" placeholder="${esc(t('settings.meterPlaceholder'))}">${esc(s.meterText)}</textarea></label><div><label>${t('settings.audioRequired')}<select name="audioRequired">${options([['unknown',t('common.notConfirmed')],['yes',t('settings.audioYes')],['no',t('settings.audioNo')]],s.audioRequired)}</select></label><label>${t('settings.preview')}<select name="preview">${options([['unknown',t('common.notConfirmed')],['none',t('settings.previewNone')],['used',t('settings.previewUsed')]],s.preview)}</select></label></div></div><div class="actions"><button>${t('settings.save')}</button></div><p class="meta">${t('settings.invalidates')}</p></form></div>
      <div class="row"><p class="meta">${t('intake.authorityNote')}</p><select id="authority" aria-label="${esc(t('intake.authorityAria'))}"><option value="supporting">${t('intake.authoritySupporting')}</option><option value="primary-symbolic">${t('intake.authorityPrimary')}</option></select></div>
      <div class="grid intake-grid">${intakeCard('candidate',t('slot.candidate'),t('intake.candidateHint'))}${intakeCard('baseline','Source-Faithful Baseline',t('intake.baselineHint'))}${intakeCard('previous',t('slot.previous'),t('intake.previousHint'))}</div>
      <details class="card"><summary>${t('paste.summary')}</summary><form id="paste"><div class="field-grid"><label>${t('paste.slot')}<select name="slot">${options([['candidate',t('slot.candidate')],['baseline',t('paste.baseline')],['previous',t('paste.previous')],['delivery',t('paste.delivery')]],'candidate')}</select></label>${input('name',t('paste.name'),'pasted.mml')}</div><label for="paste-content">${t('paste.content')}</label><div class="mml-hl"><pre class="mml-hl-layer" id="paste-layer" aria-hidden="true"></pre><textarea id="paste-content" name="content" class="code" required spellcheck="false" placeholder="MML@…,…,…,…,…,…;"></textarea></div><p class="meta" id="paste-counts" aria-live="polite"></p><div class="actions"><button>${t('paste.load')}</button></div></form></details>
    </section>
    ${rawMidiSection(r.rawMidi)}
    <section id="gates"><div class="section-heading"><h2>03　Analysis Gate</h2><span class="ready-count">${t('gates.open', { n: r.blockers?.length ?? 0 })}</span></div><div class="gate-grid">${gates.map(([name,g])=>`<div class="gate"><strong>${esc(gateLabel(name))}</strong>${badge(g.status)}<p>${esc(g.reason ?? g.blockers?.join(' · ') ?? '')}</p>${detail(t('gates.checked'),g)}</div>`).join('')}</div><p class="note">${t('gates.note')}</p></section>
    <section id="review"><div class="section-heading"><h2>04　${t('review.title')}</h2><small>${t('review.subtitle')}</small></div>${reviewRollCard()}
      <div class="card"><h3>Version Drift</h3><p class="review-subtitle">${t('review.driftSubtitle')}</p>${diffTable(r.lineage?.sourceToCandidate)}<details><summary>${t('review.driftPrevious')}</summary>${diffTable(r.lineage?.previousToCandidate)}</details></div>
      <div class="grid"><div class="card"><h3>Lead / Core3</h3><p class="meta">${t('review.leadCore3Note')}</p>${r.core3 ? detail(t('review.core3Detail'),r.core3) : `<p class="empty">${t('review.awaitingBaseline')}</p>`}${detail(t('review.leadDemotionResults'),r.leadReports ?? [])}${detail(t('review.leadPromotionResults'),r.leadPromotionReports ?? [])}<div id="core3-changes">${(r.core3?.unapproved ?? []).map((change,index)=>`<form class="conflict" data-core3="${index}"><p class="meta">${esc(change.type)} · ${esc(change.eventId)}</p>${input('reason',t('review.core3Reason'),'')}${input('evidence',t('review.core3Evidence'),'')}<button class="secondary">${t('review.core3Record')}</button></form>`).join('')}</div></div><div class="card"><h3>${t('review.overlapTitle')}</h3><p class="meta">${t('review.overlapNote')}</p>${detail(t('review.overlapDetail'),r.technical?.song?.review ?? {status:'PENDING'})}<p class="note">${t('review.fixturePending')}</p></div></div>
      <div class="card"><h3>Harmony arbitration</h3><p class="meta">${t('harmony.note', { n: r.harmony?.unresolvedCount ?? '—' })}</p>${(r.harmony?.conflicts ?? []).map((c,index)=>`<form class="conflict" data-harmony="${index}"><div class="row"><strong>${esc(c.intervalName)} · ${esc(c.leftRole)} / ${esc(c.rightRole)}</strong>${badge(c.resolved?'PASS':'PENDING')}</div><p class="meta">${t('harmony.beats', { start: esc(c.start), end: esc(c.end) })} · pitch ${c.leftPitch} / ${c.rightPitch}<br>${esc(c.leftEventId)}<br>${esc(c.rightEventId)}</p>${c.resolved?json(c.decision):`<div class="field-grid"><label>${t('harmony.decision')}<select name="action">${options([['pending',t('harmony.pending')],['keep',t('harmony.keep')],['omit',t('harmony.omit')],['move-role',t('harmony.moveRole')],['octave',t('harmony.octave')],['redistribute',t('harmony.redistribute')]],'pending')}</select></label>${input('reason',t('harmony.reason'),'')}${input('evidence',t('harmony.evidence'),'')}</div><button class="secondary">${t('harmony.record')}</button>`}</form>`).join('') || `<p class="empty">${t('harmony.none')}</p>`}</div>
      ${r.importedDecisions?.length ? `<div class="card"><h3>${t('imported.title')}</h3><p class="meta">${t('imported.note')}</p>${r.importedDecisions.map((d,index)=>`<form class="conflict" data-imported-decision="${index}">${detail(d.id,d)}${input('reason',t('imported.reason'),'')}${input('evidence',t('imported.evidence'),'')}<button class="secondary">${t('imported.confirm')}</button></form>`).join('')}</div>` : ''}
      <details class="card"><summary>${t('lead.demotionSummary')}</summary><form id="lead-form"><div class="field-grid">${leadFields('eventId',t('lead.baselineEventId'),input('destinationRole',t('lead.destinationRole'),''),t('lead.demotionReason'))}</div><button class="secondary">${t('lead.demotionRun')}</button></form></details>
      <details class="card"><summary>${t('lead.promotionSummary')}</summary><p class="meta">${t('lead.promotionNote')}</p><form id="lead-promotion-form"><div class="field-grid">${leadFields('promotedEventId',t('lead.promotedEventId'),input('originEventId',t('lead.originEventId'),''),t('lead.promotionReason'))}</div><button class="secondary">${t('lead.promotionRun')}</button></form></details>
      <div class="card"><h3>${t('reviewForm.title')}</h3><p class="meta">${t('reviewForm.note')}</p><form id="review-form"><div class="field-grid"><label>${t('reviewForm.name')}<select name="name">${options(Object.entries(reviewLabels()),'source')}</select></label>${input('evidence',t('reviewForm.evidence'),'')}<label class="wide">${t('reviewForm.conclusion')}<textarea name="note" required></textarea></label></div><button>${t('reviewForm.record')}</button></form>${Object.entries(w.reviews).map(([name,v])=>`<div class="review-log"><strong>${esc(reviewLabels()[name] ?? name)}</strong> · ${esc(v.note)}<br><span class="muted">${esc(v.evidence)}</span></div>`).join('')}</div>
    </section>
    <section id="audio"><div class="section-heading"><h2>05　Audio evidence</h2><small>${t('audio.subtitle')}</small></div><div class="card"><p class="note safe">${t('audio.privacy')}</p><p id="audio-file-status" class="meta">${audioFile?esc(t('audio.fileStatus', { name: audioFile.name, size: (audioFile.size/1048576).toFixed(1) })):t('audio.noFile')}</p><label class="file-button secondary">${t('audio.choose')}<input id="audio-file" type="file" accept=".m4a,.flac,.wav,audio/mp4,audio/flac,audio/wav"></label><details><summary>${t('audio.workerSummary')}</summary><label>HTTPS alignment endpoint<input id="audio-endpoint" type="url" placeholder="https://your-worker.example/align" autocomplete="off"></label><label>${t('audio.token')}<input id="audio-token" type="password" autocomplete="off"></label><p class="meta">${t('audio.tokenNote')}</p></details><div class="actions"><button id="request-audio" ${!audioFile || !w.assets.candidate?'disabled':''}>${t('audio.request')}</button><button id="cancel-audio" class="quiet" ${uploadController?'':'disabled'}>${t('audio.cancel')}</button><label class="file-button quiet">${t('audio.importReport')}<input id="audio-report" type="file" accept=".json,application/json"></label></div><div id="audio-progress" role="status"></div>${detail(t('audio.detail'),w.audio?.report ?? {status:'PENDING',reason:'SONG_AUDIO_EVIDENCE_MISSING'})}<p class="meta">${t('audio.scope')}</p></div></section>
    ${finalReductionSection()}
    ${mobileAdaptationSection()}
    ${finalDeliverySection()}
    <section id="delivery"><div class="section-heading"><h2>07　${t('delivery.title')}</h2>${badge(r.state)}</div><div class="card"><p class="note">${r.state==='CANDIDATE'?t('delivery.stateCandidate'):r.state==='VALIDATED'?t('delivery.stateValidated'):t('delivery.stateAccepted')}</p><p class="meta">${t('delivery.note')}</p><div class="actions"><button id="copy-mml" ${r.rawMml?'':'disabled'}>${t('delivery.copy')}</button><button id="listen-mml" class="secondary" ${r.rawMml?'':'disabled'}>${t('common.sendToListening')}</button><button id="export-mml" class="secondary" ${r.rawMml?'':'disabled'}>${t('delivery.exportText')}</button><button id="export-report" class="quiet">${t('delivery.exportReport')}</button></div>${r.tracks?`${r.tracks.map((track,i)=>`<div class="track"><div class="row"><label for="track-${i}">${roles[i]} <small>${t('delivery.characters', { n: track.length, limit: PUBLISHED_ROLE_CHARACTER_LIMIT })}</small></label><button data-copy-track="${i}" class="quiet">${t('common.copy')}</button></div><div class="mml-hl">${mmlLayer(track, roleDiagnostics(i))}<textarea id="track-${i}" class="code" readonly spellcheck="false">${esc(track)}</textarea></div></div>`).join('')}<p class="note">${P1_LOCAL_NOTE()}</p>`:`<p class="empty">${t('delivery.noTracks')}</p>`}<details><summary>${t('delivery.acceptSummary')}</summary><form id="acceptance"><div class="field-grid">${input('client',t('delivery.client'),'')}${input('instrument',t('delivery.instrument'),'')}${input('evidence',t('delivery.evidence'),'')}</div><button ${r.state==='CANDIDATE'?'disabled':''}>${t('delivery.accept')}</button></form>${w.acceptance?json(w.acceptance):''}</details></div>${engineProbeCard()}</section>
    <details class="card"><summary>${t('identity.summary')}</summary><p class="meta">${t('identity.note')}</p>${json(identity.metadata)}${identity.provenance?json(identity.provenance):''}${identity.documents.map(d=>`<details><summary>${esc(d.path)} · ${esc(d.authority)}</summary><a href="${esc(d.url)}" target="_blank" rel="noopener">${t('identity.snapshot')}</a><pre>${esc(d.content)}</pre></details>`).join('')}</details>`;
  bind();
  // View-only bindings for freshly rendered DOM (highlight layers, review roll).
  bindHighlightLayers();
  bindReviewRoll();
  bindTimbrePreview();
  bindEngineProbes();
}
async function putSource(slot, name, content, authority = 'supporting') {
  if (slot === 'delivery') { const next = await call('invalidate',workspace); next.deliveryMml = content; await commit(next); return; }
  const asset = await call('intake', { name, content, id: crypto.randomUUID(), meterText: workspace.settings.meterText, authority });
  const next = await call('invalidate',workspace); next.assets[slot] = asset;
  await commit(next);
}
// Four bytes decide, not the extension. A native picker's filter is a hint: a
// .mid holding text and a MIDI file named something else both have to reach the
// right decoder, and the decoder still validates everything after MThd.
async function isMidiFile(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (head.length === 4 && head[0] === 0x4d && head[1] === 0x54 && head[2] === 0x68 && head[3] === 0x64) return true;
  return /\.(mid|midi)$/i.test(file.name);
}
// Compressed MusicXML is a ZIP archive: "PK\x03\x04", whatever the file is
// called. Its bytes go to the shared container reader, never through text().
async function isZipFile(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head.length === 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}
async function putMxlSource(slot, file, authority) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const asset = await call('intakeMxl', { name: file.name, bytes, id: crypto.randomUUID(), meterText: workspace.settings.meterText, authority });
  const next = await call('invalidate', workspace); next.assets[slot] = asset;
  await commit(next);
}
async function putMidiSource(slot, file, authority, token) {
  // Checked on both sides of the decode, because either side can go stale: a
  // second file may be chosen for this slot while this one waits its turn, and
  // another may be chosen, or another project opened, while it decodes
  // off-thread. Never silently: a discarded result says so.
  const stale = () => {
    const verdict = midiRequests.evaluate(token, { projectId: workspace?.id });
    if (verdict.accepted) return false;
    message(t('msg.midiStale', { reason: verdict.reason }), true);
    return true;
  };
  if (stale()) return;
  // Real bytes. Nothing between the picker and ingestMIDI reads them as text.
  // postMessage structured-clones the buffer instead of transferring it, so
  // this page keeps its own copy and persistence never races the decode.
  const bytes = await file.arrayBuffer();
  // No id is supplied: the source identity is the digest of these exact bytes.
  // A random one here would make the same file a different Canonical source on
  // every pick, renumbering every event that evidence binds to. The ephemeral
  // identity this path does need is `token`, and it stays out of provenance.
  const asset = await call('intakeMidi', { name: file.name, bytes, authority });
  if (stale()) return;
  // Replacement is one transaction: the previous source is only released once
  // the new one has decoded, and the new revision clears every review and
  // acceptance recorded against the old bytes.
  const next = await call('invalidate', workspace);
  next.assets[slot] = asset;
  await commit(next);
}
// Clipboard, with a visible fallback for the browsers that refuse it.
//
// The fallback exists to hand over the *same string* the clipboard would have
// received, so it renders `value` verbatim into a read-only field -- never a
// re-derived or re-formatted copy of it. An existing fallback is replaced
// rather than stacked, because a page showing two boxes both captioned "the
// MML" is a page that cannot say which one is the delivery.
function dismissCopyFallback() { document.querySelector('#copy-fallback')?.remove(); }
function showCopyFallback(value, textarea) {
  dismissCopyFallback();
  // Reuse a field already on screen only when it holds exactly this string.
  if (textarea && textarea.value === value) { textarea.focus(); textarea.select(); }
  else {
    const box = document.createElement('div');
    box.id = 'copy-fallback'; box.className = 'card';
    const label = document.createElement('p');
    label.className = 'meta';
    label.textContent = t('copy.fallbackLabel');
    const area = document.createElement('textarea');
    area.className = 'code'; area.readOnly = true; area.spellcheck = false;
    // Assigned, not templated: nothing between the source string and the field.
    area.value = value;
    const close = document.createElement('button');
    close.className = 'quiet'; close.type = 'button'; close.textContent = t('common.close');
    close.onclick = dismissCopyFallback;
    box.append(label, area, close);
    (document.querySelector('#final-delivery') ?? document.querySelector('#delivery')).append(box);
    area.focus(); area.select();
  }
  message(t('copy.fallbackMessage'), true);
}
async function copyText(value, textarea) {
  if (typeof value !== 'string' || !value) return message(t('copy.nothing'));
  try { await navigator.clipboard.writeText(value); dismissCopyFallback(); message(t('copy.done')); }
  catch { showCopyFallback(value, textarea); }
}
function bind() {
  $('#reduction-decision').onsubmit = event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const eventIds = data.eventIds.split(/[;\s]+/).map(id => id.trim()).filter(Boolean);
    if (!eventIds.length) return message(t('reduction.needEventId'));
    const decision = { id: `web:${data.action.toLowerCase()}:${reductionDecisions.length + 1}`, action: data.action, eventIds, reason: data.reason,
      evidence: data.evidence.split(';').map(ref => ref.trim()).filter(Boolean) };
    if (data.action === 'REDISTRIBUTE') {
      if (!data.toRole) return message(t('reduction.needRole'));
      decision.toRole = data.toRole;
    }
    reductionDecisions = [...reductionDecisions, decision];
    reductionPreview = null;
    render();
    message(t('reduction.added'));
  };
  const clearDecisions = $('#clear-reduction-decisions');
  if (clearDecisions) clearDecisions.onclick = () => { reductionDecisions = []; reductionPreview = null; render(); };
  $('#preview-reduction').onclick = event => {
    event.preventDefault();
    // The reduction is always re-derived from the loaded candidate with the
    // whole decision set, so a preview taken after one was applied has to carry
    // the decisions already accepted -- otherwise it would show the pre-reduction
    // picture beside a panel saying the reduction is applied, and the material
    // the applied decisions resolved would read as pending again.
    const decisions = [...(workspace.finalReduction?.decisions ?? []), ...reductionDecisions];
    run(async () => { const plan = await call('previewFinalReduction', workspace, decisions, { acceptedBy: 'local-workspace-user' }); reductionPreview = { decisions, plan }; render(); });
  };
  const applyReduction = $('#apply-reduction');
  if (applyReduction) applyReduction.onclick = () => {
    const preview = reductionPreview;
    run(async () => {
      const result = await call('applyWorkspaceFinalReduction', workspace, { decisions: preview.decisions, expectedPlanId: preview.plan.id, acceptedBy: 'local-workspace-user' });
      if (!result.applied) { reductionPreview = { decisions: preview.decisions, plan: result.plan }; render(); message(result.blockers?.map(item => item.code).join(', ') || t('reduction.nothingToApply')); return; }
      await commit(result.workspace);
      message(t('reduction.applied'));
    });
  };
  const clearReduction = $('#clear-reduction');
  if (clearReduction) clearReduction.onclick = () => run(async () => commit(await call('clearFinalReduction', workspace)));
  $('#mobile-profile').onsubmit = event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const profile = { schema: 'mml-studio/mobile-adaptation-profile@1', id: data.profileId, reason: data.reason, evidence: data.evidence.split(';').map(ref => ref.trim()).filter(Boolean), roles: {} };
    for (const role of roles) {
      const rule = {};
      if (data[`${role}-min`] !== '' || data[`${role}-max`] !== '') rule.pitchRange = [data[`${role}-min`] === '' ? null : Number(data[`${role}-min`]), data[`${role}-max`] === '' ? null : Number(data[`${role}-max`])];
      if (data[`${role}-delta`] !== '') rule.volumeDelta = Number(data[`${role}-delta`]);
      if (data[`${role}-default`] !== '') rule.defaultVolume = Number(data[`${role}-default`]);
      if (Object.keys(rule).length) profile.roles[role] = rule;
    }
    run(async () => { const plan = await call('previewMobileAdaptation', workspace, profile); mobilePreview = { profile, plan }; render(); });
  };
  const applyMobile = $('#apply-mobile');
  if (applyMobile) applyMobile.onclick = () => {
    const preview = mobilePreview;
    run(async () => {
      const result = await call('applyWorkspaceMobileAdaptation', workspace, { profile: preview.profile, expectedPlanId: preview.plan.id, acceptedBy: 'local-workspace-user' });
      if (!result.applied) { mobilePreview = { profile: preview.profile, plan: result.plan }; render(); message(result.blockers?.map(item => item.code).join(', ') || t('mobile.nothingToApply')); return; }
      await commit(result.workspace);
      message(t('mobile.applied'));
    });
  };
  const clearMobile = $('#clear-mobile');
  if (clearMobile) clearMobile.onclick = () => run(async () => commit(await call('clearMobileAdaptation', workspace)));
  $('#settings').onsubmit = event => { event.preventDefault(); const data=Object.fromEntries(new FormData(event.target)); run(async()=>{
    const next=await call('invalidate',workspace); next.title=data.title; const {title,...settings}=data; next.settings=settings;
    if(settings.meterText!==workspace.settings.meterText) for(const [slot,a] of Object.entries(next.assets)) if(a.format==='MML') next.assets[slot]=await call('intake',{name:a.name,content:a.content,id:a.project.sources[0].id,meterText:settings.meterText});
    await commit(next);
  },{revisionBound:false}); };
  document.querySelectorAll('[data-intake]').forEach(input=>input.onchange=()=>{
    const file=input.files[0],authority=$('#authority').value,slot=input.dataset.intake;
    // A file input fires no change event when the chosen value is unchanged, so
    // clearing it here is what lets the same file be selected again after a
    // failure or a replacement. The File itself is already captured.
    input.value='';
    if(!file)return;
    // Taken now, not when the task runs: a second choice for this slot has to
    // supersede the first even while the first is still decoding off-thread.
    const token=midiRequests.begin(slot,{projectId:workspace?.id,revision:workspace?.revision});
    run(async()=>{
      if(file.size>MAX_SOURCE_BYTES)throw Error(`UNSUPPORTED: ${t('intake.tooLarge', { size: (file.size/1048576).toFixed(1) })}`);
      if(await isMidiFile(file))await putMidiSource(slot,file,authority,token);
      else if(await isZipFile(file))await putMxlSource(slot,file,authority);
      else await putSource(slot,file.name,await file.text(),authority);
    },{revisionBound:false});
  });
  document.querySelectorAll('[data-download-ir]').forEach(button=>button.onclick=()=>{const asset=workspace.assets[button.dataset.downloadIr];download('canonical-project.json',JSON.stringify(asset.project,null,2));});
  $('#paste').onsubmit=event=>{event.preventDefault();const data=Object.fromEntries(new FormData(event.target)),authority=$('#authority').value;
    // Pasting into a slot supersedes an in-flight file choice for that slot too.
    if(data.slot!=='delivery')midiRequests.begin(data.slot,{projectId:workspace?.id,revision:workspace?.revision});
    run(()=>putSource(data.slot,data.name,data.content,authority),{revisionBound:false});};
  $('#review-form').onsubmit=event=>{event.preventDefault();const data=Object.fromEntries(new FormData(event.target));run(async()=>commit(await call('recordReview',workspace,data.name,data.note,data.evidence)));};
  document.querySelectorAll('[data-harmony]').forEach(form=>form.onsubmit=event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form)),conflict=report.harmony.conflicts[Number(form.dataset.harmony)];run(async()=>{
    if(!data.reason?.trim()||!data.evidence?.trim())throw Error(t('harmony.needReason'));
    const next=structuredClone(workspace);next.acceptance=null;next.harmonyDecisions=next.harmonyDecisions.filter(d=>d.id!==conflict.id);next.harmonyDecisions.push({id:conflict.id,eventIds:[conflict.leftEventId,conflict.rightEventId],action:data.action,status:data.action==='keep'?'accepted':'pending',reason:data.reason,evidence:[data.evidence],revision:workspace.revision});await commit(next);
  });});
  document.querySelectorAll('[data-core3]').forEach(form=>form.onsubmit=event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form)),change=report.core3.unapproved[Number(form.dataset.core3)];run(async()=>{
    if(!data.reason?.trim()||!data.evidence?.trim())throw Error(t('review.core3NeedReason'));const next=structuredClone(workspace);next.acceptance=null;next.core3Approvals.push({eventId:change.eventId,type:change.type,reason:data.reason,evidence:[data.evidence],revision:workspace.revision});await commit(next);
  });});
  document.querySelectorAll('[data-imported-decision]').forEach(form=>form.onsubmit=event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form)),original=report.importedDecisions[Number(form.dataset.importedDecision)];run(async()=>{
    if(!data.reason?.trim()||!data.evidence?.trim())throw Error(t('imported.needReason'));const next=structuredClone(workspace);next.acceptance=null;next.harmonyDecisions=next.harmonyDecisions.filter(d=>d.id!==original.id);next.harmonyDecisions.push({...original,action:'keep',status:'accepted',reason:data.reason,evidence:[data.evidence],revision:workspace.revision});await commit(next);
  });});
  // The Lead evidence record is built behind the Worker by the model, from the
  // baseline event that is loaded. The page supplies the form fields only: it
  // never constructs a source identity, so it can never pair one by array index.
  $('#lead-form').onsubmit=event=>{event.preventDefault();const d=Object.fromEntries(new FormData(event.target));run(async()=>{await commit(await call('recordLeadEvidence',workspace,d));});};
  $('#lead-promotion-form').onsubmit=event=>{event.preventDefault();const d=Object.fromEntries(new FormData(event.target));run(async()=>{await commit(await call('recordLeadPromotionEvidence',workspace,d));});};
  $('#audio-file').onchange=()=>{const file=$('#audio-file').files[0]??null;run(async()=>{audioFile=file;const next=await call('invalidate',workspace);next.settings.audioRequired='yes';await commit(next);},{revisionBound:false});};
  $('#request-audio').onclick=()=>{
    const endpoint=$('#audio-endpoint').value,token=$('#audio-token').value,file=audioFile;
    return run(async()=>{
    const revision=workspace.revision,projectId=workspace.id;
    const {requestAudioAlignment,verifyAudioBinding}=await import('./audio-client.mjs');uploadController=new AbortController();$('#cancel-audio').disabled=false;$('#audio-progress').textContent=t('audio.running');
    const timeout=setTimeout(()=>uploadController?.abort(),180000);
    try{const alignment=await requestAudioAlignment({requested:true,file,project:workspace.assets.candidate.project,endpoint,token,signal:uploadController.signal});if(workspace.id!==projectId||workspace.revision!==revision)throw Error(t('audio.stale'));const next=structuredClone(workspace);next.audio={revision,report:alignment,projectIdentity:await verifyAudioBinding(alignment,workspace.assets.candidate.project)};delete next.reviews.audio;next.acceptance=null;await commit(next);}
    finally{clearTimeout(timeout);uploadController=null;$('#audio-progress').textContent='';$('#cancel-audio').disabled=true;}
    });
  };
  $('#cancel-audio').onclick=()=>uploadController?.abort();
  $('#audio-report').onchange=()=>{const file=$('#audio-report').files[0];if(file)run(async()=>{if(file.size>4194304)throw Error('Report exceeds 4 MiB');const next=structuredClone(workspace);const alignment=JSON.parse(await file.text());const {verifyAudioBinding}=await import('./audio-client.mjs');next.audio={revision:workspace.revision,report:alignment,projectIdentity:await verifyAudioBinding(alignment,workspace.assets.candidate.project)};delete next.reviews.audio;next.acceptance=null;await commit(next);});};
  // Final generation. The request is bound to the project and revision it was
  // made against *before* it leaves for the Worker, and that binding is checked
  // again when the answer comes back: generation runs off the main thread, so
  // the workspace on screen can move while it runs, and derived output must
  // never be written onto a newer one. `run` already refuses a queued action
  // whose revision moved; this covers the request that was already in flight.
  $('#generate-final').onclick=()=>run(async()=>{
    const projectId=workspace.id,revision=workspace.revision;
    const result=await call('generateFinalDelivery',workspace);
    if(workspace.id!==projectId||workspace.revision!==revision) return message(t('final.stale'),true);
    await commit(await call('applyFinalDelivery',workspace,result));
    message(result.status==='PASS'?t('final.generated'):t('final.generateFailed', { status: result.status }),result.status!=='PASS');
  });
  // Exactly the stored delivery string. No re-render, no re-join of role bodies.
  $('#copy-final').onclick=()=>copyText(appliedDelivery(),$('#final-mml'));
  $('#download-final').onclick=()=>download('final-delivery.mml',appliedDelivery(),'text/plain');
  document.querySelectorAll('[data-copy-role]').forEach(button=>button.onclick=()=>{const i=Number(button.dataset.copyRole);copyText(report.tracks[i],$(`#final-role-${i}`));});
  $('#copy-mml').onclick=()=>copyText(report.rawMml);
  document.querySelectorAll('[data-copy-track]').forEach(button=>button.onclick=()=>{const i=Number(button.dataset.copyTrack);copyText(report.tracks[i],$(`#track-${i}`));});
  $('#export-mml').onclick=()=>download('six-track-mml.txt',`${report.rawMml}\n\n${report.tracks.map((t,i)=>`${roles[i]}\n${t}`).join('\n\n')}`,'text/plain');
  $('#export-report').onclick=()=>download('studio-analysis.json',JSON.stringify({canonical:identity.metadata,provenance:identity.provenance,revision:workspace.revision,...report},null,2));
  $('#acceptance').onsubmit=event=>{event.preventDefault();const data=Object.fromEntries(new FormData(event.target));run(async()=>commit(await call('recordAcceptance',workspace,data)));};
  // 送到試聽: a separate listening session for the MML on screen. Nothing in
  // the project changes; the session only reads the string, its meter map and,
  // for the verified delivery, the places this analysis says still need a
  // person's ear.
  const listenFinal=$('#listen-final');
  if(listenFinal)listenFinal.onclick=()=>sendToListening(appliedDelivery(),'Final MML',{markers:true});
  const listenMml=$('#listen-mml');
  if(listenMml)listenMml.onclick=()=>sendToListening(report.rawMml,report.deliveryOrigin==='candidate-source'?t('listen.candidateMml'):t('listen.wholeMml'),{markers:true});
  document.querySelectorAll('[data-listen-asset]').forEach(button=>button.onclick=()=>{const slot=button.dataset.listenAsset;sendToListening(workspace.assets[slot]?.content,slotLabel(slot));});
}
function sendToListening(mml,label,{markers=false}={}){
  if(!listening||typeof mml!=='string'||!mml.trim())return message(t('listen.nothing'));
  const alternatives=[['Final MML',appliedDelivery()],[t('listen.wholeMml'),report?.rawMml],...['candidate','baseline','previous'].map(slot=>[slotLabel(slot),workspace.assets[slot]?.format==='MML'?workspace.assets[slot].content:null])].filter(([,text])=>typeof text==='string'&&text.trim()).map(([name,text])=>({label:name,mml:text}));
  listening.openFromProject({projectId:workspace.id,projectTitle:workspace.title,label,mml,meterText:workspace.settings?.meterText??'',markers:markers?markersFromReport(report):[],notes:workspace.listeningNotes??[],alternatives}).catch(error=>message(error.message,true));
}

$('#new-project').onclick=()=>run(async()=>{audioFile=null;await commit(await call('newWorkspace'));},{revisionBound:false,projectBound:false});
$('#projects').onchange=()=>{const id=$('#projects').value;run(async()=>{if(!projects.some(p=>p.id===id))throw Error(t('msg.projectMissing'));const selected=await loadProject(id);audioFile=null;await commit(selected);},{revisionBound:false,projectBound:false});};
$('#export-project').onclick=()=>{if(workspace)download('mml-studio-project.json',portableBackup(workspace,identity.metadata));};
$('#restore-project').onchange=()=>{const file=$('#restore-project').files[0];$('#restore-project').value='';if(file&&/\.zip$/i.test(file.name))return run(()=>restoreZip(file),{revisionBound:false,projectBound:false});if(file)run(async()=>{if(file.size>16*1048576)throw Error(`Project backup is ${(file.size/1048576).toFixed(1)} MiB; the restore limit is 16 MiB. Export the sources separately if a MIDI project exceeds it.`);audioFile=null;await commit(await call('importWorkspace',await file.text()));message(t('msg.imported'));},{revisionBound:false,projectBound:false});};
// ─── In-game probe kit ──────────────────────────────────────────────────────
// Fixed test strings for open engine questions and a place to record what the
// game actually did. Observations stay on this device (engine-probe-store.mjs),
// are exported explicitly, and change no Canonical rule by themselves.
const probeState = { loaded: false, observations: [], error: null };
function engineProbeCard() {
  const summary = summarize(probeState.observations);
  const probeBlock = probe => {
    const own = probeState.observations.filter(o => o.probeId === probe.id);
    const state = summary.find(s => s.probeId === probe.id);
    return `<div class="probe" data-probe="${esc(probe.id)}"><div class="row"><strong>${esc(probe.title)}</strong><span class="badge">PENDING ${esc(probe.pending)}</span></div>
      <p class="meta">${esc(probe.question)}</p>
      <label>${t('probe.string')}<textarea class="code" readonly spellcheck="false" data-probe-mml>${esc(probe.mml)}</textarea></label>
      <div class="actions"><button type="button" class="secondary" data-probe-copy="${esc(probe.id)}">${t('probe.copy')}</button></div>
      <p class="meta">${esc(probe.listen)}</p>
      <form data-probe-form="${esc(probe.id)}"><fieldset class="probe-outcomes"><legend>${t('probe.outcome')}</legend>${probe.outcomes.map(o => `<label><input type="radio" name="outcome" value="${esc(o.id)}" required> ${esc(o.label)}</label>`).join('')}</fieldset>
        <div class="field-grid">${input('client', t('probe.client'), '')}${input('version', t('probe.version'), '')}${input('instrument', t('probe.instrument'), '')}${input('notes', t('probe.notes'), '')}</div>
        <div class="actions"><button>${t('probe.record')}</button></div></form>
      ${own.length ? `<p class="meta">${state.consistent ? t('probe.recorded', { n: own.length }) : t('probe.recordedInconsistent', { n: own.length })}</p><ul class="probe-log">${own.map(o => `<li>${esc(o.outcomeLabel)} · ${esc(o.client)} ${esc(o.version)} · ${esc(o.instrument)} · ${esc(o.observedAt.slice(0, 10))} <button type="button" class="quiet" data-probe-delete="${o.id}">${t('common.delete')}</button></li>`).join('')}</ul>` : ''}</div>`;
  };
  return `<details class="card engine-probes" id="engine-probes"><summary>${t('probe.summary')}</summary>
    <p class="note">${t('probe.note')}</p>
    ${PROBES.map(probeBlock).join('<div class="divider"></div>')}
    <div class="actions"><button type="button" class="secondary" id="probe-export" ${probeState.observations.length ? '' : 'disabled'}>${t('probe.export')}</button></div>
    ${probeState.error ? `<p class="note">${esc(probeState.error)}</p>` : ''}</details>`;
}
function refreshProbes() {
  const card = $('#engine-probes');
  if (!card) return;
  const open = card.open;
  card.outerHTML = engineProbeCard();
  if (open) $('#engine-probes').open = true;
  bindEngineProbes();
}
async function loadProbeObservations() {
  probeState.loaded = true;
  try {
    const { listObservations } = await import('./engine-probe-store.mjs');
    probeState.observations = await listObservations();
  } catch (error) { probeState.error = t('probe.loadFailed', { error: error.message }); }
  refreshProbes();
}
function bindEngineProbes() {
  const card = $('#engine-probes');
  if (!card) return;
  if (!probeState.loaded) loadProbeObservations();
  card.querySelectorAll('[data-probe-copy]').forEach(button => button.onclick = () => {
    const probe = PROBES.find(p => p.id === button.dataset.probeCopy);
    copyText(probe.mml, button.closest('.probe').querySelector('[data-probe-mml]'));
  });
  card.querySelectorAll('[data-probe-form]').forEach(form => form.onsubmit = async event => {
    event.preventDefault();
    try {
      const probe = PROBES.find(p => p.id === form.dataset.probeForm);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(probe.mml));
      const mmlSha256 = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      const observation = buildObservation(probe, Object.fromEntries(new FormData(form)), { mmlSha256 });
      const { addObservation, listObservations } = await import('./engine-probe-store.mjs');
      await addObservation(observation);
      probeState.observations = await listObservations();
      probeState.error = null;
      message(t('probe.saved'));
    } catch (error) { probeState.error = error.message; }
    refreshProbes();
  });
  card.querySelectorAll('[data-probe-delete]').forEach(button => button.onclick = async () => {
    const { deleteObservation, listObservations } = await import('./engine-probe-store.mjs');
    await deleteObservation(Number(button.dataset.probeDelete));
    probeState.observations = await listObservations();
    refreshProbes();
  });
  const exporter = $('#probe-export');
  if (exporter) exporter.onclick = () => download('in-game-probe-observations.json', JSON.stringify({ kind: 'in-game-probe-observations', note: 'Class E in-game evidence for the stated client/version/instrument and exact test string. Changes no Canonical rule by itself.', exportedAt: new Date().toISOString(), observations: probeState.observations }, null, 2));
}
// ─── Timbre preview ─────────────────────────────────────────────────────────
// Plays the delivery MML through SpessaSynth with a sound bank the user picks
// or, without one, the free default bank, which is downloaded from its
// upstream only when a playback first needs it (studio/web/preview/). The
// engine and bank live across re-renders; the markup is re-bound after each
// render. Listening never touches a gate, a review or the workspace, and no
// bank ever leaves this browser. The one write is explicit: after a complete
// playback from the start, the user may record the engine's processed events
// as the Gate 6 player readback, which the Worker re-checks against the exact
// MML on every analysis.
// Without a bank of the user's own, the site's own banks: the free GM default
// or the game-style bank. The choice is this viewer's convenience, kept in
// this browser only.
const PRESET_BANK_KINDS = Object.freeze(['free', 'game-style']);
function presetBankInfo(kind) {
  return kind === 'game-style' ? { name: GAME_STYLE_BANK_NAME, label: GAME_STYLE_BANK_LABEL, option: t('preview.optionGameStyle') } : { name: DEFAULT_BANK_NAME, label: DEFAULT_BANK_LABEL, option: t('preview.optionFree') };
}
const PRESET_BANK_KEY = 'mml-studio-preset-bank';
function readPresetBank() {
  try { const kind = localStorage.getItem(PRESET_BANK_KEY); return PRESET_BANK_KINDS.includes(kind) ? kind : 'free'; } catch { return 'free'; }
}
const preview = { voices: 0, bank: undefined, bankChecked: false, bankPicks: 0, presetBank: readPresetBank(), defaultCached: undefined, gameStyleCached: undefined, download: null, context: null, engine: null, engineLoading: null, engineToken: 0, transport: null, songKey: null, choices: null, choicesKind: null, position: 0, muted: [false, false, false, false, false, false], busy: false, error: null, playBinding: null, lastCapture: null, owner: 'final', listenHandlers: null };
// Re-render only the preview card: a full render() would discard whatever the
// user is typing in another form.
function refreshPreview() { listening?.refreshAudio(); const card = $('#timbre-preview'); if (!card) return; card.outerHTML = timbrePreviewCard(); bindTimbrePreview(); }
const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
// The capture of the last complete playback, while it still describes the
// project, revision and exact string on screen.
function currentCapture() {
  const last = preview.lastCapture;
  if (!last || last.binding.workspaceId !== workspace?.id || last.binding.revision !== workspace?.revision || last.binding.exactMml !== report?.rawMml) return null;
  return last;
}
function readbackBlock() {
  const gate = report?.gates?.playerReadback;
  const stored = report?.playerReadback;
  const used = workspace?.settings?.preview === 'used';
  const last = currentCapture();
  const rows = [];
  if (stored) {
    const c = stored.comparison;
    rows.push(`<p class="meta">${t('readback.recordedAt', { time: esc(new Date(stored.recordedAt).toLocaleString()) })} · ${esc(stored.bank.name)} <code class="digest">sha256 ${esc(stored.bank.sha256.slice(0, 12))}…</code> · ${esc(String(stored.program.program + 1).padStart(3, '0'))} ${esc(stored.program.name)} · ${esc(stored.engine.lib)} / ${esc(stored.engine.core)}<br>${t('readback.stored', { processed: c.processedNotes, expected: c.expectedNotes, drift: c.maxDriftMs, tolerance: c.toleranceMs })}</p>`);
    if (!c.ok) rows.push(`<ul class="codes">${c.errors.map(error => `<li><code>${esc(error)}</code></li>`).join('')}</ul>`);
  }
  if (last) {
    const c = last.comparison;
    rows.push(`<p class="${c.ok ? 'meta' : 'note'}">${t('readback.last', { processed: c.processedNotes, expected: c.expectedNotes, drift: c.maxDriftMs })} · ${c.ok ? t('readback.matches') : t('readback.mismatch', { errors: esc(c.errors.join(' · ')) })}</p>`);
    if (last.capture.complete) rows.push(`<div class="actions"><button type="button" id="record-readback" ${used ? '' : 'disabled'}>${t('readback.record')}</button></div>`);
    else rows.push(`<p class="meta">${t('readback.incomplete')}</p>`);
  } else if (report?.rawMml) rows.push(`<p class="meta">${t('readback.howTo')}</p>`);
  if (!used) rows.push(`<p class="note">${t('readback.notUsed')}</p>`);
  if (workspace?.playerReadback) rows.push(`<div class="actions"><button type="button" id="clear-readback" class="quiet">${t('readback.clear')}</button></div>`);
  return `<div class="readback" id="player-readback"><div class="attempt-head"><h4>${t('readback.title')}</h4>${gate ? badge(gate.status) : ''}</div>
    ${gate?.reason ? `<p class="meta"><code>${esc(gate.reason)}</code></p>` : ''}${rows.join('')}
    <p class="meta">${t('readback.scope', { scope: esc('processed_engine_events_not_hardware_audio') })}</p></div>`;
}
function timbrePreviewCard() {
  const song = report?.technical?.ok ? report.technical.song : null;
  const ready = Boolean(report?.rawMml && song);
  const bank = preview.bank;
  // No bank of the user's own: the free default bank plays, always labelled.
  const site = presetBankInfo(preview.presetBank);
  const bankLine = bank === undefined ? t('preview.loadingBank') : bank ? `${esc(bank.name)} · ${bytesLabel(bank.size)} · <code class="digest">sha256 ${esc(bank.sha256.slice(0, 16))}…</code> · ${t('preview.ownBank')}` : `${esc(site.name)} · <strong>${esc(site.label)}</strong>`;
  const defaultNote = bank === null ? defaultBankNote() : '';
  const playable = ready && bank !== undefined;
  const { options: choices, all } = instrumentPicker();
  const select = (attrs, value, label) => `<select ${attrs} ${choices.length ? '' : 'disabled'}>${choices.length ? `${value === '' ? `<option value="" selected>${t('preview.mixed')}</option>` : ''}${choices.map(o => `<option value="${esc(o.value)}" ${o.value === value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}` : `<option>${label}</option>`}</select>`;
  return `<div class="card preview-card" id="timbre-preview"><div class="attempt-head"><h3>${t('preview.title')}</h3><span class="badge na">${t('preview.badge')}</span></div>
    <p class="note">${t('preview.note', { free: esc(DEFAULT_BANK_LABEL), gameStyle: esc(GAME_STYLE_BANK_LABEL) })}</p>
    <div class="preview-bank"><span class="meta" id="bank-status">${bankLine}</span><label class="file-button secondary">${bank ? t('preview.replaceBank') : t('preview.chooseBank')}<input type="file" id="bank-file" accept=".dls,.sf2,.sf3" aria-label="${esc(t('preview.bankAria'))}"></label>${bank ? `<button type="button" id="bank-clear" class="quiet">${t('preview.removeBank')}</button>` : ''}${bank === null ? presetBankSelect('id="preset-bank"') : ''}${preview.defaultCached ? `<button type="button" id="default-bank-clear" class="quiet">${t('preview.deleteFree')}</button>` : ''}${preview.gameStyleCached ? `<button type="button" id="game-style-bank-clear" class="quiet">${t('preview.deleteGameStyle')}</button>` : ''}</div>
    ${defaultNote ? `<p class="meta" id="default-bank-note" data-default-bank-note>${esc(defaultNote)}</p>` : ''}
    ${ready ? '' : `<p class="empty">${t('preview.notReady')}</p>`}
    <div class="preview-controls"><label>${t('preview.allRoles')}${select('id="preview-program"', all, t('preview.loadOnPlay'))}</label>${Object.keys(ROLE_GROUPS).map(group => `<label class="preview-group">${ROLE_GROUP_LABELS[group]}${select(`data-preview-group="${group}"`, groupChoice(preview.choices, group), t('preview.loadOnPlay'))}</label>`).join('')}
      <button type="button" id="preview-play" ${playable ? '' : 'disabled'}>${preview.busy ? t('preview.loading') : t('preview.play')}</button><button type="button" id="preview-stop" class="secondary" ${preview.transport?.playing ? '' : 'disabled'}>${t('preview.stop')}</button>
      <input type="range" id="preview-seek" min="0" max="1000" value="0" aria-label="${esc(t('preview.seekAria'))}" ${playable ? '' : 'disabled'}><span class="meta" id="preview-time">${clock(preview.owner === 'final' ? preview.position : 0)} / ${clock(preview.owner === 'final' ? preview.transport?.duration ?? 0 : 0)}</span></div>
    <div class="preview-roles" role="group" aria-label="${esc(t('preview.rolesAria'))}">${roles.map((role, i) => `<label><input type="checkbox" data-preview-role="${i}" ${preview.muted[i] ? '' : 'checked'}> ${role}</label>`).join('')}</div>
    <details class="preview-instruments"><summary>${t('preview.perRole')}${bank === null ? `（${esc(site.label)}）` : ''}</summary><div class="preview-instrument-grid">${roles.map((role, i) => `<label>${role}${select(`data-preview-instrument="${i}"`, preview.choices?.[i] ?? '', t('preview.loadOnPlay'))}</label>`).join('')}</div><p class="meta">${t('preview.perRoleNote', { drums: bank === null && preview.presetBank === 'game-style' ? t('preview.drumsGameStyle') : t('preview.drumsGm') })}</p></details>
    ${preview.error ? `<p class="note">${esc(preview.error)}</p>` : ''}
    ${ready ? readbackBlock() : ''}</div>`;
}
// The engine and its one transport are shared by the Final preview (this card)
// and listening sessions (listen-ui.mjs). `preview.owner` says whose playback
// the transport is running, so position and end reports reach that player
// only; a player that takes the transport tells the other one it stopped,
// and why (`reason` 'bank' when a bank change stops it).
function previewTimeText() { const el = $('#preview-time'); if (el) el.textContent = `${clock(preview.owner === 'final' ? preview.position : 0)} / ${clock(preview.owner === 'final' ? preview.transport?.duration ?? 0 : 0)}${preview.owner === 'final' && preview.transport?.playing ? ` · ${t('preview.voices', { n: preview.voices })}` : ''}`; }
function previewSeekSync() { const el = $('#preview-seek'); if (el && preview.transport?.duration) el.value = String(Math.round((preview.position / preview.transport.duration) * 1000)); }
function claimTransport(owner, handlers = null, reason = null) {
  if (preview.owner === 'listen' && (owner !== 'listen' || handlers !== preview.listenHandlers)) preview.listenHandlers?.onPreempt?.(reason);
  preview.owner = owner;
  preview.listenHandlers = owner === 'listen' ? handlers : null;
}
// Created and resumed before the first await: iOS Safari only unlocks audio
// inside the user's gesture.
function startAudioContext() {
  if (!preview.context) {
    const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AudioContextClass) throw Error(t('preview.noWebAudio'));
    preview.context = new AudioContextClass({ latencyHint: 'interactive' });
  }
  preview.context.resume?.();
}
// Both players may ask at once (a first download takes a while), so one
// load is shared; a bank change while it runs discards its result.
function ensurePreviewEngine() {
  if (preview.transport) return Promise.resolve();
  if (!preview.engineLoading) {
    const loading = buildPreviewEngine(preview.engineToken).finally(() => { if (preview.engineLoading === loading) preview.engineLoading = null; });
    preview.engineLoading = loading;
  }
  return preview.engineLoading;
}
async function buildPreviewEngine(token) {
  const { loadBank, describe } = await import('./preview/soundbank-store.mjs');
  const { createPreviewEngine, createTransport } = await import('./preview/player.mjs');
  // The user's own bank takes precedence; without one, the site bank chosen.
  const bank = await loadBank() ?? (preview.presetBank === 'game-style' ? await loadGameStylePreviewBank() : await loadDefaultPreviewBank());
  if (token !== preview.engineToken) throw Error(t('preview.bankChanged'));
  // The page names the bank the engine is built from. The page read the
  // store once, and another tab (the Workshop) may have picked a bank since.
  preview.bank = bank.isDefault ? null : describe(bank);
  let engine;
  try { engine = await createPreviewEngine(bank, preview.context); }
  catch (error) {
    // After a bank change the context may already be a newer build's.
    if (token === preview.engineToken) { preview.engine = null; preview.context = null; }
    throw error;
  }
  // The bank changed while the engine was built: it holds the old bank, so
  // it is closed, not installed.
  if (token !== preview.engineToken) { engine.context.close?.(); throw Error(t('preview.bankChanged')); }
  preview.engine = engine; preview.engine.isDefault = Boolean(bank.isDefault); preview.engine.preset = bank.isDefault ? bank.preset ?? 'free' : null;
  preview.transport = createTransport(preview.engine, {
    onPosition: (position, duration, voices = 0) => {
      if (preview.owner === 'listen') return preview.listenHandlers?.onPosition?.(position, duration, voices);
      preview.position = position; preview.voices = voices; previewTimeText(); previewSeekSync();
    },
    onEnd: (capture, info) => {
      if (preview.owner === 'listen') return preview.listenHandlers?.onEnd?.(capture, info);
      preview.position = 0;
      const binding = preview.playBinding;
      preview.playBinding = null;
      if (capture && binding) {
        try { preview.lastCapture = { binding, capture, comparison: compareReadback(report.technical.song, normalizeCapture(capture)) }; }
        catch (error) { preview.lastCapture = null; preview.error = t('readback.unusable', { error: error.message }); }
      }
      refreshPreview();
    },
  });
  ensureChoices();
  preview.transport.setVoices(resolveRoleVoices(preview.choices, voiceOptions()));
  preview.muted.forEach((value, role) => preview.transport.setMuted(role, value));
  preview.songKey = null;
}
// The default bank from this browser's cache or, the first time, from its
// upstream (default-bank.mjs), with the download's progress on both players.
async function loadDefaultPreviewBank() {
  try {
    const bank = await loadDefaultBank({
      onProgress: progress => {
        const phaseChanged = preview.download?.phase !== progress.phase;
        preview.download = progress.phase === 'done' ? null : progress;
        if (phaseChanged) refreshPreview(); else showDefaultBankNote();
      },
    });
    preview.defaultCached = bank.stored !== false;
    if (bank.downloaded) message(bank.stored === false ? t('bank.freeNotStored') : t('bank.freeStored'));
    return bank;
  } finally {
    preview.download = null;
    refreshPreview();
  }
}
// The game-style bank from this browser's store or, the first time, from
// this site (game-style-bank.mjs), with the same progress reports.
async function loadGameStylePreviewBank() {
  try {
    const bank = await loadGameStyleBank({
      onProgress: progress => {
        const phaseChanged = preview.download?.phase !== progress.phase;
        preview.download = progress.phase === 'done' ? null : progress;
        if (phaseChanged) refreshPreview(); else showDefaultBankNote();
      },
    });
    preview.gameStyleCached = bank.stored !== false;
    if (bank.downloaded) message(bank.stored === false ? t('bank.gameStyleNotStored') : t('bank.gameStyleStored'));
    return bank;
  } finally {
    preview.download = null;
    refreshPreview();
  }
}
function defaultBankNote() {
  const download = preview.download;
  if (preview.presetBank === 'game-style') {
    const mb = bytes => (bytes / 1e6).toFixed(1);
    if (download?.phase === 'download') return t('bank.downloading', { notice: GAME_STYLE_DOWNLOAD_NOTICE, percent: Math.floor((download.received / download.total) * 100), received: mb(download.received), total: mb(download.total) });
    if (preview.gameStyleCached) return t('bank.gameStyleCached');
    if (preview.gameStyleCached === false) return t('bank.downloadOnPlay', { notice: GAME_STYLE_DOWNLOAD_NOTICE });
    return '';
  }
  if (download?.phase === 'download') {
    const mb = bytes => (bytes / 1e6).toFixed(1);
    return t('bank.downloading', { notice: DEFAULT_BANK_DOWNLOAD_NOTICE, percent: Math.floor((download.received / download.total) * 100), received: mb(download.received), total: mb(download.total) });
  }
  if (download?.phase === 'trim') return t('bank.trimming');
  if (preview.defaultCached) return t('bank.freeCached');
  if (preview.defaultCached === false) return t('bank.downloadOnPlay', { notice: DEFAULT_BANK_DOWNLOAD_NOTICE });
  return '';
}
// Progress only rewrites the note text, so a download does not re-render the
// cards (and close what the user has open) on every chunk.
function showDefaultBankNote() {
  const note = defaultBankNote();
  for (const element of document.querySelectorAll('[data-default-bank-note]')) if (element.textContent !== note) element.textContent = note;
}
async function clearGameStylePreviewBank() {
  const { clearPresetBanks } = await import('./preview/soundbank-store.mjs');
  if (preview.engine?.preset === 'game-style' || preview.engineLoading) resetPreviewEngine();
  await clearPresetBanks();
  preview.gameStyleCached = false;
  message(t('bank.gameStyleDeleted'));
  refreshPreview();
}
function presetBankSelect(attrs) {
  return `<label class="preset-bank">${t('preview.presetBank')} <select ${attrs} aria-label="${esc(t('preview.presetBank'))}">${PRESET_BANK_KINDS.map(kind => `<option value="${kind}" ${kind === preview.presetBank ? 'selected' : ''}>${esc(presetBankInfo(kind).option)}</option>`).join('')}</select></label>`;
}
// Choosing the other site bank rebuilds the engine at the next playback, as a
// bank change does; the instrument choices (game instrument ids) stay.
function setPresetBank(kind) {
  if (!PRESET_BANK_KINDS.includes(kind) || kind === preview.presetBank) return;
  preview.presetBank = kind;
  try { localStorage.setItem(PRESET_BANK_KEY, kind); } catch { /* kept for this page only */ }
  if (preview.engine?.isDefault || preview.engineLoading) resetPreviewEngine();
  preview.error = null;
  refreshPreview();
}
const voiceOptions = () => ({ gameStyle: preview.engine?.preset === 'game-style' });
async function clearDefaultPreviewBank() {
  const { clearDefaultSubsets } = await import('./preview/soundbank-store.mjs');
  if (preview.engine?.preset === 'free' || preview.engineLoading) resetPreviewEngine();
  await clearDefaultSubsets();
  preview.defaultCached = false;
  message(t('bank.freeDeleted'));
  refreshPreview();
}
// Instrument choices, one per role, shared by both players: a game instrument
// id with the default bank, `p:<program>` with the user's own bank (whose
// presets are known once its engine has loaded).
function ensureChoices() {
  const kind = preview.bank === null || preview.engine?.isDefault ? 'default' : preview.engine ? 'user' : null;
  if (!kind || preview.choicesKind === kind) return;
  if (kind === 'default') preview.choices = Array(6).fill(DEFAULT_INSTRUMENT);
  else {
    const presets = preview.engine.presets;
    const first = presets.find(p => /lute/i.test(p.name)) ?? presets.find(p => !p.drums) ?? presets[0];
    preview.choices = Array(6).fill(`p:${first.program}`);
  }
  preview.choicesKind = kind;
}
function instrumentPicker() {
  ensureChoices();
  const defaultBank = preview.choicesKind === 'default' && (preview.bank === null || preview.engine?.isDefault);
  const options = defaultBank ? instrumentOptions({ defaultBank: true }) : preview.engine && !preview.engine.isDefault ? instrumentOptions({ defaultBank: false, presets: preview.engine.presets }) : [];
  const values = preview.choices ?? [];
  return { options, all: values.length && values.every(value => value === values[0]) ? values[0] : '', defaultBank };
}
function setInstrument(role, value) {
  ensureChoices();
  if (!preview.choices) return;
  // A role, every role (null) or a group of roles (ROLE_GROUPS).
  if (role === null) preview.choices = Array(6).fill(value);
  else for (const index of Array.isArray(role) ? role : [role]) preview.choices[index] = value;
  preview.transport?.setVoices(resolveRoleVoices(preview.choices, voiceOptions()));
  refreshPreview();
}
// The listening sessions' view of the shared engine (listen-ui.mjs).
const listenAudio = {
  status: () => ({ bank: preview.bank, busy: preview.busy, fallback: preview.bank === null ? `${presetBankInfo(preview.presetBank).name} · ${presetBankInfo(preview.presetBank).label}` : null, fallbackNote: preview.bank === null ? defaultBankNote() : '', defaultCached: Boolean(preview.defaultCached), gameStyleCached: Boolean(preview.gameStyleCached), presetBank: preview.presetBank }),
  presetBankSelect: attrs => presetBankSelect(attrs),
  setPresetBank: kind => setPresetBank(kind),
  instruments: () => { const picker = instrumentPicker(); return { options: picker.options, choices: [...(preview.choices ?? [])], defaultBank: picker.defaultBank, uniform: uniformProgram(resolveRoleVoices(preview.choices, voiceOptions())) !== null }; },
  setInstrument,
  async play({ key, song, from, until, muted, handlers }) {
    startAudioContext();
    claimTransport('listen', handlers);
    await ensurePreviewEngine();
    if (preview.owner !== 'listen' || preview.listenHandlers !== handlers) return;
    if (preview.songKey !== key) { preview.transport.load(song); preview.songKey = key; }
    muted.forEach((value, role) => preview.transport.setMuted(role, value));
    await preview.transport.play(from, { until });
    refreshPreview();
  },
  stop() { if (preview.owner === 'listen') { preview.listenHandlers = null; preview.transport?.stop(); refreshPreview(); } },
  setMuted(role, value) { if (preview.owner === 'listen') preview.transport?.setMuted(role, value); },
  state: () => (preview.owner === 'listen' ? preview.transport?.state ?? null : null),
  async pickBank(file) {
    // The last choice wins. Picks can overlap, since each is checked off the
    // main thread and a big bank takes longer than a small one, and removing
    // the bank is a choice too. A pick overtaken before it is written is not
    // kept, and whatever became of it (refused or superseded) says nothing.
    const pick = ++preview.bankPicks;
    const current = () => pick === preview.bankPicks;
    const { storeBank } = await import('./preview/soundbank-store.mjs');
    // Checked (parsed off the main thread) and kept before the engine is
    // reset, so a refused bank leaves the engine and the kept bank as they were.
    let stored;
    try { stored = await storeBank(file, { current }); }
    catch (error) { if (current()) throw error; return; }
    // Written. A newer choice made while the write was under way could not
    // stop it; its own result follows (IndexedDB runs its write or delete
    // after this one), so until then the page names this bank, the one the
    // store keeps, without announcing it.
    resetPreviewEngine();
    preview.bank = stored;
    preview.error = null;
    if (current()) message(t('bank.loaded', { name: file.name }));
    refreshPreview();
  },
  clearDefaultBank: () => clearDefaultPreviewBank(),
  clearGameStyleBank: () => clearGameStylePreviewBank(),
};
function bindTimbrePreview() {
  const card = $('#timbre-preview');
  if (!card) return;
  if (!preview.bankChecked) loadStoredBankInfo();
  const song = report?.technical?.ok ? report.technical.song : null;
  const songKey = song ? report.rawMml : null;
  // A listening session that is playing keeps the transport; this card loads
  // its own song again when it next plays.
  if (preview.transport && songKey !== preview.songKey && !(preview.owner === 'listen' && preview.transport.playing)) {
    claimTransport('final');
    preview.transport.load(song);
    preview.songKey = songKey;
    preview.position = 0;
    previewTimeText();
  }
  const fail = error => { preview.error = error.message; preview.busy = false; message(error.message, true); refreshPreview(); };
  $('#preview-play').onclick = async () => {
    if (!song) return;
    try {
      startAudioContext();
      claimTransport('final');
      preview.busy = true; preview.error = null; refreshPreview();
      await ensurePreviewEngine();
      if (preview.songKey !== songKey) { preview.transport.load(song); preview.songKey = songKey; preview.position = 0; }
      // A listening session may have left its own mutes on the shared transport.
      preview.muted.forEach((value, role) => preview.transport.setMuted(role, value));
      preview.busy = false;
      preview.playBinding = preview.position === 0 ? { workspaceId: workspace.id, revision: workspace.revision, exactMml: songKey } : null;
      await preview.transport.play(preview.position);
      refreshPreview();
    } catch (error) { fail(error); }
  };
  $('#preview-stop').onclick = () => { claimTransport('final'); preview.transport?.stop(); preview.position = 0; preview.playBinding = null; refreshPreview(); };
  const record = $('#record-readback');
  if (record) record.onclick = () => {
    const last = currentCapture();
    if (!last) return message(t('readback.stale'), true);
    run(async () => {
      await commit(await call('recordPlayerReadback', workspace, last.capture, last.binding));
      preview.lastCapture = null;
      refreshPreview();
      message(report.gates.playerReadback?.status === 'PASS' ? t('readback.recordedPass') : t('readback.recordedPending', { reason: report.gates.playerReadback?.reason ?? '' }));
    });
  };
  const clearReadback = $('#clear-readback');
  if (clearReadback) clearReadback.onclick = () => run(async () => { await commit(await call('clearPlayerReadback', workspace)); message(t('readback.cleared')); });
  $('#preview-seek').onchange = event => {
    const duration = preview.owner === 'final' ? preview.transport?.duration ?? 0 : 0;
    preview.position = (Number(event.target.value) / 1000) * duration;
    previewTimeText();
    if (preview.owner === 'final' && preview.transport?.playing) preview.transport.play(preview.position).catch(fail);
  };
  $('#preview-program').onchange = event => { if (event.target.value) setInstrument(null, event.target.value); };
  card.querySelectorAll('[data-preview-group]').forEach(select => select.onchange = () => { if (select.value) setInstrument(ROLE_GROUPS[select.dataset.previewGroup], select.value); });
  card.querySelectorAll('[data-preview-instrument]').forEach(select => select.onchange = () => setInstrument(Number(select.dataset.previewInstrument), select.value));
  card.querySelectorAll('[data-preview-role]').forEach(box => box.onchange = () => {
    const role = Number(box.dataset.previewRole);
    preview.muted[role] = !box.checked;
    if (preview.owner === 'final') preview.transport?.setMuted(role, preview.muted[role]);
  });
  $('#bank-file').onchange = event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    listenAudio.pickBank(file).catch(fail);
  };
  const clear = $('#bank-clear');
  if (clear) clear.onclick = async () => {
    // A newer choice than any pick still being checked (pickBank).
    preview.bankPicks += 1;
    const { clearBank } = await import('./preview/soundbank-store.mjs');
    resetPreviewEngine();
    await clearBank().catch(error => message(error.message, true));
    preview.bank = null;
    refreshPreview();
  };
  const clearDefault = $('#default-bank-clear');
  if (clearDefault) clearDefault.onclick = () => clearDefaultPreviewBank().catch(error => message(error.message, true));
  const clearGameStyle = $('#game-style-bank-clear');
  if (clearGameStyle) clearGameStyle.onclick = () => clearGameStylePreviewBank().catch(error => message(error.message, true));
  const presetBank = $('#preset-bank');
  if (presetBank) presetBank.onchange = () => setPresetBank(presetBank.value);
}
function resetPreviewEngine() {
  claimTransport('final', null, 'bank');
  preview.transport?.destroy();
  preview.transport = null; preview.engine = null; preview.context = null; preview.songKey = null; preview.position = 0;
  preview.engineLoading = null; preview.engineToken += 1;
}
// Reads only what is stored; nothing is downloaded until a playback needs it.
async function loadStoredBankInfo() {
  preview.bankChecked = true;
  try {
    const { loadBank, describe, hasDefaultSubset, hasPresetBank } = await import('./preview/soundbank-store.mjs');
    const stored = await loadBank();
    // A pick, a removal or an engine build that landed meanwhile has named a
    // newer bank than this read.
    if (preview.bank === undefined) preview.bank = stored ? describe(stored) : null;
    preview.defaultCached = await hasDefaultSubset(DEFAULT_BANK_SUBSET.sha256).catch(() => false);
    preview.gameStyleCached = await hasPresetBank(GAME_STYLE_BANK.sha256).catch(() => false);
  } catch (error) { if (preview.bank === undefined) preview.bank = null; preview.error = t('bank.readFailed', { error: error.message }); }
  refreshPreview();
}
// ─── Six-role review roll ───────────────────────────────────────────────────
// A read-only view (review-roll.mjs). It locates events and review signals and
// never edits, accepts or reviews anything. Selecting an event describes it,
// links to the existing forms, and can add it to the Decision Composer's
// selection. Three projections can be shown, always labelled: the analysed
// candidate (default), the verified G11-D head, and the composer's dry run.
const ROLL_LANES = () => [...roles, t('roll.unassigned')];
const ROLL_VIEW_NAMES = ['source', 'accepted', 'preview'];
const rollViewLabel = view => t(`roll.view.${view}`);
const composerPreviewCurrent = () => Boolean(composer.preview && composer.preview.projectId === workspace?.id && composer.preview.revision === workspace?.revision);
function rollFor(view) {
  if (view === 'accepted' && report?.acceptedRoll) return report.acceptedRoll;
  if (view === 'preview' && composerPreviewCurrent() && composer.preview.roll) return composer.preview.roll;
  return null;
}
function activeRoll() {
  const roll = rollFor(composer.view);
  if (!roll) composer.view = 'source';
  return roll ?? report?.roll;
}
function reviewRollCard() { return rollCard() + decisionComposerCard(); }
function rollCard() {
  const roll = activeRoll();
  if (!roll) return `<div class="card roll-card"><h3>${t('roll.title')}</h3><div class="empty">${t('roll.empty')}</div></div>`;
  const counts = [...roll.lanes.map(l => l.events.length), roll.unassigned.length];
  const kinds = { harmony: 0, overlap: 0, crowding: 0 };
  for (const signal of roll.signals) kinds[signal.kind] += 1;
  const unresolved = roll.signals.filter(signal => signal.kind === 'harmony' && !signal.resolved).length;
  const views = ROLL_VIEW_NAMES.filter(view => view === 'source' || rollFor(view));
  return `<div class="card roll-card"><div class="row"><h3>${t('roll.title')}</h3><span class="meta roll-counts">${t('roll.counts', { harmony: kinds.harmony, open: unresolved ? t('roll.open', { n: unresolved }) : '', overlap: kinds.overlap, crowding: kinds.crowding })}</span></div>
    <p class="note">${t('roll.note')}</p>
    ${views.length > 1 ? `<div class="roll-views" role="group" aria-label="${esc(t('roll.viewsAria'))}">${views.map(view => `<button type="button" class="${view === composer.view ? 'secondary' : 'quiet'}" data-roll-view="${view}" aria-pressed="${view === composer.view}">${rollViewLabel(view)}</button>`).join('')}</div>` : ''}
    ${composer.view === 'accepted' ? `<p class="meta">${t('roll.acceptedNote')}</p>` : composer.view === 'preview' ? `<p class="note">${t('roll.previewNote')}</p>` : ''}
    <div class="roll-toolbar" role="group" aria-label="${esc(t('roll.toolbarAria'))}">
      <span class="roll-zoom"><span class="meta">${t('roll.time')}</span><button type="button" class="quiet" data-roll-zoom="w:-1" aria-label="${esc(t('roll.timeOut'))}">−</button><button type="button" class="quiet" data-roll-zoom="w:1" aria-label="${esc(t('roll.timeIn'))}">＋</button></span>
      <span class="roll-zoom"><span class="meta">${t('roll.pitch')}</span><button type="button" class="quiet" data-roll-zoom="h:-1" aria-label="${esc(t('roll.pitchOut'))}">−</button><button type="button" class="quiet" data-roll-zoom="h:1" aria-label="${esc(t('roll.pitchIn'))}">＋</button></span>
      <span class="roll-lanes">${ROLL_LANES().map((name, i) => `<label class="roll-lane lane-${i}"><input type="checkbox" data-roll-lane="${i}" checked><i aria-hidden="true"></i>${esc(name)} <small>${counts[i]}</small></label>`).join('')}</span>
    </div>
    <div id="review-roll" class="roll-root"></div>
    <p id="roll-info" class="meta roll-info" aria-live="polite">${t('roll.info')}</p></div>`;
}
let reviewRoll = null;
function bindReviewRoll() { bindRoll(); bindDecisionComposer(); }
function bindRoll() {
  reviewRoll?.destroy?.();
  reviewRoll = null;
  const root = $('#review-roll');
  const roll = activeRoll();
  if (!root || !roll) return;
  const info = $('#roll-info');
  // Only a cross-source harmony conflict has an arbitration form. Overlap and
  // crowding signals come from the Full6 15-pair review and are described, not
  // linked: they are reviewed in the Full6 review record, not decided here.
  const signalButton = signal => signal.kind === 'harmony'
    ? `<button type="button" class="quiet" data-open-harmony="${signal.form}">${t('roll.openHarmony', { label: esc(signal.label) })}${signal.resolved ? t('roll.recorded') : ''}</button>`
    : `<span class="roll-signal-note">${t('roll.full6Signal', { label: esc(signal.label) })}</span>`;
  const wire = () => info.querySelectorAll('[data-open-harmony]').forEach(button => button.onclick = () => {
    const form = document.querySelector(`form[data-harmony="${button.dataset.openHarmony}"]`);
    if (!form) return;
    form.scrollIntoView({ block: 'center' });
    form.querySelector('select, input, button')?.focus({ preventScroll: true });
  });
  const pick = event => {
    const button = info.querySelector('[data-compose-toggle]');
    if (!button) return;
    button.onclick = () => {
      const at = composer.eventIds.indexOf(event.id);
      if (at >= 0) composer.eventIds.splice(at, 1); else composer.eventIds.push(event.id);
      composerEdited();
      button.textContent = at >= 0 ? t('roll.addToSelection') : t('roll.removeFromSelection');
    };
  };
  reviewRoll = mountReviewRoll(root, roll, {
    marked: composer.eventIds,
    onSelect: event => {
      if (!event) { info.textContent = t('roll.noSelection'); return; }
      const composable = composerEntry() && !event.id.includes('#g11d-dup:');
      info.innerHTML = `<strong>${esc(event.role ?? t('roll.unassigned'))}</strong> · ${esc(event.pitchName)}（pitch ${event.pitch}）· ${t('roll.beats')} <code>${esc(event.start)}</code>–<code>${esc(event.end)}</code><br><code class="digest">${esc(event.id)}</code>${event.signals.length ? `<br>${event.signals.map(signalButton).join(' ')}` : ''}${composable ? `<br><button type="button" class="quiet" data-compose-toggle>${composer.eventIds.includes(event.id) ? t('roll.removeFromSelection') : t('roll.addToSelection')}</button>` : ''}`;
      wire();
      if (composable) pick(event);
    },
    onSignal: signal => { info.innerHTML = `${t('roll.signal')} · ${t('roll.beats')} <code>${esc(signal.start)}</code>–<code>${esc(signal.end)}</code><br>${signalButton(signal)}`; wire(); },
  });
  document.querySelectorAll('[data-roll-zoom]').forEach(button => button.onclick = () => { const [axis, dir] = button.dataset.rollZoom.split(':'); reviewRoll?.zoom(axis, Number(dir)); });
  document.querySelectorAll('[data-roll-lane]').forEach(box => {
    box.checked = reviewRoll.prefs.visible[Number(box.dataset.rollLane)];
    box.onchange = () => reviewRoll?.setLaneVisible(Number(box.dataset.rollLane), box.checked);
  });
  document.querySelectorAll('.roll-card [data-roll-view]').forEach(button => button.onclick = () => { composer.view = button.dataset.rollView; refreshRoll(); });
}
// Re-render the roll card only; a full render() would discard what the user
// is typing in other forms, the composer included.
function refreshRoll() {
  const card = document.querySelector('.roll-card');
  if (!card) return;
  card.outerHTML = rollCard();
  bindRoll();
}

// ─── G11-D Decision Composer ────────────────────────────────────────────────
// Composes one accepted arrangement decision from events gathered on the roll.
// The page sends only the move (type, events, roles, reason, evidence): the
// Worker fills the acceptance bindings from what is loaded, previews without
// writing, and records only the exact record that was previewed. Shown only
// for a verified Raw MIDI candidate with no reduction or adaptation applied.
const DECISION_TYPE_NAMES = ['ASSIGN_ROLE', 'MOVE_ROLE', 'OMIT_FROM_SIX', 'DUPLICATE_WITH_JUSTIFICATION', 'KEEP'];
const decisionTypeLabel = type => (DECISION_TYPE_NAMES.includes(type) ? t(`decision.type.${type}`) : type);
function composerEntry() {
  const entry = report?.rawMidi?.find(item => item.slot === 'candidate');
  if (!entry || !entry.integrity?.verified || !entry.arrangement || entry.error) return null;
  if (workspace?.finalReduction || workspace?.mobileAdaptation) return null;
  return entry;
}
// Any edit drops the dry run. `structural` edits (selection, decision type)
// redraw the form; typing only removes the stale preview, so focus stays put.
function composerEdited({ structural = true } = {}) {
  const hadPreview = composer.preview !== null;
  composer.preview = null; composer.previewDraft = null;
  reviewRoll?.setMarked(composer.eventIds);
  if (hadPreview && composer.view === 'preview') { composer.view = 'source'; refreshRoll(); }
  if (structural) refreshComposer();
  else document.querySelector('#decision-composer .composer-preview')?.remove();
}
function refreshComposer() {
  const card = $('#decision-composer');
  if (!card) return;
  card.outerHTML = decisionComposerCard();
  bindDecisionComposer();
}
function decisionComposerCard() {
  const entry = composerEntry();
  if (!entry) return '';
  const chain = entry.acceptedArrangement;
  const records = workspace.acceptedDecisions ?? [];
  const recorded = records.length ? `<ul class="codes">${records.map(record => { const d = record.decision; return `<li><code>${esc(d.id)}</code> · ${esc(decisionTypeLabel(d.type))} · ${t('decision.events', { n: d.target?.eventIds?.length ?? 0 })}${d.fromRole ? ` · ${esc(d.fromRole)}` : ''}${d.toRole ? ` → ${esc(d.toRole)}` : ''}${d.toRoles?.length ? ` → ${esc(d.toRoles.join('、'))}` : ''} · ${esc(d.reason)}</li>`; }).join('')}</ul>` : `<p class="meta">${t('decision.none')}</p>`;
  const head = `<div class="attempt-head"><h3>${t('decision.title')}</h3>${badge(chain?.status === 'NOT_REQUESTED' ? 'PENDING' : chain?.status ?? 'PENDING')}</div>
    <p class="meta">${t('decision.intro')}</p>${recorded}
    ${records.length ? `<div class="actions"><button type="button" id="clear-decisions" class="quiet">${t('decision.clearAll')}</button></div>` : ''}`;
  if (chain && !['NOT_REQUESTED', 'PASS'].includes(chain.status)) return `<div class="card composer-card" id="decision-composer">${head}<p class="note">${t('decision.chainBroken', { status: esc(chain.status) })}</p></div>`;
  const d = composer.draft;
  const lanes = entry.arrangement.candidate?.lanes ?? [];
  const current = composerPreviewCurrent() ? composer.preview : null;
  const result = current ? `<div class="composer-preview"><div class="attempt-head"><h4>${t('decision.previewResult')}</h4>${badge(current.status)}</div>
      ${current.applied.length ? `<p class="meta">${current.applied.map(item => `${t('decision.eventsColon', { n: item.events.length })}${[...new Set(item.events.map(e => `${e.fromRole ?? t('roll.unassigned')} → ${e.toRole ?? t('decision.omitted')}`))].map(esc).join(t('list.item'))}`).join(t('list.clause'))}</p>` : ''}
      ${current.diffFromBaseline ? `<p class="meta">${t('decision.diff', { moved: current.diffFromBaseline.roleMoved ?? 0, added: current.diffFromBaseline.noteAdded ?? 0, removed: current.diffFromBaseline.noteRemoved ?? 0 })}${current.omitted ? ` · ${t('decision.omittedCount', { n: current.omitted })}` : ''}</p>` : ''}
      ${[...current.rejected, ...current.conflicts, ...current.diagnostics].length ? `<ul class="codes">${[...current.rejected, ...current.conflicts, ...current.diagnostics].map(item => `<li><code>${esc(item.code ?? item.kind ?? 'NOTE')}</code>${item.message ? ` · ${esc(item.message)}` : ''}${item.eventId ? ` · ${esc(item.eventId)}` : ''}</li>`).join('')}</ul>` : ''}
      <p class="meta">${t('decision.id')} <code>${esc(current.decision.id)}</code> · ${t('decision.reviewedAgainst')} ${esc(current.reviewedRevisionId ?? 'Source-Faithful Baseline')} · record <code class="digest">${esc(String(current.recordDigest).slice(0, 16))}…</code></p>
      <div class="actions"><button type="button" id="accept-decision" ${current.status === 'PASS' ? '' : 'disabled'}>${t('decision.accept')}</button>${current.roll ? `<button type="button" class="quiet" data-roll-view="preview">${t('decision.showOnRoll')}</button>` : ''}</div></div>` : '';
  return `<div class="card composer-card" id="decision-composer">${head}
    <div class="divider"></div>
    <p><strong>${t('decision.selected', { n: composer.eventIds.length })}</strong>${composer.eventIds.length ? ` <button type="button" class="quiet" id="compose-clear-selection">${t('decision.clearSelection')}</button>` : ''}</p>
    ${lanes.length ? `<label>${t('decision.addLane')}<select id="compose-lane"><option value="">${t('decision.chooseLane')}</option>${lanes.map(lane => `<option value="${esc(lane.id)}">${esc(lane.id)} · ${t('decision.laneSuggestion', { role: esc(lane.candidateRole ?? t('decision.undecided')), n: lane.eventIds?.length ?? 0 })}</option>`).join('')}</select></label>` : ''}
    <form id="compose-form"><div class="field-grid">
      <label>${t('harmony.decision')}<select name="type">${options(DECISION_TYPE_NAMES.map(type => [type, decisionTypeLabel(type)]), d.type)}</select></label>
      ${d.type === 'ASSIGN_ROLE' || d.type === 'MOVE_ROLE' ? `<label>${t('common.targetRole')}<select name="toRole">${options(roles.map(role => [role, role]), d.toRole)}</select></label>` : ''}
      ${d.type === 'DUPLICATE_WITH_JUSTIFICATION' ? `<fieldset class="compose-roles"><legend>${t('decision.duplicateTo')}</legend>${roles.map(role => `<label><input type="checkbox" name="toRoles" value="${role}" ${d.toRoles.includes(role) ? 'checked' : ''}> ${role}</label>`).join('')}</fieldset>` : ''}
      <label class="wide">${t('decision.reason')}<textarea name="reason" required>${esc(d.reason)}</textarea></label>
      <label>${d.type === 'DUPLICATE_WITH_JUSTIFICATION' ? t('decision.evidenceRequired') : t('decision.evidence')}<textarea name="evidence">${esc(d.evidence)}</textarea></label>
      <label>${t('decision.note')}<input name="note" value="${esc(d.note)}"></label>
    </div><div class="actions"><button type="submit" ${composer.eventIds.length ? '' : 'disabled'}>${t('decision.preview')}</button></div></form>
    ${result}</div>`;
}
function composeDraft() {
  const d = composer.draft;
  const draft = { type: d.type, eventIds: [...composer.eventIds], reason: d.reason, evidence: d.evidence };
  if (d.type === 'ASSIGN_ROLE' || d.type === 'MOVE_ROLE') draft.toRole = d.toRole;
  if (d.type === 'DUPLICATE_WITH_JUSTIFICATION') draft.toRoles = [...d.toRoles];
  if (d.note.trim()) draft.note = d.note;
  return draft;
}
function bindDecisionComposer() {
  const card = $('#decision-composer');
  if (!card) return;
  const form = $('#compose-form');
  if (form) {
    form.oninput = form.onchange = event => {
      const d = composer.draft;
      const typeChanged = event.target.name === 'type' && event.target.value !== d.type;
      d.type = form.elements.type.value;
      if (form.elements.toRole) d.toRole = form.elements.toRole.value;
      d.toRoles = [...form.querySelectorAll('[name="toRoles"]:checked')].map(box => box.value);
      d.reason = form.elements.reason.value; d.evidence = form.elements.evidence.value; d.note = form.elements.note.value;
      if (typeChanged) composerEdited();
      else if (composer.preview) composerEdited({ structural: false });
    };
    form.onsubmit = event => {
      event.preventDefault();
      const draft = composeDraft();
      run(async () => {
        const preview = await call('previewAcceptedDecision', workspace, draft);
        composer.preview = preview; composer.previewDraft = draft;
        if (preview.roll) composer.view = 'preview';
        refreshRoll(); refreshComposer();
        message(preview.status === 'PASS' ? t('decision.previewed') : t('decision.previewFailed', { status: preview.status }), preview.status !== 'PASS');
      }, { revisionBound: true });
    };
  }
  const lane = $('#compose-lane');
  if (lane) lane.onchange = () => {
    const picked = composerEntry()?.arrangement.candidate?.lanes?.find(item => item.id === lane.value);
    if (!picked) return;
    for (const id of picked.eventIds ?? []) if (!composer.eventIds.includes(id)) composer.eventIds.push(id);
    composerEdited();
  };
  const clearSelection = $('#compose-clear-selection');
  if (clearSelection) clearSelection.onclick = () => { composer.eventIds = []; composerEdited(); };
  card.querySelectorAll('[data-roll-view]').forEach(button => button.onclick = () => { composer.view = button.dataset.rollView; refreshRoll(); });
  const accept = $('#accept-decision');
  if (accept) accept.onclick = () => {
    if (!composerPreviewCurrent() || !composer.previewDraft) return message(t('decision.previewStale'), true);
    const draft = composer.previewDraft, digest = composer.preview.recordDigest;
    run(async () => {
      await commit(await call('acceptPreviewedDecision', workspace, draft, { expectedRecordDigest: digest }));
      composer.eventIds = [];
      composer.view = report.acceptedRoll ? 'accepted' : 'source';
      refreshRoll(); refreshComposer();
      message(t('decision.accepted'));
    });
  };
  const clearAll = $('#clear-decisions');
  if (clearAll) clearAll.onclick = () => run(async () => { await commit(await call('clearAcceptedDecisions', workspace)); message(t('decision.cleared')); });
}
// Keep every highlight layer scrolled with its textarea, and repaint the paste
// box as the user types. The paste box is highlighted only once it holds a
// complete MML@…; string; Canonical IR JSON stays plain. Its per-role counts
// are what the parser will count, shown with the P1 disclaimer, never enforced
// here: truncating or rejecting is the validator's job.
function bindHighlightLayers() {
  document.querySelectorAll('.mml-hl textarea').forEach(area => {
    const layer = area.previousElementSibling;
    area.addEventListener('scroll', () => { layer.scrollTop = area.scrollTop; layer.scrollLeft = area.scrollLeft; });
  });
  const area = $('#paste-content'), layer = $('#paste-layer'), counts = $('#paste-counts');
  if (!area) return;
  let frame = 0;
  const paint = () => {
    frame = 0;
    const value = area.value;
    const wrapped = segmentRoles(value).wrapped;
    layer.innerHTML = wrapped ? renderHTML(value, buildRoles(value)) : renderHTML(value, new Uint8Array(value.length));
    layer.scrollTop = area.scrollTop;
    if (!wrapped) { counts.textContent = ''; return; }
    const perRole = roleCharacterCounts(value);
    counts.innerHTML = perRole.length === 6
      ? `${perRole.map((n, i) => `<span class="${n > PUBLISHED_ROLE_CHARACTER_LIMIT ? 'count-over' : ''}">${roles[i]} ${n}／${PUBLISHED_ROLE_CHARACTER_LIMIT}</span>`).join(' · ')}<br>${P1_CHARACTER_NOTE()}`
      : t('paste.roleCount', { n: perRole.length });
  };
  area.addEventListener('input', () => { if (!frame) frame = requestAnimationFrame(paint); });
  paint();
}
// A waiting release is applied only on request, after every queued action has
// run (run() serializes it behind them) and only while the project is saved:
// the reload that follows discards anything that exists only in this tab.
$('#apply-update').onclick=()=>run(async()=>{
  if(workspace&&!workspace.savedAt)throw Error(t('update.unsaved'));
  if(!updateFlow?.apply())throw Error(t('update.none'));
  applyingUpdate=true;$('#apply-update').disabled=true;message(t('msg.applyingUpdate'),true);
},{revisionBound:false,projectBound:false});
function registerServiceWorker(){
  updateFlow=createUpdateFlow({
    serviceWorker:navigator.serviceWorker,
    reload:()=>location.reload(),
    onDownloading:()=>message(t('update.downloading')),
    onOffer:()=>{$('#apply-update').hidden=false;message(t('update.offer'),true);},
    onStale:()=>{$('#apply-update').hidden=true;message(t('msg.staleTab'),true);},
  });
  navigator.serviceWorker.register('./sw.js',{scope:'./'}).then(reg=>{
    updateFlow.attach(reg);
    addEventListener('focus',()=>updateFlow.check());
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')updateFlow.check();});
  }).catch(()=>message(t('update.notInstalled'),true));
}
// ─── Local library: save state, persistence and whole-library backup ────────
// The sidebar always says whether the open project is saved, how much of the
// browser's quota Studio uses, and whether storage is persistent; persistence
// is requested only when the user asks (Safari may ignore it). "Export all"
// writes every project as its usual backup JSON into one ZIP; restoring a ZIP
// imports each entry through importWorkspace, like a single backup.
$('#persist-storage').onclick=async()=>{const granted=await requestPersistence().catch(()=>null);message(granted===true?t('persist.granted'):granted===false?t('persist.denied'):t('persist.unsupported'),granted!==true);showSaveState();};
const safeName=value=>String(value||'project').replace(/[\\/:*?"<>|\u0000-\u001f]+/g,'_').slice(0,60);
$('#export-all').onclick=()=>run(async()=>{
  const summaries = await listProjectSummaries();
  const files = [];
  for (const summary of summaries) {
    const full = await loadProject(summary.id);
    files.push({ name: `projects/${safeName(full.title)}-${full.id.slice(0, 8)}.json`, data: new TextEncoder().encode(portableBackup(full, identity.metadata)) });
  }
  if (!files.length) throw Error(t('backup.nothing'));
  download(`mml-studio-projects-${new Date().toISOString().slice(0, 10)}.zip`, await zipFiles(files), 'application/zip');
  message(t('backup.exported', { n: files.length }));
},{revisionBound:false,projectBound:false});
async function restoreZip(file){
  const entries = (await unzipFiles(await file.arrayBuffer())).filter(entry => entry.name.toLowerCase().endsWith('.json'));
  if (!entries.length) throw Error(t('backup.zipEmpty'));
  let restored = 0;
  for (const entry of entries) {
    audioFile = null;
    try { await commit(await call('importWorkspace', new TextDecoder().decode(entry.data))); }
    catch (error) { throw Error(t('backup.zipFailed', { name: entry.name, error: error.message, n: restored })); }
    restored += 1;
  }
  message(t('backup.zipRestored', { n: restored }));
}
// Build/Git provenance is audit metadata served by build.json, deliberately
// outside the hashed runtime bundle. Display-only: its absence never relaxes
// Canonical verification, which already ran fail-closed inside the worker.
// ─── Workshop return ────────────────────────────────────────────────────────
// A Workshop edit arrives as one localStorage record named in the URL hash.
// It is shown for confirmation and then imported through putSource() as the
// candidate: the usual intake, invalidation and technical validation run on
// it, every review restarts, and nothing here passes a gate.
function workshopReturnPanel(record, target) {
  const roles = record.mml.slice(4, -1).split(',');
  const origin = record.origin?.title ? t('workshopReturn.originStudio', { title: esc(record.origin.title), label: esc(record.origin.label ?? record.origin.slot ?? '') }) : t('workshopReturn.originWorkshop');
  return `<div class="card workshop-return"><div class="section-heading"><h2>${esc(UNVERIFIED_LABEL)}</h2>${badge('PENDING')}</div>
    <p class="note">${t('workshopReturn.note')}</p>
    <p class="meta">${origin} · ${t('workshopReturn.size', { chars: record.mml.length, roles: roles.filter(Boolean).length })}</p>
    ${record.warnings.length ? `<ul class="meta">${record.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <label for="workshop-return-mml">${t('workshopReturn.label')}</label><textarea id="workshop-return-mml" class="code" readonly spellcheck="false">${esc(record.mml)}</textarea>
    <div class="actions"><button id="workshop-import">${t('workshopReturn.import', { title: esc(target?.title ?? t('workshopReturn.currentProject')) })}</button><button id="workshop-import-new" class="secondary">${t('workshopReturn.importNew')}</button><button id="workshop-discard" class="quiet">${t('workshopReturn.discard')}</button></div></div>`;
}
function offerWorkshopReturn() {
  const id = parseReturnHash(location.hash);
  if (!id) return;
  history.replaceState(null, '', location.pathname + location.search);
  const record = takeReturn(id);
  if (!record) return message(t('workshopReturn.expired'), true);
  const panel = $('#workshop-return');
  const targetId = projects.some(p => p.id === record.origin?.projectId) ? record.origin.projectId : workspace.id;
  const target = projects.find(p => p.id === targetId) ?? { id: workspace.id, title: workspace.title };
  panel.innerHTML = workshopReturnPanel(record, target);
  panel.hidden = false;
  const close = () => { panel.hidden = true; panel.innerHTML = ''; };
  const importInto = project => run(async () => {
    if (project && project.id !== workspace.id) { audioFile = null; await commit(await loadProject(project.id)); }
    else if (!project) { audioFile = null; const fresh = await call('newWorkspace'); fresh.title = record.name || t('workshopReturn.defaultTitle'); await commit(fresh); }
    await putSource('candidate', returnFileName(record), record.mml, 'supporting');
    close();
    message(t('workshopReturn.imported', { label: UNVERIFIED_LABEL }), true);
  }, { revisionBound: false, projectBound: false });
  $('#workshop-import').onclick = () => importInto(target);
  $('#workshop-import-new').onclick = () => importInto(null);
  $('#workshop-discard').onclick = () => { close(); message(t('workshopReturn.discarded')); };
  panel.scrollIntoView?.({ block: 'start' });
}
async function buildAudit(){ try{ const r=await fetch('./build.json'); if(!r.ok) return null; return (await r.json()).audit??null; } catch { return null; } }
function network(){ $('#network').textContent=`${t('side.localRun')} · ${navigator.onLine?'Online':'Offline'}`; }
// ─── Language and theme ─────────────────────────────────────────────────────
// boot.js chose both before first paint; the static page is written in
// zh-Hant and translated here before it is shown (html[data-i18n-pending]).
// A switch re-renders in place: nothing is reloaded, so nothing unsaved is lost
// beyond what a render already replaces. The theme only swaps CSS tokens.
function translateChrome(){
  translateStatic(document,t);
  document.title=t('page.title');
  document.documentElement.lang=langChoice();
  network();
  showSaveState();
}
async function switchLanguage(tag){
  if(updateFlow?.stale){$('#lang').value=langChoice();return message(t('msg.languageStale'),true);}
  savePrefs({lang:tag});
  await useLanguage(tag);
  document.documentElement.lang=tag;
  translateChrome();
  if(workspace&&report&&!$('#app').hidden)render();
}
function initPreferences(){
  const lang=$('#lang');
  lang.innerHTML=LANGS.map(tag=>`<option value="${tag}" ${tag===langChoice()?'selected':''}>${LANG_NAMES[tag]}</option>`).join('');
  lang.onchange=()=>switchLanguage(lang.value).catch(error=>message(error.message,true));
  const theme=$('#theme');
  theme.value=themeChoice();
  theme.onchange=()=>setTheme(theme.value);
  // "Follow the system" follows it live; a choice made on the Workshop page
  // (the same stored preference) is picked up when it is made.
  globalThis.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change',()=>{if(themeChoice()==='system')applyTheme('system');});
  addEventListener('storage',event=>{if(event.key===null||event.key==='studio-workshop/ui'){theme.value=themeChoice();applyTheme();}});
}
await useLanguage(langChoice());
translateChrome();
// The boot line becomes the boot error, if there is one; it is not re-translated.
$('#boot').removeAttribute('data-i18n');
document.documentElement.removeAttribute('data-i18n-pending');
initPreferences();
addEventListener('online',network);addEventListener('offline',network);network();
// ─── Listening sessions ─────────────────────────────────────────────────────
// A listen link (#listen=…) opens its own session beside whatever project is
// open, never plays by itself, and is removed from the address bar once read.
// Notes taken on a session that came from a project are mirrored onto that
// project as plain data (`listeningNotes`), without a revision change: they
// are not evidence and move no gate.
function mirrorListeningNote(projectId,op){
  if(updateFlow?.stale||applyingUpdate)return Promise.reject(Error(t('msg.reloadForNotes')));
  return new Promise((resolve,reject)=>{run(async()=>{try{
    const apply=list=>{const notes=sanitizeStoredNotes(list);return op.type==='delete'?notes.filter(note=>note.id!==op.id):[...notes.filter(note=>note.id!==op.note.id),op.note];};
    if(workspace?.id===projectId){workspace=await saveProject({...workspace,listeningNotes:apply(workspace.listeningNotes)});showSaveState();}
    else{const stored=await loadProject(projectId);await saveProject({...stored,listeningNotes:apply(stored.listeningNotes)});}
    resolve();
  }catch(error){reject(error);}},{revisionBound:false,projectBound:false});});
}
// A link on the page address is opened while boot is still starting the
// Worker, so a first Worker that fails to start rejects its parse with
// WORKER_UNAVAILABLE too. parseListening changes nothing either, so listening
// asks again as boot does below, until the client's replacement budget is
// spent (WORKER_GIVEN_UP).
const listenCall=(action,...args)=>call(action,...args).catch(error=>{if(error.message!==WORKER_UNAVAILABLE)throw error;return listenCall(action,...args);});
listening=createListening({root:$('#listening'),call:listenCall,message,copyText,audio:listenAudio,saveProjectNote:mirrorListeningNote});
$('#open-listening').onclick=()=>listening.showSessions().catch(error=>message(error.message,true));
listening.importFromLocation().catch(error=>message(error.message,true));
addEventListener('hashchange',()=>listening.importFromLocation().catch(error=>message(error.message,true)));
// A Worker whose own script could not be fetched fails through onerror: the
// client rejects what it held and starts a replacement. identity changes
// nothing, so boot asks again until the client's replacement budget is spent
// (WORKER_GIVEN_UP), rather than stopping on the first dropped request.
try {
  identity=await (function ask(){return call('identity').catch(error=>{if(error.message!==WORKER_UNAVAILABLE)throw error;return ask();});})();
  identity={...identity,provenance:await buildAudit()};
  try { projects=await listProjectSummaries(); } catch(error){message(error.message,true);}
  try { workspace=projects[0]?await loadProject(projects[0].id):null; } catch(error){message(error.message,true);workspace=null;}
  workspace??=await call('newWorkspace');
  $('#boot').hidden=true;$('#app').hidden=false;await run(()=>commit(workspace),{revisionBound:false});
  offerWorkshopReturn();
  if('serviceWorker' in navigator) registerServiceWorker();
} catch(error){$('#boot').textContent=error.message;$('#boot').className='boot-error';$('#boot').hidden=false;$('#app').hidden=true;}
