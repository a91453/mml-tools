import { listProjectSummaries, loadProject, requestPersistence, saveProject, storageHealth } from './storage.mjs';
import { portableBackup, unzipFiles, zipFiles } from './backup-zip.mjs';
import { createWorkerClient } from './worker-client.mjs';
import { createTaskQueue } from './task-queue.mjs';
import { createUpdateFlow } from './pwa-update.mjs';
import { buildRoles, diagnosticsFromValidation, renderHTML, roleCharacterCounts, segmentRoles } from './mml-highlight.mjs';
import { mountReviewRoll } from './review-roll.mjs';
import { PROBES, buildObservation, summarize } from './engine-probe.mjs';
import { compareReadback, normalizeCapture } from './preview/readback.mjs';
import { DEFAULT_BANK_LABEL, DEFAULT_BANK_NAME, DEFAULT_INSTRUMENT, instrumentOptions, resolveRoleVoices, uniformProgram } from './preview/instruments.mjs';
import { DEFAULT_BANK_DOWNLOAD_NOTICE, DEFAULT_BANK_SUBSET, loadDefaultBank } from './preview/default-bank.mjs';
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
const reviewLabels = { source: '來源完整與可追溯', version: 'Version Drift／已接受版本', lead: 'Lead 樂句、休止與接棒', core3: 'Core3 單人完整性', full6: 'Full6 和聲、重疊與密度', tempo: 'Tempo、拍號與時間範圍', audio: '原曲音訊證據', adaptation: 'Mobile 最小適配', regression: '回歸與已接受優點' };
const gateLabels = { finalReductionIntegrity: 'Final 六角色收斂完整性', mobileAdaptationIntegrity: 'Mobile 適配完整性', implementation: '分析模組', source: '來源完整性', baseline: '來源基準', technical: 'MML 技術語法', microTiming: '來源感知微時值（1/64 以下）', core3: 'Core3 來源連續性', core3Completeness: 'Core3 單人完整性（Gate 4）', leadDemotion: 'Lead 降級證據', leadPromotion: 'Lead 升級證據', crossSourceHarmony: '跨來源和聲', versionDrift: '版本差異', originalAudio: '原曲音訊', playerReadback: '播放器實際回讀', pendingDecisions: '待決仲裁', intake: '版本／音樂範圍', lead: 'Lead 審核', full6: 'Full6 審核', tempo: 'Tempo／時值審核', adaptation: 'Mobile 適配', regression: '回歸審核', deliveryIdentity: '交付事件一致性' };
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
  if (updateFlow?.stale) return message('Studio 已在其他分頁套用新版；此分頁仍是舊版模組，請重新載入後再操作。', true);
  if (applyingUpdate) return message('正在套用新版並重新載入…', true);
  const task = { fn, revisionBound, projectBound, projectId: workspace?.id, revision: workspace?.revision };
  if (!busy) return drain(task);
  queued.enqueue(task);
  return message('目前步驟完成後會依序執行剛才的操作');
}
async function drain(task) {
  markBusy(true);
  try {
    while (task) {
      if ((task.projectBound && task.projectId !== workspace?.id) || (task.revisionBound && task.revision !== workspace?.revision)) message('專案、來源或設定已變更，剛才的操作未套用，請依目前內容重新確認', true);
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
  const saved = workspace?.savedAt ? `已儲存 ${new Date(workspace.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : workspace ? '尚未儲存：請匯出備份' : '';
  pill.textContent = saved;
  pill.className = `save-state ${workspace?.savedAt ? 'ok' : 'warn'}`;
  const health = await storageHealth().catch(() => null);
  const detail = $('#storage-detail');
  if (detail && health) detail.textContent = [health.usage !== null && health.quota ? `已用 ${bytesLabel(health.usage)}／${bytesLabel(health.quota)}` : null, health.persisted === true ? '已保留離線資料' : health.persisted === false ? '瀏覽器可能清除本機資料' : null].filter(Boolean).join(' · ');
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
    catch (error) { workspace.savedAt=null;await refreshProjects().catch(()=>{});message(`尚未儲存：${error.message}。可先匯出專案備份。`, true); }
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
  const workshop = asset?.format === 'MML' && /MML@/i.test(asset.content ?? '') ? `<p><a class="file-button quiet workshop-link" href="${esc(workshopUrl(workspace.id, slot))}">在工作坊開啟（副本）</a></p>` : '';
  // The picker has no accept list: iPhone/iPad map one to their own document
  // types and grey out an .xml they do not associate with it. The bytes decide
  // the reader (MIDI or ZIP header, else text intake), as for a dropped file.
  return `<div class="card"><h3>${title}</h3><p class="meta">${hint}</p>${asset ? `<p><strong>${esc(asset.name)}</strong></p><p class="meta">${esc(asset.format)} · ${asset.project.events.length} events</p>${source}${workshop}${badge(asset.unsupported.length ? 'UNSUPPORTED' : 'PENDING')} <small>${asset.complete ? '解析完成，等待來源審核' : '來源未完整'}</small>${detail('來源 authority／warnings／unsupported', { sources: asset.project.sources, warnings: asset.warnings, errors: asset.errors, unsupported: asset.unsupported })}` : '<div class="empty">尚未加入來源<br>MusicXML · MML · MIDI · Canonical IR</div>'}<label class="file-button secondary">${asset ? '更換來源' : '選擇檔案'}<input type="file" data-intake="${slot}" aria-label="${title}檔案"></label>${asset ? `<button class="quiet" data-download-ir="${slot}">匯出 IR</button>` : ''}${asset?.format === 'MML' ? `<button class="quiet" data-listen-asset="${slot}">送到試聽</button>` : ''}</div>`;
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
const slotLabels = { candidate: '目前候選', baseline: 'Source-Faithful Baseline', previous: '已接受的前一版' };
const facts = entries => `<dl class="facts">${entries.filter(([, value]) => value !== undefined && value !== null).map(([label, value]) => `<div class="fact"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
const countList = counts => Object.entries(counts ?? {}).map(([code, count]) => `<li><code>${esc(code)}</code> × ${count}</li>`).join('');

function midiSourceCard(entry) {
  const m = entry.midi ?? {};
  const division = m.division?.type === 'ppq' ? `PPQ ${m.division.ticksPerQuarter}` : `${m.division?.type ?? '?'} ${m.division?.raw ?? ''}`;
  const integrity = entry.integrity.verified ? 'PASS' : 'UNSUPPORTED';
  const parse = entry.error ? 'UNSUPPORTED' : entry.complete ? 'PENDING' : 'UNSUPPORTED';
  return `<div class="card">
    <div class="row"><h3>${esc(slotLabels[entry.slot] ?? entry.slot)} · ${esc(entry.name)}</h3>${badge(integrity)}</div>
    <p class="meta">位元組完整性 ${integrity === 'PASS' ? '＝儲存的位元組與來源身分一致' : `＝失敗：${esc(entry.integrity.reasons.join(', '))}`}。這不是來源審核，也不是 SOURCE_PASS。</p>
    ${(entry.integrity.reasons ?? []).includes('STORED_PROJECT_DOES_NOT_MATCH_SOURCE_BYTES') ? '<p class="meta">儲存的事件與這些位元組現在讀出的結果不同。若這份 MIDI 是在較早版本匯入的，讀法可能已經更新（例如把 SMF 的微秒速度讀回它代表的整數 Tempo），請重新匯入原始檔；若不是，請把它當成儲存內容已被改動。</p>' : ''}
    ${facts([
      ['檔案位元組', entry.source.byteLength === null ? null : `${entry.source.byteLength} bytes（${bytesLabel(entry.source.byteLength)}）`],
      ['sha256', entry.source.sha256],
      ['來源類型／權威', entry.source.kind === null ? null : `${entry.source.kind} · ${entry.source.authority}`],
      ['SMF format', m.smfFormat],
      ['Division', division],
      ['Tracks（宣告／實際）', `${m.declaredTrackCount} / ${m.trackCount}`],
      ['Note events', m.noteEventCount],
      ['Tempo / Meter events', `${m.tempoEventCount} / ${m.meterEventCount}`],
      ['Sustain pedal evidence', m.pedalEventCount],
      ['來源聲部（track/channel）', m.sourceVoices?.length ?? 0],
      ['解析完整', entry.complete ? '是' : '否（見下方未支援材料）'],
    ])}
    <p>${badge(parse)} <small>${entry.complete ? '解析完成。仍需來源審核，解析成功不等於 SOURCE_PASS。' : '來源未完整：有未支援或受損材料，下方逐項列出。'}</small></p>
    ${entry.claimedComplete !== entry.complete ? `<p class="note">儲存紀錄宣稱 complete=${entry.claimedComplete}，重新讀取位元組後的結論為 complete=${entry.complete}。以位元組為準。</p>` : ''}
    <details><summary>逐軌（名稱、事件數、打擊、channel、program 變更）</summary><div class="scroll"><table><thead><tr><th>#</th><th>名稱</th><th>raw</th><th>note</th><th>percussion</th><th>channels</th><th>program changes</th><th>EoT</th></tr></thead><tbody>${(m.tracks ?? []).map(track => `<tr><td>${track.index}</td><td>${esc(track.name ?? '—')}</td><td>${track.rawEvents}</td><td>${track.noteEvents}</td><td>${track.percussionEvents}</td><td>${esc(track.channels.join(', ') || '—')}</td><td>${track.programChanges.length}</td><td>${track.sawEndOfTrack ? '有' : '缺'}</td></tr>`).join('')}</tbody></table></div></details>
    ${detail('來源紀錄與完整 unsupported／warnings 證據', { source: entry.source, integrity: entry.integrity, warnings: entry.warnings, unsupported: entry.unsupported })}
  </div>`;
}

function percussionCard(entry) {
  const m = entry.midi ?? {};
  if (!m.percussionEventCount) return '';
  return `<div class="card"><div class="row"><h3>打擊材料</h3>${badge('UNSUPPORTED')}</div>
    <p class="meta">General MIDI channel 10 的音符編號是鼓組選擇器，不是音高。這些事件保留完整時值作為證據，但不會成為任何音高角色的材料；沒有證據支持的 drum-face 對應不在本階段範圍內（MASTER_RULES.md §8）。</p>
    ${facts([['打擊事件', m.percussionEventCount], ['Channel', m.percussionChannels?.join(', ')], ['Note numbers', m.percussionNoteNumbers?.join(', ')]])}
    ${detail('逐一打擊事件（含 tick 起訖與 source event id）', entry.unsupported.filter(item => item.code === 'PERCUSSION_CHANNEL_EVENT'))}</div>`;
}

function unsupportedCard(entry) {
  const codes = Object.entries(entry.midi?.unsupportedCounts ?? {}).filter(([code]) => code !== 'PERCUSSION_CHANNEL_EVENT');
  const warnings = Object.entries(entry.midi?.warningCounts ?? {});
  if (!codes.length && !warnings.length) return '';
  return `<div class="card"><div class="row"><h3>未支援材料與來源警告</h3>${badge(codes.length ? 'UNSUPPORTED' : 'PENDING')}</div>
    <p class="meta">未支援材料不會被修補、量化或丟棄。它讓來源保持「不完整」，並在此逐項可見。</p>
    ${codes.length ? `<p><strong>未支援</strong></p><ul class="codes">${countList(Object.fromEntries(codes))}</ul>` : ''}
    ${warnings.length ? `<p><strong>警告（來源事實，不影響完整性）</strong></p><ul class="codes">${countList(Object.fromEntries(warnings))}</ul>` : ''}
    ${detail('完整證據', { unsupported: entry.unsupported, warnings: entry.warnings })}</div>`;
}

function voiceSplitCard(split) {
  const lossless = !split.missingEventIds.length && !split.duplicatedEventIds.length;
  return `<div class="card"><div class="row"><h3>G11-B　來源聲部分解</h3>${badge(lossless && split.complete ? 'PASS' : 'UNSUPPORTED')}</div>
    <p class="meta">把來源聲部拆成單音 lane。這裡不指派角色、不合併、不刪除任何事件。Lane 相鄰只是打包結果，不代表同一條連續聲部。</p>
    ${facts([
      ['來源聲部數', split.sourceVoiceCount],
      ['Lane 數', split.laneCount],
      ['最大同時發聲數', split.maxPolyphony],
      ['事件（輸入／輸出）', `${split.inputEventCount} / ${split.outputEventCount}`],
      ['遺失事件', split.missingEventIds.length],
      ['重複事件', split.duplicatedEventIds.length],
    ])}
    <div class="scroll"><table><thead><tr><th>來源聲部</th><th>lane</th><th>事件</th><th>平均音高（精確）</th><th>靜默接點</th></tr></thead><tbody>${split.groups.flatMap(group => group.lanes.map(lane => `<tr><td><code>${esc(group.sourceVoice)}</code></td><td>#${lane.index}</td><td>${lane.noteCount}</td><td>${esc(lane.averagePitchExact)}</td><td>${lane.silenceJunctions.length}</td></tr>`)).join('')}</tbody></table></div>
    ${split.groups.some(group => group.diagnostics.length) ? detail('G11-B 診斷（同音重疊、密度、lane 目標等）', split.groups.flatMap(group => group.diagnostics)) : ''}</div>`;
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

function core3Card(candidate) {
  const core3 = candidate.core3;
  const rows = ['Melody', 'Chord1', 'Chord2'].map(role => roleRow(role, candidate.roles[role], candidate, 'core3')).join('');
  return `<div class="card"><div class="row"><h3>Core3 候選（Melody ＋ Chord1 ＋ Chord2）</h3>${badge(core3.status === 'COMPLETE' ? 'PASS' : core3.status)}</div>
    <p class="meta">Core3 是一個三角色單位，三者同為必要，彼此沒有優先順序。這是候選階段的判讀，不是 ACCEPTANCE_CRITERIA.md Gate 4 的接受。</p>
    <div class="scroll"><table><thead><tr><th>角色</th><th>狀態</th><th>lane</th><th>事件</th><th>證據層級</th><th>理由</th><th>來源聲部</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${facts([
      ['尚未成立的功能', core3.missingFunctions.join(', ') || '—'],
      ['未獲證據支持的功能', core3.unprovenFunctions.join(', ') || '—'],
      ['音樂身分是否依賴 Chord3–Chord5', core3.identityDependsOnEnrichment ? '是' : core3.identityMayDependOnEnrichment ? '未確定' : '否'],
      ['三者皆必要', core3.architecture.allThreeRequiredForComplete ? '是' : '否'],
      ['角色間優先順序', core3.architecture.priorityAmongRoles],
    ])}
    ${detail('Core3 功能、理由與未解衝突', { functions: core3.functions, rationale: core3.rationale, unresolvedHarmony: core3.unresolvedHarmony, conflicts: core3.conflicts, pending: core3.pending })}</div>`;
}

function full6Card(candidate) {
  const full6 = candidate.full6;
  const core3Incomplete = candidate.core3.status !== 'COMPLETE';
  const rows = ['Chord3', 'Chord4', 'Chord5'].map(role => roleRow(role, candidate.roles[role], candidate, 'full6')).join('');
  return `<div class="card"><div class="row"><h3>Full6 加值角色（Chord3–Chord5）</h3>${badge(full6.status === 'USEFUL' ? 'PENDING' : full6.status === 'NONE' ? 'N/A' : full6.status)}</div>
    <p class="meta">加值角色與 Core3 分開評估。它們不能替代、不能補足、也不能掩蓋尚未成立的 Core3。</p>
    ${core3Incomplete ? `<p class="note">目前 Core3 為 ${esc(candidate.core3.status)}。即使 Chord3–Chord5 全部填滿，Core3 仍然不完整；這裡不計算任何「完成度百分比」。</p>` : ''}
    <div class="scroll"><table><thead><tr><th>角色</th><th>狀態</th><th>lane</th><th>事件</th><th>證據層級</th><th>理由</th><th>來源聲部</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${detail('加值角色理由、重複風險與跨角色訊號', { rolesUsed: full6.rolesUsed, roleContributions: full6.roleContributions, duplicationRisks: full6.duplicationRisks, conflictSignals: full6.conflictSignals, core3DependencyLaneIds: full6.core3DependencyLaneIds })}</div>`;
}

function pendingCard(candidate) {
  const coverage = candidate.coverage;
  return `<div class="card"><div class="row"><h3>待決、未指派與未支援</h3>${badge(candidate.pending.length || candidate.unassigned.length || candidate.unsupportedSourceMaterial.length ? 'PENDING' : 'PASS')}</div>
    <p class="meta">每個來源事件都必須落在以下其中一格。沒有事件會為了讓畫面好看而被刪除。</p>
    ${facts([
      ['來源事件', coverage.sourceEventCount],
      ['已指派角色', coverage.assignedEventCount],
      ['待決（證據不足或衝突）', coverage.pendingEventCount],
      ['未指派（超出六角色或保留）', coverage.unassignedEventCount],
      ['未支援', coverage.unsupportedEventCount],
      ['覆蓋完整', coverage.complete ? '是' : '否'],
    ])}
    ${candidate.pending.length ? `<div class="scroll"><table><thead><tr><th>lane</th><th>建議角色</th><th>阻擋原因</th><th>Gate</th></tr></thead><tbody>${candidate.pending.map(item => `<tr><td><code>${esc(item.laneId)}</code></td><td>${esc(item.proposedRole ?? '—')}</td><td>${esc(item.blockers.join(' · '))}</td><td><code>${esc(item.gate ?? '—')}</code></td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">目前沒有待決 lane。</p>'}
    ${candidate.unassigned.length ? detail(`未指派 lane（${candidate.unassigned.length}）：材料保留，等待角色決策`, candidate.unassigned) : ''}
    ${candidate.unsupportedSourceMaterial.length ? detail(`G11-C 未支援來源材料（${candidate.unsupportedSourceMaterial.length}）`, candidate.unsupportedSourceMaterial) : ''}
    ${detail('候選診斷訊號', candidate.diagnostics)}
    ${candidate.ledger.length <= LEDGER_DISPLAY_LIMIT
      ? detail(`逐事件角色帳（${candidate.ledger.length}）`, candidate.ledger)
      : `<p class="meta">逐事件角色帳共 ${candidate.ledger.length} 筆，超過畫面顯示上限 ${LEDGER_DISPLAY_LIMIT}。完整內容包含在「下載分析報告」中，沒有任何一筆被捨棄。</p>`}</div>`;
}

function rawMidiSection(entries) {
  if (!entries?.length) return '';
  return `<section id="raw-midi"><div class="section-heading"><h2>02　Raw MIDI 來源與候選</h2><small>完全在本機處理</small></div>
    <p class="note safe">原始 .mid／.midi 位元組只留在這台裝置：檔案 → 本機 Worker → 已合併的 G11 分析模組 → 本頁。任何雲端端點都不會收到這些位元組。</p>
    ${entries.map(entry => `<div class="raw-midi-slot">
      ${midiSourceCard(entry)}
      ${percussionCard(entry)}
      ${unsupportedCard(entry)}
      ${entry.error ? `<div class="card"><div class="row"><h3>G11-B／G11-C</h3>${badge('UNSUPPORTED')}</div><p>${esc(entry.error)}</p></div>`
        : !entry.arrangement ? `<div class="card"><div class="row"><h3>G11-B／G11-C</h3>${badge('UNSUPPORTED')}</div><p class="meta">位元組完整性未通過，因此不進行分解與角色候選：${esc(entry.integrity.reasons.join(', '))}</p></div>`
        : `${voiceSplitCard(entry.arrangement.voiceSplit)}
      <div class="card candidate-banner"><div class="row"><h3>G11-C　角色候選</h3>${badge('PENDING')}</div>
        <p>這是<strong>候選建議</strong>，不是已接受的編排。它沒有修改來源專案，來源事件仍然沒有角色，也不認證任何 Gate：TECHNICAL_PASS、SOURCE_PASS、PLAYER_READBACK_PASS、AUDIO_ALIGNMENT_PASS、MOBILE_ADAPTATION_PASS、IN_GAME_ACCEPTED 皆不成立。</p>
        <p class="meta">來源狀態（上方）、角色候選（下方）與實際審核／接受紀錄（第 04、07 節）是三件不同的事，不會互相升級。</p>
        ${facts([['階段', entry.arrangement.stage], ['種類', entry.arrangement.stageKind], ['已接受', entry.arrangement.accepted ? '是' : '否'], ['認證 Gate', entry.arrangement.certifiesGates.length ? entry.arrangement.certifiesGates.join(', ') : '無'], ['derivation', `${entry.arrangement.pipeline} · ${entry.arrangement.derivation.eventCount} events`]])}
        ${entry.persistedArrangement && !entry.persistedArrangement.current ? `<p class="note">已捨棄一份與目前來源不相符的儲存候選：${esc(entry.persistedArrangement.reasons.join(', '))}。上方顯示的是重新計算的結果。</p>` : ''}</div>
      ${core3Card(entry.arrangement.candidate)}
      ${full6Card(entry.arrangement.candidate)}
      ${pendingCard(entry.arrangement.candidate)}`}
    </div>`).join('')}
    <p class="note">本節不產生 Final MML、不做 Mobile 適配、不指派樂器或八度，也不宣稱任何實機結果。</p></section>`;
}

function diffTable(diff) {
  if (!diff) return '<p class="empty">加入來源基準後顯示事件層級差異。</p>';
  return `<div class="scroll"><table><thead><tr><th>新增音</th><th>移除音</th><th>音高／時值／力度修改</th><th>角色移動</th><th>Tempo 變化</th></tr></thead><tbody><tr><td>${diff.summary.noteAdded}</td><td>${diff.summary.noteRemoved}</td><td>${diff.summary.noteModified}</td><td>${diff.summary.roleMoved}</td><td>${diff.summary.tempoChanged + diff.summary.tempoAdded + diff.summary.tempoRemoved}</td></tr></tbody></table></div>${detail('逐事件差異（音高、起訖拍、角色、力度）', diff)}`;
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
const P1_CHARACTER_NOTE = '字元單位為 JavaScript string length。與目標 client 實際計數的等價性<strong>尚未驗證</strong>（PENDING P1），不得當作實機可貼上的保證。';
const P1_EMITTER_NOTE = `${P1_CHARACTER_NOTE} 此處數字由 emitter 回報，未在本頁另行計算。`;
const P1_LOCAL_NOTE = `${P1_CHARACTER_NOTE} 此處數字是本頁就已驗證的交付文字計算的，並非 emitter 回報值。`;
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
const ORIGIN_LABELS = { generated: '由本機 emitter 產生', pasted: '使用者提供（貼上或匯入）', 'candidate-source': '候選來源本身即為 MML' };

function diagnosticsTable(items) {
  if (!items?.length) return '<p class="meta">沒有診斷訊息。</p>';
  return `<div class="scroll"><table><thead><tr><th>代碼</th><th>嚴重性</th><th>角色</th><th>訊息</th></tr></thead><tbody>${items.map(item => `<tr><td><code>${esc(item.code)}</code></td><td>${badge(severityBadge(item.severity))}</td><td>${esc(item.role ?? '—')}</td><td>${esc(item.message)}${detail('結構化細節', item)}</td></tr>`).join('')}</tbody></table></div>`;
}

function finalRoleTable(attempt) {
  if (!attempt.roles?.length || !attempt.characterCounts) return '<p class="meta">這次嘗試在序列化之前就被拒絕，因此沒有逐角色結果。</p>';
  // The emitter's own limit, never a local restatement of it.
  const limit = attempt.characterCounts.limit;
  return `<div class="scroll"><table><thead><tr><th>角色</th><th>字元 / ${limit}</th><th>起音數</th><th>結束（IR 拍）</th><th>狀態</th></tr></thead><tbody>${attempt.roles.map(entry => `<tr><th scope="row">${esc(entry.role)}</th><td class="${entry.characters > limit ? 'over' : ''}">${entry.characters === null ? '—' : `${entry.characters} / ${limit}`}</td><td>${entry.attacks ?? '—'}</td><td>${esc(entry.end ?? '—')}</td><td>${entry.empty ? '空軌（保持空白）' : entry.characters === null ? '未產生' : '有內容'}</td></tr>`).join('')}</tbody></table></div>`;
}

function generationAttemptCard(attempt) {
  if (!attempt) return '<div class="card"><h3>最近一次產生嘗試</h3><div class="empty">尚未產生 Final MML。<br>按上方「產生 Final MML」開始；所有必要 Gate 通過前不會產生任何輸出。</div></div>';
  const g10 = attempt.microGap ?? {};
  return `<div class="card">
    <div class="attempt-head"><h3>最近一次產生嘗試</h3>${badge(attempt.status)}<span class="meta">${esc(new Date(attempt.at).toLocaleString())} · Revision ${attempt.revision}</span></div>
    <p class="note">這是 <strong>emitter／技術產生狀態</strong>，不是 <code>IN_GAME_ACCEPTED</code>，也不是 <code>VALIDATED</code>。技術上產生成功不代表這份樂譜在目標 client 可被接受。</p>
    ${attempt.blockedGates?.length ? `<p><strong>在產生之前即被下列 Gate 擋下，未產生任何輸出：</strong></p><ul class="codes">${attempt.blockedGates.map(gate => `<li><code>${esc(gateLabels[gate.name] ?? gate.name)}</code> · ${esc(gate.status)}${gate.reason ? ` · ${esc(gate.reason)}` : ''}${gate.blockers?.length ? ` · ${esc(gate.blockers.join(', '))}` : ''}</li>`).join('')}</ul>` : ''}
    <h3>逐角色結果</h3>
    ${finalRoleTable(attempt)}
    <p class="note">${P1_EMITTER_NOTE}</p>
    <h3>診斷</h3>
    ${diagnosticsTable(attempt.diagnostics)}
    ${attempt.deliveryCheck && !(attempt.deliveryCheck.technicalOk && attempt.deliveryCheck.deliveryMatches) ? `<h3>交付驗證拒絕理由</h3>
    <p class="note">emitter 已產出字串，但目前的 Web 交付驗證拒絕了它，因此<strong>沒有套用任何輸出</strong>。以下是驗證器原文：這是<strong>目前驗證器的判定</strong>，不是 Published Canonical 規則，也不是已證實的引擎限制。</p>
    ${facts([['技術語法', attempt.deliveryCheck.technicalOk ? 'PASS' : 'FAIL'], ['與候選事件讀回一致', attempt.deliveryCheck.deliveryMatches ? 'PASS' : 'FAIL']])}
    ${attempt.deliveryCheck.errors.length ? `<ul class="codes">${attempt.deliveryCheck.errors.map(error => `<li>${esc(error)}</li>`).join('')}</ul>` : ''}` : ''}
    <h3>G10　來源感知微時值</h3>
    ${facts([
      ['G10 狀態', g10.status],
      ['安全格線（IR 拍）', g10.safeGrid],
      ['保留區間（來源支持）', g10.preservedIntervalKeys?.length],
      ['拒絕區間（技術殘留）', g10.rejectedIntervalKeys?.length],
      ['封鎖區間（未證實）', g10.blockedIntervalKeys?.length],
      ['政策一致', g10.policyConformant === null || g10.policyConformant === undefined ? null : g10.policyConformant ? '是' : '否'],
    ])}
    <h3>往返讀回（emitter 內建）</h3>
    ${attempt.roundTrip
      ? `${facts([['狀態', attempt.roundTrip.status], ['不一致項目', attempt.roundTrip.mismatches?.length ?? 0]])}${detail('比對欄位與不一致明細', attempt.roundTrip)}`
      : '<p class="meta">未進入往返讀回階段：更早的 Gate 已拒絕這次嘗試。</p>'}
    <h3>emitter 使用的 Published Canonical</h3>
    ${attempt.canonical ? facts([['canonical_version', attempt.canonical.canonical_version], ['canonical_status', attempt.canonical.canonical_status], ['rules_snapshot_sha', attempt.canonical.rules_snapshot_sha]]) : '<p class="meta">這次嘗試未進入 emitter，因此沒有記錄 Canonical 身分。</p>'}
  </div>`;
}

function appliedDeliveryCard(attempt) {
  const applied = appliedDelivery();
  const supersededNote = attempt && attempt.status !== 'PASS' && applied
    ? '<p class="note">最近一次產生<strong>未通過</strong>，因此沒有覆寫任何內容。下方顯示的是<strong>先前已套用</strong>的交付 MML，與上方那次失敗的嘗試無關。</p>'
    : '';
  if (!applied) {
    return `<div class="card"><div class="attempt-head"><h3>目前套用的交付 MML</h3>${badge('PENDING')}</div>${supersededNote}
      <div class="empty">目前沒有屬於這個專案的交付 MML。<br>產生成功後，完整六軌字串會顯示在此，並可原字複製與下載。${report.deliveryOrigin === 'candidate-source' ? '<br><br>目前的候選本身就是 MML，它以<strong>來源</strong>的身分通過了驗證，並可在第 07 節複製；那不是本節產生的輸出。' : ''}</div>
      <div class="actions"><button id="copy-final" disabled>複製完整 Final MML</button><button id="download-final" class="secondary" disabled>下載 Final MML</button></div></div>`;
  }
  return `<div class="card"><div class="attempt-head"><h3>目前套用的交付 MML</h3>${badge('PASS')}<span class="meta">來源：${esc(ORIGIN_LABELS[report.deliveryOrigin] ?? report.deliveryOrigin ?? '—')}</span></div>
    ${supersededNote}
    <p class="meta">此字串已通過目前的 MML 技術語法驗證，並與候選事件逐一讀回一致。複製與下載輸出的就是這個字串本身，不做任何整理、修補、壓縮或裁切。</p>
    <p class="note">這裡的 PASS 只代表這個字串<strong>目前通過交付驗證</strong>（相當於 <code>TECHNICAL_PASS</code> 層級）。它不是 <code>VALIDATED</code>，也不是 <code>IN_GAME_ACCEPTED</code>；整體專案狀態與實機接受紀錄在第 07 節。</p>
    <label for="final-mml">完整六軌 Final MML</label><div class="mml-hl">${mmlLayer(applied, technicalDiagnostics())}<textarea id="final-mml" class="code final" readonly spellcheck="false">${esc(applied)}</textarea></div>
    <div class="actions"><button id="copy-final">複製完整 Final MML</button><button id="download-final" class="secondary">下載 Final MML</button><button id="listen-final" class="secondary">送到試聽</button><a class="file-button quiet workshop-link" id="open-final-workshop" href="${esc(workshopUrl(workspace.id, 'delivery'))}">在工作坊開啟（副本）</a></div>
    <p class="meta">「送到試聽」會開一個獨立的試聽工作階段，可從指定小節、時間或待審標記播放並記下備註；不會改變這個專案或任何 Gate。</p>
    <p class="meta">工作坊是 MML 編輯器，不在 Canonical 驗證流程內；在那裡改過的內容標為「${esc(UNVERIFIED_LABEL)}」，只能經由「送回 Studio 驗證」以衍生候選重新進入本頁。</p>
    <p class="meta">逐角色內容如下。每個「複製」<strong>只會複製該角色的內容</strong>，不是可直接貼上的完整六軌樂譜。</p>
    ${(report.tracks ?? []).map((track, index) => `<div class="role-body"><div class="row"><label for="final-role-${index}">${roles[index]}${track ? '' : ' <small>（空軌）</small>'}</label><button data-copy-role="${index}" class="quiet" ${track ? '' : 'disabled'}>複製此角色內容</button></div><div class="mml-hl">${mmlLayer(track, roleDiagnostics(index))}<textarea id="final-role-${index}" class="code" readonly spellcheck="false">${esc(track)}</textarea></div></div>`).join('')}
  </div>`;
}

const OUTCOME_LABELS = { KEEP: '保留', REDISTRIBUTE: '重新分配', OVERFLOW: '超出六角色容量', PENDING: '待決', OMIT: '已接受省略' };

// The reduction review surface: enough to read the plan, accept decisions and
// apply or roll back. Deliberately not an arrangement editor -- no drag and
// drop, no piano roll. What it must never do is present a PENDING or an
// OVERFLOW as if it were settled, so every bucket is shown with its own count
// and its own reason codes, and nothing here turns a plan PASS into a gate.
function reductionItemRows(items, outcome) {
  const rows = items.filter(item => item.outcome === outcome);
  if (!rows.length) return '<p class="empty">無</p>';
  // A source event an earlier revision duplicated reaches this stage as more
  // than one candidate event. It is one ledger entry -- the accounting is about
  // the source event -- so each copy is listed beneath it rather than the entry
  // being repeated, which would make the source-event count read wrong.
  const roleCell = item => item.manifestationCount > 1
    ? `${item.manifestations.map(entry => `${esc(entry.currentRole ?? '—')} → ${esc(entry.proposedRole ?? '—')}${entry.derived ? ' <span class="muted">（複製）</span>' : ''}`).join('<br>')}`
    : `${esc(item.currentRole ?? '—')} → ${esc(item.proposedRole ?? '—')}`;
  const sourceCell = item => `<code>${esc(item.baselineEventId)}</code>${item.manifestationCount > 1 ? ` <span class="muted">×${item.manifestationCount}</span>` : ''}<br><span class="muted">${esc((item.sourceEventIds ?? []).join(' · '))}</span>`;
  return `<table class="reduction-ledger"><thead><tr><th>來源事件</th><th>角色</th><th>原因</th><th>Lead</th><th>Core3</th></tr></thead><tbody>${rows.slice(0, 200).map(item => `<tr>
    <td>${sourceCell(item)}</td>
    <td>${roleCell(item)}</td>
    <td>${esc(item.reasonCode)}</td>
    <td>${item.leadImpact?.affectsLead ? `${esc(item.leadImpact.kind)} · ${esc(item.leadImpact.resolvedBy ?? '待證據')}` : '—'}</td>
    <td>${item.core3Impact?.leavesCore3 ? '離開 Core3' : item.core3Impact?.entersCore3 ? '進入 Core3' : '—'}</td>
  </tr>`).join('')}</tbody></table>${rows.length > 200 ? `<p class="meta">另有 ${rows.length - 200} 筆，完整內容見下方 ledger。</p>` : ''}`;
}

function finalReductionSection() {
  const plan = reductionPreview?.plan ?? report.finalReduction?.plan;
  const applied = Boolean(workspace.finalReduction);
  const a = plan?.accounting;
  return `<section id="final-reduction"><div class="section-heading"><h2>Final 六角色收斂（G12）</h2><small>角色與容量</small></div><div class="card">
    <p class="meta">把已接受角色的候選收斂成可進入 Mobile 適配的六角色候選。每一個來源支持的事件都會落在<strong>保留／重新分配／超出容量／待決／已接受省略</strong>其中之一，不會有事件無聲消失。本階段<strong>不改音高、八度、起訖、時值與音量</strong>——那些屬於下一節的 Mobile 適配。</p>
    <div class="actions"><button id="preview-reduction" ${workspace.assets?.baseline && workspace.assets?.candidate ? '' : 'disabled'}>預覽收斂計畫</button>${reductionDecisions.length ? `<button id="clear-reduction-decisions" class="quiet">清除 ${reductionDecisions.length} 筆待套用決策</button>` : ''}</div>
    ${applied ? `<p class="meta">已套用 ${workspace.finalReduction.decisions.length} 筆收斂決策。預覽會連同這些已接受的決策一起重新推導；新增的決策會與它們合併後再套用。</p>` : ''}
    ${plan ? `<p>${badge(plan.status)} · 共 ${a.total} 個來源事件 · 保留 ${a.retained} · 重新分配 ${a.redistributed} · 超出容量 ${a.overflow} · 待決 ${a.pending} · 已接受省略 ${a.omitted}</p>
      ${a.manifestationCount > a.total ? `<p class="meta">其中 ${a.duplicatedBaselineEventIds.length} 個來源事件由先前修訂版複製過，合計以 ${a.manifestationCount} 個候選事件進入本階段。計數以<strong>來源事件</strong>為準，每個來源事件只會落在一個去向。</p>` : ''}
      <p class="meta">父候選：<code>${esc(plan.parentRevisionId ?? '（來源基準本身）')}</code> · 計畫：<code>${esc(plan.id)}</code></p>
      ${plan.blockers.length ? detail(`無法自動處理的項目（${plan.blockers.length}）`, plan.blockers) : ''}
      ${plan.warnings.length ? detail(`仍需審核的項目（${plan.warnings.length}）`, plan.warnings) : ''}
      <details open><summary>待決（${a.pending}）——需要音樂判斷，不會自動決定</summary>${reductionItemRows(plan.items, 'PENDING')}</details>
      <details><summary>超出六角色容量（${a.overflow}）——保留在候選與 ledger 中</summary>${reductionItemRows(plan.items, 'OVERFLOW')}</details>
      <details><summary>重新分配（${a.redistributed}）</summary>${reductionItemRows(plan.items, 'REDISTRIBUTE')}</details>
      <details><summary>已接受省略（${a.omitted}）</summary>${reductionItemRows(plan.items, 'OMIT')}</details>
      <details><summary>保留（${a.retained}）</summary>${reductionItemRows(plan.items, 'KEEP')}</details>
      ${detail('Core3（收斂前後）', plan.core3)}
      ${detail('和聲與重疊（收斂前後、新產生者）', { harmony: plan.harmony, overlapRisks: plan.overlapRisks })}
      ${detail('角色容量與字數壓力', { roleCapacity: plan.roleCapacity, characterBudget: plan.characterBudget })}
      ${detail('7→6 無損合併診斷（只供審查）', plan.legacyMergeDiagnostics ?? [])}
      ${detail('完整事件 ledger', plan.items)}
      <p class="note">${badge(plan.status)} 只代表<strong>這份收斂計畫可以安全套用</strong>。它不是 Gate 3／4／5／8／9 通過，也不是 <code>VALIDATED</code>。套用後所有受影響的 Gate 都會重新開啟。</p>` : '<p class="empty">尚未預覽。載入來源基準與候選後即可產生收斂計畫。</p>'}
    <details><summary>記錄一筆收斂決策</summary>
      <p class="meta">決策是<strong>逐事件</strong>的：填入候選 event ID（以空白或分號分隔）。<code>重新分配</code>與<code>省略</code>需要證據位置；<code>省略</code>另需明確理由，且只會移除你指名的事件。</p>
      <p class="note">任何進出 Melody 的移動、複製進 Melody，或移除 Lead 事件，都必須走既有 Lead evidence 契約。本機介面 v1 不提供該表單，這類決策會被計畫擋下並列出原因。</p>
      <form id="reduction-decision"><div class="field-grid">
        <label>動作<select name="action">${options([['REDISTRIBUTE','重新分配到某個角色'],['ACCEPT_OVERFLOW','接受維持在六角色之外'],['OMIT','接受省略（需證據）'],['KEEP','確認維持現有角色']],'REDISTRIBUTE')}</select></label>
        <label>目標角色<select name="toRole">${options([['','（不適用）'],...roles.map(role=>[role,role])],'')}</select></label>
        ${input('eventIds','候選 event ID（空白或分號分隔）','')}
        ${input('evidence','證據位置（來源／段落／event）','')}
        <label class="wide">理由<textarea name="reason" required></textarea></label>
      </div><button class="secondary">加入待套用決策</button></form>
      ${reductionDecisions.length ? detail(`待套用決策（${reductionDecisions.length}）`, reductionDecisions) : ''}
    </details>
    ${reductionPreview && plan?.status === 'PASS' && plan.decisions.length ? '<button id="apply-reduction">套用此收斂計畫並重新分析</button>' : ''}
    ${applied ? '<button id="clear-reduction" class="secondary">還原收斂前候選</button>' : ''}
    <p class="meta">套用只保存<strong>輸入</strong>（已接受的決策、計畫 ID 與審查者），不保存衍生候選，也不保存任何 PASS。每次分析與重新載入都會重新推導；計畫過期即拒絕。匯入備份中的收斂紀錄只作為歷史，需重新預覽與接受。</p>
  </div></section>`;
}

function mobileAdaptationSection() {
  const plan = mobilePreview?.plan ?? report.mobileAdaptation?.plan;
  const profile = mobilePreview?.profile ?? workspace.mobileAdaptation?.profile;
  return `<section id="mobile-adaptation"><div class="section-heading"><h2>Mobile 適配 v1</h2><small>八度與音量</small></div><div class="card">
    <p class="meta">填入本曲在目標樂器上有證據支持的音域與音量設定。系統會計算整個角色的最小八度移動，保留節奏、角色與音量起伏；有新碰撞或音量超界時會停止。空白欄位保持原樣。</p>
    <form id="mobile-profile"><div class="field-grid">${input('profileId','設定名稱',profile?.id ?? '')}${input('reason','本曲適配理由',profile?.reason ?? '')}${input('evidence','證據位置（實機紀錄／音訊時間窗）',profile?.evidence?.join('; ') ?? '')}</div>
    ${roles.map(role => { const rule = profile?.roles?.[role] ?? {}; return `<details><summary>${esc(role)}</summary><div class="field-grid">${input(`${role}-min`,'最低音高（0–107）',rule.pitchRange?.[0] ?? '', 'type="number" min="0" max="107" step="1"')}${input(`${role}-max`,'最高音高（0–107）',rule.pitchRange?.[1] ?? '', 'type="number" min="0" max="107" step="1"')}${input(`${role}-delta`,'音量增減（保留原有起伏）',rule.volumeDelta ?? '', 'type="number" min="-15" max="15" step="1"')}${input(`${role}-default`,'尚未決定音量的起始值（0–15）',rule.defaultVolume ?? '', 'type="number" min="0" max="15" step="1"')}</div></details>`; }).join('')}
    <div class="actions"><button id="preview-mobile" ${workspace.assets?.baseline && workspace.assets?.candidate ? '' : 'disabled'}>預覽適配差異</button></div></form>
    ${plan ? `<p>${badge(plan.status)} · ${mobilePreview ? `${plan.changes.length} 個音符需調整` : `適配已套用 · ${plan.changes.length} 個音符已調整`}</p>${plan.blockers.length ? detail('無法自動修正的項目', plan.blockers) : ''}${plan.warnings.length ? detail('仍需審核的項目',plan.warnings) : ''}${detail('逐音修改前後',plan.changes)}<p class="meta">套用只建立候選版本，仍需重新審核 Mobile、Core3 與回歸結果。適配以<strong>收斂後</strong>的候選為對象；尚未支援樂器指派、鼓面映射與碰撞修復。</p>` : ''}
    ${mobilePreview && plan.status === 'PASS' && plan.changes.length ? '<button id="apply-mobile">套用此預覽並重新分析</button>' : ''}
    ${workspace.mobileAdaptation ? '<button id="clear-mobile" class="secondary">還原適配前候選</button>' : ''}
    <p class="meta">原始來源與基準保持可還原。調整設定會從原始候選重新計算；匯入備份後需重新預覽與套用。</p>
  </div></section>`;
}

function finalDeliverySection() {
  const attempt = workspace.finalDelivery ?? null;
  const blocked = (report.blockers ?? []).filter(name => !['technical', 'deliveryIdentity'].includes(name));
  return `<section id="final-delivery"><div class="section-heading"><h2>06　Final MML 產生與匯出</h2><small>本機 emitter</small></div>
    <div class="card">
      <p class="meta">從目前候選的 Canonical 專案產生六軌 Final MML。使用的是分析當下重建的<strong>同一份</strong>專案，並且會把 readiness 一併交給 emitter；任何必要 Gate 未通過就不會產生輸出。</p>
      ${blocked.length ? `<p class="note">目前仍有 ${blocked.length} 項必要 Gate 未通過，產生會被擋下並回報原因。<code>MML 技術語法</code>與<code>交付事件一致性</code>不在此列：它們評分的正是尚未存在的輸出。</p>` : ''}
      <div class="actions"><button id="generate-final">產生 Final MML</button></div>
    </div>
    ${generationAttemptCard(attempt)}
    ${appliedDeliveryCard(attempt)}
    ${timbrePreviewCard()}
  </section>`;
}
function render() {
  const r = report, w = workspace, s = w.settings;
  const gates = Object.entries(r.gates ?? {});
  $('#app').innerHTML = `
    <div class="hero"><p class="eyebrow">LOCAL-FIRST / STUDIO V1</p><div class="hero-line"><h1>${esc(w.title)}</h1>${badge(r.state)}</div><p>保留來源、看見差異，再決定如何演奏。你的符號樂譜與審核紀錄在本機處理。</p><div class="state-path"><span class="${r.state === 'CANDIDATE' ? 'current' : ''}">01　Candidate</span><span class="${r.state === 'VALIDATED' ? 'current' : ''}">02　Validated</span><span class="${r.state === 'IN_GAME_ACCEPTED' ? 'current' : ''}">03　In-game Accepted</span></div><p class="meta">${w.savedAt ? `本機已保存 ${esc(new Date(w.savedAt).toLocaleString())}` : '尚未儲存'} · Revision ${w.revision}</p></div>
    <section id="intake"><div class="section-heading"><h2>01　專案與來源</h2><small>裝置本地處理</small></div>
      <div class="card"><form id="settings"><div class="field-grid">${input('title', '專案／歌曲名稱', w.title)}${input('recording', '錄音版本（專輯／MV／Live 等）', s.recording)}${input('offset', '有效音樂起點（秒）', s.offset, 'type="number" min="0" step="any"')}${input('end', '有效音樂終點（秒）', s.end, 'type="number" min="0" step="any"')}<label>來源確認的拍號圖<textarea name="meterText" placeholder="例如：0 4/4&#10;32 3/4">${esc(s.meterText)}</textarea></label><div><label>原曲音訊是否為來源集的一部分？<select name="audioRequired">${options([['unknown','尚未確認'],['yes','是，需要 Audio evidence'],['no','否，本專案沒有原曲音訊']],s.audioRequired)}</select></label><label>本次是否使用驗證播放器？<select name="preview">${options([['unknown','尚未確認'],['none','本次未使用播放器／preview'],['used','有使用，需要播放器實際回讀（06 試聽整首後記錄）']],s.preview)}</select></label></div></div><div class="actions"><button>儲存專案設定</button></div><p class="meta">來源、設定或候選內容變更後，先前審核與實機接受將失效。</p></form></div>
      <div class="row"><p class="meta">MusicXML 與 MIDI 預設為第三方 supporting。只有已確認的官方譜／官方 MIDI 可選 primary symbolic；這只改變來源紀錄，不會讓不完整的來源變完整。</p><select id="authority" aria-label="MusicXML／MIDI 來源權威"><option value="supporting">第三方／未確認</option><option value="primary-symbolic">已確認官方 symbolic</option></select></div>
      <div class="grid intake-grid">${intakeCard('candidate','目前候選','這次要審核的版本')}${intakeCard('baseline','Source-Faithful Baseline','編修之前、可逐事件比對的來源基準')}${intakeCard('previous','已接受的前一版','有歷史版本時，用於回歸比較')}</div>
      <details class="card"><summary>貼上 MML／Canonical IR，或附上交付 MML</summary><form id="paste"><div class="field-grid"><label>用途<select name="slot">${options([['candidate','目前候選'],['baseline','來源基準'],['previous','已接受前版'],['delivery','IR 候選對應的交付 MML']],'candidate')}</select></label>${input('name','檔名','pasted.mml')}</div><label for="paste-content">完整文字</label><div class="mml-hl"><pre class="mml-hl-layer" id="paste-layer" aria-hidden="true"></pre><textarea id="paste-content" name="content" class="code" required spellcheck="false" placeholder="MML@…,…,…,…,…,…;"></textarea></div><p class="meta" id="paste-counts" aria-live="polite"></p><div class="actions"><button>在本機載入</button></div></form></details>
    </section>
    ${rawMidiSection(r.rawMidi)}
    <section id="gates"><div class="section-heading"><h2>03　Analysis Gate</h2><span class="ready-count">${r.blockers?.length ?? 0} 項待處理</span></div><div class="gate-grid">${gates.map(([name,g])=>`<div class="gate"><strong>${esc(gateLabels[name] ?? name)}</strong>${badge(g.status)}<p>${esc(g.reason ?? g.blockers?.join(' · ') ?? '')}</p>${detail('檢查內容',g)}</div>`).join('')}</div><p class="note">技術語法通過只代表 TECHNICAL_PASS。未審核、未知與 unsupported 均不會被升級為 PASS。</p></section>
    <section id="review"><div class="section-heading"><h2>04　比對與審核</h2><small>先看證據，再記錄決策</small></div>${reviewRollCard()}
      <div class="card"><h3>Version Drift</h3><p class="review-subtitle">來源基準 → 目前候選。變動數量是診斷資訊。</p>${diffTable(r.lineage?.sourceToCandidate)}<details><summary>已接受前版 → 目前候選</summary>${diffTable(r.lineage?.previousToCandidate)}</details></div>
      <div class="grid"><div class="card"><h3>Lead / Core3</h3><p class="meta">前三軌的 Lead、核心和聲、必要低音／內聲部需能獨立成立。</p>${r.core3 ? detail('連續性、缺口、音域與角色報告',r.core3) : '<p class="empty">等待來源基準</p>'}${detail('Lead 降級證據結果',r.leadReports ?? [])}${detail('Lead 升級證據結果',r.leadPromotionReports ?? [])}<div id="core3-changes">${(r.core3?.unapproved ?? []).map((change,index)=>`<form class="conflict" data-core3="${index}"><p class="meta">${esc(change.type)} · ${esc(change.eventId)}</p>${input('reason','保留此變動的正面理由','')}${input('evidence','來源／段落證據','')}<button class="secondary">記錄此變動審核</button></form>`).join('')}</div></div><div class="card"><h3>六軌重疊與密度</h3><p class="meta">全部 15 組跨軌持續同音、低中音摩擦及同步起音皆供審核；不自動刪音。</p>${detail('跨軌檢查',r.technical?.song?.review ?? {status:'PENDING'})}<p class="note">Rashisa 等具名歷史回歸：FIXTURE_PENDING。通用測試成功不代表這些歌曲已通過。</p></div></div>
      <div class="card"><h3>Harmony arbitration</h3><p class="meta">${r.harmony?.unresolvedCount ?? '—'} 項跨來源衝突待審核。保留須有理由及證據；其他方案先記為 PENDING，待候選實際修改後重新比對。</p>${(r.harmony?.conflicts ?? []).map((c,index)=>`<form class="conflict" data-harmony="${index}"><div class="row"><strong>${esc(c.intervalName)} · ${esc(c.leftRole)} / ${esc(c.rightRole)}</strong>${badge(c.resolved?'PASS':'PENDING')}</div><p class="meta">拍 ${esc(c.start)}–${esc(c.end)} · pitch ${c.leftPitch} / ${c.rightPitch}<br>${esc(c.leftEventId)}<br>${esc(c.rightEventId)}</p>${c.resolved?json(c.decision):`<div class="field-grid"><label>決策<select name="action">${options([['pending','仍待審核'],['keep','保留，已核對'],['omit','建議省略'],['move-role','建議移動角色'],['octave','建議改八度'],['redistribute','建議重新分配']],'pending')}</select></label>${input('reason','音樂／角色理由','')}${input('evidence','來源及段落／event 證據','')}</div><button class="secondary">記錄仲裁</button>`}</form>`).join('') || '<p class="empty">目前沒有跨來源衝突報告。Full6 人工審核仍然需要。</p>'}</div>
      ${r.importedDecisions?.length ? `<div class="card"><h3>匯入的仲裁紀錄</h3><p class="meta">舊的 accepted 狀態保留為歷史。本輪需以目前候選重新記錄保留理由。</p>${r.importedDecisions.map((d,index)=>`<form class="conflict" data-imported-decision="${index}">${detail(d.id,d)}${input('reason','目前保留這些事件的理由','')}${input('evidence','本輪來源／段落證據','')}<button class="secondary">確認保留目前事件</button></form>`).join('')}</div>` : ''}
      <details class="card"><summary>Lead 降級的完整證據鏈</summary><form id="lead-form"><div class="field-grid">${input('eventId','來源基準 Melody event ID','')}${input('destinationRole','目標角色（Chord1–Chord5 或 omitted）','')}<label>段落角色<select name="sectionRole">${options(['unknown','vocal-active','vocal-rest','instrumental','intro','interlude','solo','outro'].map(x=>[x,x]),'unknown')}</select></label><label>樂譜角色<select name="scoreClass">${options(['unknown','lead','accompaniment','inner','counter','duplicate'].map(x=>[x,x]),'unknown')}</select></label>${input('scoreCitation','樂譜來源／event／段落證據','')}<label>音訊角色<select name="audioClass">${options(['unknown','foreground','background','mixed'].map(x=>[x,x]),'unknown')}</select></label>${input('audioCitation','音訊來源／時間窗證據（不可用則留空）','')}${input('positiveReason','目標角色的正面理由','')}<label>接棒與 Core3 檢查<select name="continuity"><option value="unknown">尚未確認</option><option value="checked">已確認無 Lead 缺口且 Core3 成立</option></select></label></div><button class="secondary">執行 Lead evidence gate</button></form></details>
      <details class="card"><summary>Lead 升級的完整證據鏈</summary><p class="meta">非 Melody → Melody 的升級需要正面 Lead 證據。證據綁定候選 event 與其 Source-Faithful 來源 event；重複軌（duplicate）請填衍生 event ID，來源會沿 derived chain 回溯。</p><form id="lead-promotion-form"><div class="field-grid">${input('promotedEventId','候選 Melody event ID','')}${input('originEventId','來源基準 event ID（留空則同上）','')}<label>段落角色<select name="sectionRole">${options(['unknown','vocal-active','vocal-rest','instrumental','intro','interlude','solo','outro'].map(x=>[x,x]),'unknown')}</select></label><label>樂譜角色<select name="scoreClass">${options(['unknown','lead','accompaniment','inner','counter','duplicate'].map(x=>[x,x]),'unknown')}</select></label>${input('scoreCitation','樂譜來源／event／段落證據','')}<label>音訊角色<select name="audioClass">${options(['unknown','foreground','background','mixed'].map(x=>[x,x]),'unknown')}</select></label>${input('audioCitation','音訊來源／時間窗證據（不可用則留空）','')}${input('positiveReason','升級為 Melody 的正面理由','')}<label>接棒與 Core3 檢查<select name="continuity"><option value="unknown">尚未確認</option><option value="checked">已確認無 Lead 缺口且 Core3 成立</option></select></label></div><button class="secondary">執行 Lead promotion gate</button></form></details>
      <div class="card"><h3>記錄本輪人工審核</h3><p class="meta">只在已完成對照／聽驗時記錄；原因與證據綁定目前 revision。紀錄不會清除工具找到的未解決缺口或 unsupported。</p><form id="review-form"><div class="field-grid"><label>審核項目<select name="name">${options(Object.entries(reviewLabels),'source')}</select></label>${input('evidence','來源 ID、event、時間窗或實機紀錄','')}<label class="wide">審核結論與理由<textarea name="note" required></textarea></label></div><button>記錄已完成審核</button></form>${Object.entries(w.reviews).map(([name,v])=>`<div class="review-log"><strong>${esc(reviewLabels[name])}</strong> · ${esc(v.note)}<br><span class="muted">${esc(v.evidence)}</span></div>`).join('')}</div>
    </section>
    <section id="audio"><div class="section-heading"><h2>05　Audio evidence</h2><small>僅主動要求時上傳</small></div><div class="card"><p class="note safe">選取音訊只會留在本機。按下「要求 Audio Alignment」才會傳送該音訊及候選的衍生音符／時間特徵；MusicXML／MML 原始文字不會上傳。</p><p id="audio-file-status" class="meta">${audioFile?esc(`${audioFile.name} · ${(audioFile.size/1048576).toFixed(1)} MiB · 尚未上傳`):'未選取音訊。雲端未連線。'}</p><label class="file-button secondary">選擇 M4A／FLAC／WAV<input id="audio-file" type="file" accept=".m4a,.flac,.wav,audio/mp4,audio/flac,audio/wav"></label><details><summary>Audio Worker 連線（選用）</summary><label>HTTPS alignment endpoint<input id="audio-endpoint" type="url" placeholder="https://your-worker.example/align" autocomplete="off"></label><label>本次工作階段 access token<input id="audio-token" type="password" autocomplete="off"></label><p class="meta">Token 僅存於目前畫面記憶體。v1 沒有預設雲端服務；未設定時保持 PENDING。</p></details><div class="actions"><button id="request-audio" ${!audioFile || !w.assets.candidate?'disabled':''}>要求 Audio Alignment</button><button id="cancel-audio" class="quiet" ${uploadController?'':'disabled'}>取消上傳／等待</button><label class="file-button quiet">匯入既有 alignment report<input id="audio-report" type="file" accept=".json,application/json"></label></div><div id="audio-progress" role="status"></div>${detail('音訊證據、控制點、信心與漂移',w.audio?.report ?? {status:'PENDING',reason:'SONG_AUDIO_EVIDENCE_MISSING'})}<p class="meta">Audio evidence 不會修改、刪除或重排 symbolic events。信心分數本身不代表音高真值。</p></div></section>
    ${finalReductionSection()}
    ${mobileAdaptationSection()}
    ${finalDeliverySection()}
    <section id="delivery"><div class="section-heading"><h2>07　Readiness 與實機接受</h2>${badge(r.state)}</div><div class="card"><p class="note">${r.state==='CANDIDATE'?'目前為 Candidate，尚有必要 Gate 未通過。複製內容仍屬候選版本。':r.state==='VALIDATED'?'必要非實機 Gate 已通過。等待使用者於目標遊戲 client 實際接受。':'已有本輪 exact-MML 實機接受紀錄。'}</p><p class="meta">本節記錄的是<strong>實機接受</strong>。產生與匯出 Final MML 在上方第 06 節。「下載六軌對照文字」是含角色標題的<strong>對照用</strong>文字檔，<strong>不是</strong>可直接貼上的樂譜；可貼上的完整字串請用「複製完整 MML@」或第 06 節的匯出。</p><div class="actions"><button id="copy-mml" ${r.rawMml?'':'disabled'}>複製完整 MML@</button><button id="listen-mml" class="secondary" ${r.rawMml?'':'disabled'}>送到試聽</button><button id="export-mml" class="secondary" ${r.rawMml?'':'disabled'}>下載六軌對照文字</button><button id="export-report" class="quiet">下載分析報告</button></div>${r.tracks?`${r.tracks.map((track,i)=>`<div class="track"><div class="row"><label for="track-${i}">${roles[i]} <small>${track.length} / ${PUBLISHED_ROLE_CHARACTER_LIMIT} 字元</small></label><button data-copy-track="${i}" class="quiet">複製</button></div><div class="mml-hl">${mmlLayer(track, roleDiagnostics(i))}<textarea id="track-${i}" class="code" readonly spellcheck="false">${esc(track)}</textarea></div></div>`).join('')}<p class="note">${P1_LOCAL_NOTE}</p>`:'<p class="empty">需有通過 Final 技術語法且與候選事件一致的六軌 MML。MusicXML／IR 不會自動縮編或猜測角色；可在第 06 節產生，或附上對應的交付 MML 進行回讀。</p>'}<details><summary>記錄 In-game Accepted</summary><form id="acceptance"><div class="field-grid">${input('client','Client／地區／版本','')}${input('instrument','樂器與軌道配置','')}${input('evidence','實機結果／截圖或紀錄定位','')}</div><button ${r.state==='CANDIDATE'?'disabled':''}>此 exact-MML 已實機接受</button></form>${w.acceptance?json(w.acceptance):''}</details></div>${engineProbeCard()}</section>
    <details class="card"><summary>Published Canonical 與建置身分</summary><p class="meta">本機使用建置時由 Published main 取得並核驗的完整固定快照。離線模式不宣稱已確認最新 main。</p>${json(identity.metadata)}${identity.provenance?json(identity.provenance):''}${identity.documents.map(d=>`<details><summary>${esc(d.path)} · ${esc(d.authority)}</summary><a href="${esc(d.url)}" target="_blank" rel="noopener">GitHub 固定快照</a><pre>${esc(d.content)}</pre></details>`).join('')}</details>`;
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
    message(`已略過過期的 MIDI 來源分析（${verdict.reason}）。畫面顯示的是目前的來源。`, true);
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
    label.textContent = '瀏覽器未授予剪貼簿權限。以下是完全相同的文字，已為你選取：';
    const area = document.createElement('textarea');
    area.className = 'code'; area.readOnly = true; area.spellcheck = false;
    // Assigned, not templated: nothing between the source string and the field.
    area.value = value;
    const close = document.createElement('button');
    close.className = 'quiet'; close.type = 'button'; close.textContent = '關閉';
    close.onclick = dismissCopyFallback;
    box.append(label, area, close);
    (document.querySelector('#final-delivery') ?? document.querySelector('#delivery')).append(box);
    area.focus(); area.select();
  }
  message('瀏覽器未授予剪貼簿權限。文字已選取，可手動複製。', true);
}
async function copyText(value, textarea) {
  if (typeof value !== 'string' || !value) return message('沒有可複製的內容');
  try { await navigator.clipboard.writeText(value); dismissCopyFallback(); message('已複製'); }
  catch { showCopyFallback(value, textarea); }
}
function bind() {
  $('#reduction-decision').onsubmit = event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    const eventIds = data.eventIds.split(/[;\s]+/).map(id => id.trim()).filter(Boolean);
    if (!eventIds.length) return message('請至少填入一個候選 event ID');
    const decision = { id: `web:${data.action.toLowerCase()}:${reductionDecisions.length + 1}`, action: data.action, eventIds, reason: data.reason,
      evidence: data.evidence.split(';').map(ref => ref.trim()).filter(Boolean) };
    if (data.action === 'REDISTRIBUTE') {
      if (!data.toRole) return message('重新分配需要目標角色');
      decision.toRole = data.toRole;
    }
    reductionDecisions = [...reductionDecisions, decision];
    reductionPreview = null;
    render();
    message('已加入待套用決策；請重新預覽收斂計畫。');
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
      if (!result.applied) { reductionPreview = { decisions: preview.decisions, plan: result.plan }; render(); message(result.blockers?.map(item => item.code).join(', ') || '沒有可套用的收斂決策'); return; }
      await commit(result.workspace);
      message('收斂已套用；所有受影響的 Gate 已重新開啟，請重新審核。');
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
      if (!result.applied) { mobilePreview = { profile: preview.profile, plan: result.plan }; render(); message(result.blockers?.map(item => item.code).join(', ') || '不需要調整'); return; }
      await commit(result.workspace);
      message('適配已套用；請檢查新的差異與 Gate。');
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
      if(file.size>MAX_SOURCE_BYTES)throw Error(`UNSUPPORTED: 來源檔案 ${(file.size/1048576).toFixed(1)} MiB 超過 4 MiB 上限`);
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
    if(!data.reason?.trim()||!data.evidence?.trim())throw Error('每個仲裁需要理由與證據');
    const next=structuredClone(workspace);next.acceptance=null;next.harmonyDecisions=next.harmonyDecisions.filter(d=>d.id!==conflict.id);next.harmonyDecisions.push({id:conflict.id,eventIds:[conflict.leftEventId,conflict.rightEventId],action:data.action,status:data.action==='keep'?'accepted':'pending',reason:data.reason,evidence:[data.evidence],revision:workspace.revision});await commit(next);
  });});
  document.querySelectorAll('[data-core3]').forEach(form=>form.onsubmit=event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form)),change=report.core3.unapproved[Number(form.dataset.core3)];run(async()=>{
    if(!data.reason?.trim()||!data.evidence?.trim())throw Error('需要變動理由與證據');const next=structuredClone(workspace);next.acceptance=null;next.core3Approvals.push({eventId:change.eventId,type:change.type,reason:data.reason,evidence:[data.evidence],revision:workspace.revision});await commit(next);
  });});
  document.querySelectorAll('[data-imported-decision]').forEach(form=>form.onsubmit=event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form)),original=report.importedDecisions[Number(form.dataset.importedDecision)];run(async()=>{
    if(!data.reason?.trim()||!data.evidence?.trim())throw Error('需要本輪保留理由與證據');const next=structuredClone(workspace);next.acceptance=null;next.harmonyDecisions=next.harmonyDecisions.filter(d=>d.id!==original.id);next.harmonyDecisions.push({...original,action:'keep',status:'accepted',reason:data.reason,evidence:[data.evidence],revision:workspace.revision});await commit(next);
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
    const {requestAudioAlignment,verifyAudioBinding}=await import('./audio-client.mjs');uploadController=new AbortController();$('#cancel-audio').disabled=false;$('#audio-progress').textContent='Audio Alignment 執行中…';
    const timeout=setTimeout(()=>uploadController?.abort(),180000);
    try{const alignment=await requestAudioAlignment({requested:true,file,project:workspace.assets.candidate.project,endpoint,token,signal:uploadController.signal});if(workspace.id!==projectId||workspace.revision!==revision)throw Error('專案已變更，丟棄過期音訊報告');const next=structuredClone(workspace);next.audio={revision,report:alignment,projectIdentity:await verifyAudioBinding(alignment,workspace.assets.candidate.project)};delete next.reviews.audio;next.acceptance=null;await commit(next);}
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
    if(workspace.id!==projectId||workspace.revision!==revision) return message('\u5c08\u6848\u6216\u5167\u5bb9\u5df2\u8b8a\u66f4\uff0c\u5df2\u6368\u68c4\u904e\u671f\u7684 Final \u7522\u751f\u7d50\u679c\u3002\u8acb\u4f9d\u76ee\u524d\u5167\u5bb9\u91cd\u65b0\u7522\u751f\u3002',true);
    await commit(await call('applyFinalDelivery',workspace,result));
    message(result.status==='PASS'?'Final MML \u5df2\u7522\u751f\u4e26\u5957\u7528':`Final \u7522\u751f\u672a\u901a\u904e\uff1a${result.status}\u3002\u8a3a\u65b7\u5df2\u5217\u65bc\u7b2c 06 \u7bc0\uff0c\u6c92\u6709\u5beb\u5165\u4efb\u4f55\u8f38\u51fa\u3002`,result.status!=='PASS');
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
  if(listenMml)listenMml.onclick=()=>sendToListening(report.rawMml,report.deliveryOrigin==='candidate-source'?'候選 MML':'完整 MML@',{markers:true});
  document.querySelectorAll('[data-listen-asset]').forEach(button=>button.onclick=()=>{const slot=button.dataset.listenAsset;sendToListening(workspace.assets[slot]?.content,slotLabels[slot]??slot);});
}
function sendToListening(mml,label,{markers=false}={}){
  if(!listening||typeof mml!=='string'||!mml.trim())return message('沒有可送到試聽的 MML');
  const alternatives=[['Final MML',appliedDelivery()],['完整 MML@',report?.rawMml],...['candidate','baseline','previous'].map(slot=>[slotLabels[slot],workspace.assets[slot]?.format==='MML'?workspace.assets[slot].content:null])].filter(([,text])=>typeof text==='string'&&text.trim()).map(([name,text])=>({label:name,mml:text}));
  listening.openFromProject({projectId:workspace.id,projectTitle:workspace.title,label,mml,meterText:workspace.settings?.meterText??'',markers:markers?markersFromReport(report):[],notes:workspace.listeningNotes??[],alternatives}).catch(error=>message(error.message,true));
}

$('#new-project').onclick=()=>run(async()=>{audioFile=null;await commit(await call('newWorkspace'));},{revisionBound:false,projectBound:false});
$('#projects').onchange=()=>{const id=$('#projects').value;run(async()=>{if(!projects.some(p=>p.id===id))throw Error('找不到選取的專案，請重新開啟');const selected=await loadProject(id);audioFile=null;await commit(selected);},{revisionBound:false,projectBound:false});};
$('#export-project').onclick=()=>{if(workspace)download('mml-studio-project.json',portableBackup(workspace,identity.metadata));};
$('#restore-project').onchange=()=>{const file=$('#restore-project').files[0];$('#restore-project').value='';if(file&&/\.zip$/i.test(file.name))return run(()=>restoreZip(file),{revisionBound:false,projectBound:false});if(file)run(async()=>{if(file.size>16*1048576)throw Error(`Project backup is ${(file.size/1048576).toFixed(1)} MiB; the restore limit is 16 MiB. Export the sources separately if a MIDI project exceeds it.`);audioFile=null;await commit(await call('importWorkspace',await file.text()));message('已匯入；先前審核保留為歷史，本輪需要重新審核。');},{revisionBound:false,projectBound:false});};
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
      <label>貼進遊戲的測試字串<textarea class="code" readonly spellcheck="false" data-probe-mml>${esc(probe.mml)}</textarea></label>
      <div class="actions"><button type="button" class="secondary" data-probe-copy="${esc(probe.id)}">複製測試字串</button></div>
      <p class="meta">${esc(probe.listen)}</p>
      <form data-probe-form="${esc(probe.id)}"><fieldset class="probe-outcomes"><legend>在遊戲中觀察到的結果</legend>${probe.outcomes.map(o => `<label><input type="radio" name="outcome" value="${esc(o.id)}" required> ${esc(o.label)}</label>`).join('')}</fieldset>
        <div class="field-grid">${input('client', '遊戲 client／地區', '')}${input('version', '版本', '')}${input('instrument', '樂器', '')}${input('notes', '備註（選填）', '')}</div>
        <div class="actions"><button>記錄這次實機觀察</button></div></form>
      ${own.length ? `<p class="meta">已記錄 ${own.length} 筆${state.consistent ? '' : '，<strong>結果不一致</strong>，需要再確認'}：</p><ul class="probe-log">${own.map(o => `<li>${esc(o.outcomeLabel)} · ${esc(o.client)} ${esc(o.version)} · ${esc(o.instrument)} · ${esc(o.observedAt.slice(0, 10))} <button type="button" class="quiet" data-probe-delete="${o.id}">刪除</button></li>`).join('')}</ul>` : ''}</div>`;
  };
  return `<details class="card engine-probes" id="engine-probes"><summary>引擎實機測試（PENDING 項目）</summary>
    <p class="note">把測試字串貼進遊戲、實際聽過之後再記錄。紀錄是這個 client／版本／樂器與這個確切字串的 <strong>class E 實機證據</strong>，只存在這台裝置；不會自動改變任何 Canonical 規則，要改規則需走發布流程。</p>
    ${PROBES.map(probeBlock).join('<div class="divider"></div>')}
    <div class="actions"><button type="button" class="secondary" id="probe-export" ${probeState.observations.length ? '' : 'disabled'}>匯出實機紀錄 JSON</button></div>
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
  } catch (error) { probeState.error = `實機紀錄讀取失敗：${error.message}`; }
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
      message('已記錄這次實機觀察；只保存在這台裝置。');
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
const preview = { voices: 0, bank: undefined, bankChecked: false, defaultCached: undefined, download: null, context: null, engine: null, engineLoading: null, engineToken: 0, transport: null, songKey: null, choices: null, choicesKind: null, position: 0, muted: [false, false, false, false, false, false], busy: false, error: null, playBinding: null, lastCapture: null, owner: 'final', listenHandlers: null };
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
    rows.push(`<p class="meta">已記錄 ${esc(new Date(stored.recordedAt).toLocaleString())} · ${esc(stored.bank.name)} <code class="digest">sha256 ${esc(stored.bank.sha256.slice(0, 12))}…</code> · ${esc(String(stored.program.program + 1).padStart(3, '0'))} ${esc(stored.program.name)} · ${esc(stored.engine.lib)} / ${esc(stored.engine.core)}<br>引擎處理 ${c.processedNotes}／${c.expectedNotes} 個音符 · 最大時間偏差 ${c.maxDriftMs} ms（容許 ${c.toleranceMs} ms）</p>`);
    if (!c.ok) rows.push(`<ul class="codes">${c.errors.map(error => `<li><code>${esc(error)}</code></li>`).join('')}</ul>`);
  }
  if (last) {
    const c = last.comparison;
    rows.push(`<p class="${c.ok ? 'meta' : 'note'}">剛才的整首播放：引擎處理 ${c.processedNotes}／${c.expectedNotes} 個音符 · 最大偏差 ${c.maxDriftMs} ms · ${c.ok ? '與目前的 exact MML 一致' : `不一致：${esc(c.errors.join(' · '))}`}</p>`);
    if (last.capture.complete) rows.push(`<div class="actions"><button type="button" id="record-readback" ${used ? '' : 'disabled'}>記錄為播放器實際回讀</button></div>`);
    else rows.push('<p class="meta">這次播放沒有涵蓋整首（靜音、跳轉或換音色），不能記錄；請從頭完整播放一次。</p>');
  } else if (report?.rawMml) rows.push('<p class="meta">從頭完整播放一次（不靜音、不跳轉、不換音色），結束後可記錄回讀。</p>');
  if (!used) rows.push('<p class="note">Gate 6 只在專案設定「本次是否使用驗證播放器？」選「有使用」時採用回讀。變更設定會讓 revision 前進，之後需要重新完整播放。</p>');
  if (workspace?.playerReadback) rows.push('<div class="actions"><button type="button" id="clear-readback" class="quiet">移除回讀紀錄</button></div>');
  return `<div class="readback" id="player-readback"><div class="attempt-head"><h4>播放器實際回讀（Gate 6）</h4>${gate ? badge(gate.status) : ''}</div>
    ${gate?.reason ? `<p class="meta"><code>${esc(gate.reason)}</code></p>` : ''}${rows.join('')}
    <p class="meta">回讀只證明這個播放器載入並處理了這份 exact MML 的每個音符（範圍：${esc('processed_engine_events_not_hardware_audio')}）。它不是硬體錄音，不代表遊戲音色，也不是實機接受。</p></div>`;
}
function timbrePreviewCard() {
  const song = report?.technical?.ok ? report.technical.song : null;
  const ready = Boolean(report?.rawMml && song);
  const bank = preview.bank;
  // No bank of the user's own: the free default bank plays, always labelled.
  const bankLine = bank === undefined ? '讀取音色庫中…' : bank ? `${esc(bank.name)} · ${bytesLabel(bank.size)} · <code class="digest">sha256 ${esc(bank.sha256.slice(0, 16))}…</code> · 你選擇的音色庫（優先於預設音色）` : `${esc(DEFAULT_BANK_NAME)} · <strong>${esc(DEFAULT_BANK_LABEL)}</strong>`;
  const defaultNote = bank === null ? defaultBankNote() : '';
  const playable = ready && bank !== undefined;
  const { options: choices, all } = instrumentPicker();
  const select = (attrs, value, label) => `<select ${attrs} ${choices.length ? '' : 'disabled'}>${choices.length ? `${value === '' ? '<option value="" selected>（逐角色不同）</option>' : ''}${choices.map(o => `<option value="${esc(o.value)}" ${o.value === value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}` : `<option>${label}</option>`}</select>`;
  return `<div class="card preview-card" id="timbre-preview"><div class="attempt-head"><h3>遊戲音色試聽</h3><span class="badge na">模擬試聽</span></div>
    <p class="note">用這台裝置上的音色庫播放目前的交付 MML：你選擇的音色庫優先；沒有選擇時使用<strong>${esc(DEFAULT_BANK_LABEL)}</strong>，第一次播放時才從 MuseScore 官方來源下載並核對 SHA-256。這是<strong>聆聽輔助</strong>，不是實機驗收；光是播放不會通過任何 Gate。音色庫只存在這台裝置的瀏覽器，不會上傳，也不會進入專案備份。</p>
    <div class="preview-bank"><span class="meta" id="bank-status">${bankLine}</span><label class="file-button secondary">${bank ? '更換音色庫' : '選擇自己的音色庫'}<input type="file" id="bank-file" accept=".dls,.sf2,.sf3" aria-label="選擇音色庫檔案"></label>${bank ? '<button type="button" id="bank-clear" class="quiet">移除音色庫（改用預設音色）</button>' : ''}${preview.defaultCached ? '<button type="button" id="default-bank-clear" class="quiet">刪除這台裝置上的免費音色</button>' : ''}</div>
    ${defaultNote ? `<p class="meta" id="default-bank-note" data-default-bank-note>${esc(defaultNote)}</p>` : ''}
    ${ready ? '' : '<p class="empty">需先有通過驗證、且與候選一致的交付 MML，才能試聽。</p>'}
    <div class="preview-controls"><label>全部角色音色${select('id="preview-program"', all, '按播放後載入音色清單')}</label>
      <button type="button" id="preview-play" ${playable ? '' : 'disabled'}>${preview.busy ? '載入中…' : '▶ 播放'}</button><button type="button" id="preview-stop" class="secondary" ${preview.transport?.playing ? '' : 'disabled'}>■ 停止</button>
      <input type="range" id="preview-seek" min="0" max="1000" value="0" aria-label="播放位置" ${playable ? '' : 'disabled'}><span class="meta" id="preview-time">${clock(preview.owner === 'final' ? preview.position : 0)} / ${clock(preview.owner === 'final' ? preview.transport?.duration ?? 0 : 0)}</span></div>
    <div class="preview-roles" role="group" aria-label="試聽角色">${roles.map((role, i) => `<label><input type="checkbox" data-preview-role="${i}" ${preview.muted[i] ? '' : 'checked'}> ${role}</label>`).join('')}</div>
    <details class="preview-instruments"><summary>逐角色音色${bank === null ? `（${esc(DEFAULT_BANK_LABEL)}）` : ''}</summary><div class="preview-instrument-grid">${roles.map((role, i) => `<label>${role}${select(`data-preview-instrument="${i}"`, preview.choices?.[i] ?? '', '按播放後載入音色清單')}</label>`).join('')}</div><p class="meta">每個角色可選不同音色；大鼓與鈸使用 GM 鼓組音。逐角色不同音色或使用鼓組時，這次播放不能記錄為播放器回讀。</p></details>
    ${preview.error ? `<p class="note">${esc(preview.error)}</p>` : ''}
    ${ready ? readbackBlock() : ''}</div>`;
}
// The engine and its one transport are shared by the Final preview (this card)
// and listening sessions (listen-ui.mjs). `preview.owner` says whose playback
// the transport is running, so position and end reports reach that player
// only; a player that takes the transport tells the other one it stopped.
function previewTimeText() { const el = $('#preview-time'); if (el) el.textContent = `${clock(preview.owner === 'final' ? preview.position : 0)} / ${clock(preview.owner === 'final' ? preview.transport?.duration ?? 0 : 0)}${preview.owner === 'final' && preview.transport?.playing ? ` · 發聲 ${preview.voices}` : ''}`; }
function previewSeekSync() { const el = $('#preview-seek'); if (el && preview.transport?.duration) el.value = String(Math.round((preview.position / preview.transport.duration) * 1000)); }
function claimTransport(owner, handlers = null) {
  if (preview.owner === 'listen' && (owner !== 'listen' || handlers !== preview.listenHandlers)) preview.listenHandlers?.onPreempt?.();
  preview.owner = owner;
  preview.listenHandlers = owner === 'listen' ? handlers : null;
}
// Created and resumed before the first await: iOS Safari only unlocks audio
// inside the user's gesture.
function startAudioContext() {
  if (!preview.context) {
    const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AudioContextClass) throw Error('此瀏覽器不支援 Web Audio，無法試聽音色');
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
  const { loadBank } = await import('./preview/soundbank-store.mjs');
  const { createPreviewEngine, createTransport } = await import('./preview/player.mjs');
  // The user's own bank takes precedence; without one, the free default bank.
  const bank = await loadBank() ?? await loadDefaultPreviewBank();
  if (token !== preview.engineToken) throw Error('音色庫已更換，請再按一次播放。');
  try { preview.engine = await createPreviewEngine(bank, preview.context); preview.engine.isDefault = Boolean(bank.isDefault); }
  catch (error) { preview.engine = null; preview.context = null; throw error; }
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
        catch (error) { preview.lastCapture = null; preview.error = `回讀無法使用：${error.message}`; }
      }
      refreshPreview();
    },
  });
  ensureChoices();
  preview.transport.setVoices(resolveRoleVoices(preview.choices));
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
    if (bank.downloaded) message(bank.stored === false ? '已下載並核對免費音色，但這台裝置無法保存它；下次播放會再下載。' : '已下載並核對免費音色，只存在這台裝置；之後可離線使用。');
    return bank;
  } finally {
    preview.download = null;
    refreshPreview();
  }
}
function defaultBankNote() {
  const download = preview.download;
  if (download?.phase === 'download') {
    const mb = bytes => (bytes / 1e6).toFixed(1);
    return `${DEFAULT_BANK_DOWNLOAD_NOTICE}。下載中 ${Math.floor((download.received / download.total) * 100)}%（${mb(download.received)}／${mb(download.total)} MB）`;
  }
  if (download?.phase === 'trim') return '已核對下載檔的 SHA-256，正在這台裝置產生免費音色子集並核對…';
  if (preview.defaultCached) return '免費音色已存在這台裝置（已核對 SHA-256），可離線使用。';
  if (preview.defaultCached === false) return `${DEFAULT_BANK_DOWNLOAD_NOTICE}。按播放後才會下載。`;
  return '';
}
// Progress only rewrites the note text, so a download does not re-render the
// cards (and close what the user has open) on every chunk.
function showDefaultBankNote() {
  const note = defaultBankNote();
  for (const element of document.querySelectorAll('[data-default-bank-note]')) if (element.textContent !== note) element.textContent = note;
}
async function clearDefaultPreviewBank() {
  const { clearDefaultSubsets } = await import('./preview/soundbank-store.mjs');
  if (preview.engine?.isDefault || preview.engineLoading) resetPreviewEngine();
  await clearDefaultSubsets();
  preview.defaultCached = false;
  message('已刪除這台裝置上的免費音色；下次播放時會再從 MuseScore 官方來源下載。');
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
  if (role === null) preview.choices = Array(6).fill(value); else preview.choices[role] = value;
  preview.transport?.setVoices(resolveRoleVoices(preview.choices));
  refreshPreview();
}
// The listening sessions' view of the shared engine (listen-ui.mjs).
const listenAudio = {
  status: () => ({ bank: preview.bank, busy: preview.busy, fallback: preview.bank === null ? `${DEFAULT_BANK_NAME} · ${DEFAULT_BANK_LABEL}` : null, fallbackNote: preview.bank === null ? defaultBankNote() : '', defaultCached: Boolean(preview.defaultCached) }),
  instruments: () => { const picker = instrumentPicker(); return { options: picker.options, choices: [...(preview.choices ?? [])], defaultBank: picker.defaultBank, uniform: uniformProgram(resolveRoleVoices(preview.choices)) !== null }; },
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
    const { storeBank } = await import('./preview/soundbank-store.mjs');
    resetPreviewEngine();
    preview.bank = await storeBank(file);
    preview.error = null;
    message(`已載入音色庫 ${file.name}；只保存在這台裝置。`);
    refreshPreview();
  },
  clearDefaultBank: () => clearDefaultPreviewBank(),
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
    if (!last) return message('回讀已不是目前的內容，請重新完整播放一次', true);
    run(async () => {
      await commit(await call('recordPlayerReadback', workspace, last.capture, last.binding));
      preview.lastCapture = null;
      refreshPreview();
      message(report.gates.playerReadback?.status === 'PASS' ? '已記錄播放器實際回讀；Gate 6 通過。' : `已記錄播放器實際回讀；Gate 6 仍待處理：${report.gates.playerReadback?.reason ?? ''}`);
    });
  };
  const clearReadback = $('#clear-readback');
  if (clearReadback) clearReadback.onclick = () => run(async () => { await commit(await call('clearPlayerReadback', workspace)); message('已移除播放器回讀紀錄。'); });
  $('#preview-seek').onchange = event => {
    const duration = preview.owner === 'final' ? preview.transport?.duration ?? 0 : 0;
    preview.position = (Number(event.target.value) / 1000) * duration;
    previewTimeText();
    if (preview.owner === 'final' && preview.transport?.playing) preview.transport.play(preview.position).catch(fail);
  };
  $('#preview-program').onchange = event => { if (event.target.value) setInstrument(null, event.target.value); };
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
    const { clearBank } = await import('./preview/soundbank-store.mjs');
    resetPreviewEngine();
    await clearBank().catch(error => message(error.message, true));
    preview.bank = null;
    refreshPreview();
  };
  const clearDefault = $('#default-bank-clear');
  if (clearDefault) clearDefault.onclick = () => clearDefaultPreviewBank().catch(error => message(error.message, true));
}
function resetPreviewEngine() {
  claimTransport('final');
  preview.transport?.destroy();
  preview.transport = null; preview.engine = null; preview.context = null; preview.songKey = null; preview.position = 0;
  preview.engineLoading = null; preview.engineToken += 1;
}
// Reads only what is stored; nothing is downloaded until a playback needs it.
async function loadStoredBankInfo() {
  preview.bankChecked = true;
  try {
    const { loadBank, describe, hasDefaultSubset } = await import('./preview/soundbank-store.mjs');
    const stored = await loadBank();
    preview.bank = stored ? describe(stored) : null;
    preview.defaultCached = await hasDefaultSubset(DEFAULT_BANK_SUBSET.sha256).catch(() => false);
  } catch (error) { preview.bank = null; preview.error = `音色庫讀取失敗：${error.message}`; }
  refreshPreview();
}
// ─── Six-role review roll ───────────────────────────────────────────────────
// A read-only view (review-roll.mjs). It locates events and review signals and
// never edits, accepts or reviews anything. Selecting an event describes it,
// links to the existing forms, and can add it to the Decision Composer's
// selection. Three projections can be shown, always labelled: the analysed
// candidate (default), the verified G11-D head, and the composer's dry run.
const ROLL_LANES = [...roles, '未指派'];
const ROLL_VIEWS = { source: '分析候選', accepted: '已接受編排（G11-D）', preview: '決策預覽（尚未接受）' };
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
  if (!roll) return '<div class="card roll-card"><h3>六角色審核捲軸</h3><div class="empty">加入候選來源並完成分析後，這裡會以捲軸顯示六個角色。</div></div>';
  const counts = [...roll.lanes.map(l => l.events.length), roll.unassigned.length];
  const kinds = { harmony: 0, overlap: 0, crowding: 0 };
  for (const signal of roll.signals) kinds[signal.kind] += 1;
  const unresolved = roll.signals.filter(signal => signal.kind === 'harmony' && !signal.resolved).length;
  const views = Object.keys(ROLL_VIEWS).filter(view => view === 'source' || rollFor(view));
  return `<div class="card roll-card"><div class="row"><h3>六角色審核捲軸</h3><span class="meta roll-counts">跨來源和聲 ${kinds.harmony}${unresolved ? `（${unresolved} 待審）` : ''} · 同音重疊 ${kinds.overlap} · 低音擁擠 ${kinds.crowding}</span></div>
    <p class="note">僅供審核定位的視覺化：不是來源、聽感或實機證據。點選只會標出事件並連到既有表單，不會修改或接受任何內容。時間以精確拍數計算，只在畫面上換算成像素。</p>
    ${views.length > 1 ? `<div class="roll-views" role="group" aria-label="捲軸內容">${views.map(view => `<button type="button" class="${view === composer.view ? 'secondary' : 'quiet'}" data-roll-view="${view}" aria-pressed="${view === composer.view}">${ROLL_VIEWS[view]}</button>`).join('')}</div>` : ''}
    ${composer.view === 'accepted' ? '<p class="meta">目前顯示 G11-D 已接受決策鏈的結果投影。Gate 與審核仍以分析候選為準；這不是 VALIDATED。</p>' : composer.view === 'preview' ? '<p class="note">目前顯示的是<strong>決策預覽</strong>：尚未接受，也沒有寫入任何內容。</p>' : ''}
    <div class="roll-toolbar" role="group" aria-label="捲軸顯示">
      <span class="roll-zoom"><span class="meta">時間</span><button type="button" class="quiet" data-roll-zoom="w:-1" aria-label="時間縮小">−</button><button type="button" class="quiet" data-roll-zoom="w:1" aria-label="時間放大">＋</button></span>
      <span class="roll-zoom"><span class="meta">音高</span><button type="button" class="quiet" data-roll-zoom="h:-1" aria-label="音高縮小">−</button><button type="button" class="quiet" data-roll-zoom="h:1" aria-label="音高放大">＋</button></span>
      <span class="roll-lanes">${ROLL_LANES.map((name, i) => `<label class="roll-lane lane-${i}"><input type="checkbox" data-roll-lane="${i}" checked><i aria-hidden="true"></i>${esc(name)} <small>${counts[i]}</small></label>`).join('')}</span>
    </div>
    <div id="review-roll" class="roll-root"></div>
    <p id="roll-info" class="meta roll-info" aria-live="polite">點選音符查看事件 ID 與精確拍數。尺上的標記：▼ 跨來源和聲、◆ 同音重疊、■ 低音擁擠。</p></div>`;
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
    ? `<button type="button" class="quiet" data-open-harmony="${signal.form}">開啟仲裁表單：${esc(signal.label)}${signal.resolved ? '（已記錄）' : ''}</button>`
    : `<span class="roll-signal-note">${esc(signal.label)}（Full6 審核訊號）</span>`;
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
      button.textContent = at >= 0 ? '加入決策選取' : '從決策選取移除';
    };
  };
  reviewRoll = mountReviewRoll(root, roll, {
    marked: composer.eventIds,
    onSelect: event => {
      if (!event) { info.textContent = '未選取事件。'; return; }
      const composable = composerEntry() && !event.id.includes('#g11d-dup:');
      info.innerHTML = `<strong>${esc(event.role ?? '未指派')}</strong> · ${esc(event.pitchName)}（pitch ${event.pitch}）· 拍 <code>${esc(event.start)}</code>–<code>${esc(event.end)}</code><br><code class="digest">${esc(event.id)}</code>${event.signals.length ? `<br>${event.signals.map(signalButton).join(' ')}` : ''}${composable ? `<br><button type="button" class="quiet" data-compose-toggle>${composer.eventIds.includes(event.id) ? '從決策選取移除' : '加入決策選取'}</button>` : ''}`;
      wire();
      if (composable) pick(event);
    },
    onSignal: signal => { info.innerHTML = `審核訊號 · 拍 <code>${esc(signal.start)}</code>–<code>${esc(signal.end)}</code><br>${signalButton(signal)}`; wire(); },
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
const DECISION_TYPES = { ASSIGN_ROLE: '指派角色（未指派 → 角色）', MOVE_ROLE: '移動角色', OMIT_FROM_SIX: '不放入六軌（省略）', DUPLICATE_WITH_JUSTIFICATION: '複製到其他角色（需證據）', KEEP: '保持原樣（記錄已審核）' };
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
  const recorded = records.length ? `<ul class="codes">${records.map(record => { const d = record.decision; return `<li><code>${esc(d.id)}</code> · ${esc(DECISION_TYPES[d.type] ?? d.type)} · ${d.target?.eventIds?.length ?? 0} 個事件${d.fromRole ? ` · ${esc(d.fromRole)}` : ''}${d.toRole ? ` → ${esc(d.toRole)}` : ''}${d.toRoles?.length ? ` → ${esc(d.toRoles.join('、'))}` : ''} · ${esc(d.reason)}</li>`; }).join('')}</ul>` : '<p class="meta">尚未記錄任何編排決策；G11-C 角色候選仍只是建議。</p>';
  const head = `<div class="attempt-head"><h3>編排決策（G11-D）</h3>${badge(chain?.status === 'NOT_REQUESTED' ? 'PENDING' : chain?.status ?? 'PENDING')}</div>
    <p class="meta">在捲軸上選取事件，寫下理由，先預覽再接受。接受的決策只改變 G11-D 編排，不認證任何 Gate，也不是 VALIDATED。</p>${recorded}
    ${records.length ? '<div class="actions"><button type="button" id="clear-decisions" class="quiet">清除所有編排決策</button></div>' : ''}`;
  if (chain && !['NOT_REQUESTED', 'PASS'].includes(chain.status)) return `<div class="card composer-card" id="decision-composer">${head}<p class="note">目前的決策鏈沒有完整套用（${esc(chain.status)}）。請清除決策後依目前來源重新編排。</p></div>`;
  const d = composer.draft;
  const lanes = entry.arrangement.candidate?.lanes ?? [];
  const current = composerPreviewCurrent() ? composer.preview : null;
  const result = current ? `<div class="composer-preview"><div class="attempt-head"><h4>預覽結果</h4>${badge(current.status)}</div>
      ${current.applied.length ? `<p class="meta">${current.applied.map(item => `${item.events.length} 個事件：${[...new Set(item.events.map(e => `${e.fromRole ?? '未指派'} → ${e.toRole ?? '省略'}`))].map(esc).join('、')}`).join('；')}</p>` : ''}
      ${current.diffFromBaseline ? `<p class="meta">相對來源基準：角色移動 ${current.diffFromBaseline.roleMoved ?? 0} · 新增 ${current.diffFromBaseline.noteAdded ?? 0} · 移除 ${current.diffFromBaseline.noteRemoved ?? 0}${current.omitted ? ` · 省略 ${current.omitted}` : ''}</p>` : ''}
      ${[...current.rejected, ...current.conflicts, ...current.diagnostics].length ? `<ul class="codes">${[...current.rejected, ...current.conflicts, ...current.diagnostics].map(item => `<li><code>${esc(item.code ?? item.kind ?? 'NOTE')}</code>${item.message ? ` · ${esc(item.message)}` : ''}${item.eventId ? ` · ${esc(item.eventId)}` : ''}</li>`).join('')}</ul>` : ''}
      <p class="meta">決策 <code>${esc(current.decision.id)}</code> · 審核基準 ${esc(current.reviewedRevisionId ?? 'Source-Faithful Baseline')} · record <code class="digest">${esc(String(current.recordDigest).slice(0, 16))}…</code></p>
      <div class="actions"><button type="button" id="accept-decision" ${current.status === 'PASS' ? '' : 'disabled'}>接受此決策</button>${current.roll ? '<button type="button" class="quiet" data-roll-view="preview">在捲軸上看預覽</button>' : ''}</div></div>` : '';
  return `<div class="card composer-card" id="decision-composer">${head}
    <div class="divider"></div>
    <p><strong>已選取 ${composer.eventIds.length} 個事件</strong>${composer.eventIds.length ? ' <button type="button" class="quiet" id="compose-clear-selection">清除選取</button>' : ''}</p>
    ${lanes.length ? `<label>加入整條 G11-C 聲部<select id="compose-lane"><option value="">選擇聲部…</option>${lanes.map(lane => `<option value="${esc(lane.id)}">${esc(lane.id)} · 建議 ${esc(lane.candidateRole ?? '未定')} · ${lane.eventIds?.length ?? 0} 音</option>`).join('')}</select></label>` : ''}
    <form id="compose-form"><div class="field-grid">
      <label>決策<select name="type">${options(Object.entries(DECISION_TYPES), d.type)}</select></label>
      ${d.type === 'ASSIGN_ROLE' || d.type === 'MOVE_ROLE' ? `<label>目標角色<select name="toRole">${options(roles.map(role => [role, role]), d.toRole)}</select></label>` : ''}
      ${d.type === 'DUPLICATE_WITH_JUSTIFICATION' ? `<fieldset class="compose-roles"><legend>複製到</legend>${roles.map(role => `<label><input type="checkbox" name="toRoles" value="${role}" ${d.toRoles.includes(role) ? 'checked' : ''}> ${role}</label>`).join('')}</fieldset>` : ''}
      <label class="wide">理由（必填）<textarea name="reason" required>${esc(d.reason)}</textarea></label>
      <label>證據（每行一筆${d.type === 'DUPLICATE_WITH_JUSTIFICATION' ? '，必填' : ''}）<textarea name="evidence">${esc(d.evidence)}</textarea></label>
      <label>備註（選填）<input name="note" value="${esc(d.note)}"></label>
    </div><div class="actions"><button type="submit" ${composer.eventIds.length ? '' : 'disabled'}>預覽（不會寫入）</button></div></form>
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
        message(preview.status === 'PASS' ? '預覽完成：尚未寫入。確認後按「接受此決策」。' : `預覽結果為 ${preview.status}，不能接受；原因列在預覽中。`, preview.status !== 'PASS');
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
    if (!composerPreviewCurrent() || !composer.previewDraft) return message('預覽已不是目前的內容，請重新預覽', true);
    const draft = composer.previewDraft, digest = composer.preview.recordDigest;
    run(async () => {
      await commit(await call('acceptPreviewedDecision', workspace, draft, { expectedRecordDigest: digest }));
      composer.eventIds = [];
      composer.view = report.acceptedRoll ? 'accepted' : 'source';
      refreshRoll(); refreshComposer();
      message('已接受並記錄此編排決策；它不認證任何 Gate。');
    });
  };
  const clearAll = $('#clear-decisions');
  if (clearAll) clearAll.onclick = () => run(async () => { await commit(await call('clearAcceptedDecisions', workspace)); message('已清除所有編排決策。'); });
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
      ? `${perRole.map((n, i) => `<span class="${n > PUBLISHED_ROLE_CHARACTER_LIMIT ? 'count-over' : ''}">${roles[i]} ${n}／${PUBLISHED_ROLE_CHARACTER_LIMIT}</span>`).join(' · ')}<br>${P1_CHARACTER_NOTE}`
      : `目前為 ${perRole.length} 個角色；完整字串需要六個固定軌位。`;
  };
  area.addEventListener('input', () => { if (!frame) frame = requestAnimationFrame(paint); });
  paint();
}
// A waiting release is applied only on request, after every queued action has
// run (run() serializes it behind them) and only while the project is saved:
// the reload that follows discards anything that exists only in this tab.
$('#apply-update').onclick=()=>run(async()=>{
  if(workspace&&!workspace.savedAt)throw Error('目前專案尚未儲存。請先匯出專案備份，或排除儲存錯誤後再套用新版。');
  if(!updateFlow?.apply())throw Error('沒有等待套用的新版。');
  applyingUpdate=true;$('#apply-update').disabled=true;message('正在套用新版並重新載入…',true);
},{revisionBound:false,projectBound:false});
function registerServiceWorker(){
  updateFlow=createUpdateFlow({
    serviceWorker:navigator.serviceWorker,
    reload:()=>location.reload(),
    onDownloading:()=>message('新版離線資源下載中…'),
    onOffer:()=>{$('#apply-update').hidden=false;message('新版已下載。目前步驟完成且專案已儲存後，可按「套用新版」重新載入。',true);},
    onStale:()=>{$('#apply-update').hidden=true;message('Studio 已在其他分頁套用新版；此分頁仍是舊版模組，請重新載入後再操作。',true);},
  });
  navigator.serviceWorker.register('./sw.js',{scope:'./'}).then(reg=>{
    updateFlow.attach(reg);
    addEventListener('focus',()=>updateFlow.check());
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')updateFlow.check();});
  }).catch(()=>message('離線資源尚未安裝，請保持連線並重試。',true));
}
// ─── Local library: save state, persistence and whole-library backup ────────
// The sidebar always says whether the open project is saved, how much of the
// browser's quota Studio uses, and whether storage is persistent; persistence
// is requested only when the user asks (Safari may ignore it). "Export all"
// writes every project as its usual backup JSON into one ZIP; restoring a ZIP
// imports each entry through importWorkspace, like a single backup.
$('#persist-storage').onclick=async()=>{const granted=await requestPersistence().catch(()=>null);message(granted===true?'瀏覽器已同意保留本機資料。':granted===false?'瀏覽器沒有同意；請定期匯出備份。':'此瀏覽器不支援保留本機資料；請定期匯出備份。',granted!==true);showSaveState();};
const safeName=value=>String(value||'project').replace(/[\\/:*?"<>|\u0000-\u001f]+/g,'_').slice(0,60);
$('#export-all').onclick=()=>run(async()=>{
  const summaries = await listProjectSummaries();
  const files = [];
  for (const summary of summaries) {
    const full = await loadProject(summary.id);
    files.push({ name: `projects/${safeName(full.title)}-${full.id.slice(0, 8)}.json`, data: new TextEncoder().encode(portableBackup(full, identity.metadata)) });
  }
  if (!files.length) throw Error('沒有可匯出的專案');
  download(`mml-studio-projects-${new Date().toISOString().slice(0, 10)}.zip`, await zipFiles(files), 'application/zip');
  message(`已匯出 ${files.length} 個專案。`);
},{revisionBound:false,projectBound:false});
async function restoreZip(file){
  const entries = (await unzipFiles(await file.arrayBuffer())).filter(entry => entry.name.toLowerCase().endsWith('.json'));
  if (!entries.length) throw Error('ZIP 內沒有專案備份');
  let restored = 0;
  for (const entry of entries) {
    audioFile = null;
    try { await commit(await call('importWorkspace', new TextDecoder().decode(entry.data))); }
    catch (error) { throw Error(`${entry.name}：${error.message}（此前已匯入 ${restored} 個）`); }
    restored += 1;
  }
  message(`已從 ZIP 匯入 ${restored} 個專案；先前審核保留為歷史，本輪需要重新審核。`);
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
  const origin = record.origin?.title ? `來源：Studio「${esc(record.origin.title)}」· ${esc(record.origin.label ?? record.origin.slot ?? '')}（副本）` : '來源：工作坊（非 Studio 副本）';
  return `<div class="card workshop-return"><div class="section-heading"><h2>${esc(UNVERIFIED_LABEL)}</h2>${badge('PENDING')}</div>
    <p class="note">這份六軌 MML 在工作坊編輯，<strong>尚未經 Studio 驗證</strong>。匯入後成為衍生候選（derived），由本頁重新做 MML 技術驗證；先前的審核與接受不會沿用，匯入本身不讓任何 Gate 通過。</p>
    <p class="meta">${origin} · ${record.mml.length} 字元 · ${roles.filter(Boolean).length} 個非空角色</p>
    ${record.warnings.length ? `<ul class="meta">${record.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <label for="workshop-return-mml">工作坊送回的 MML</label><textarea id="workshop-return-mml" class="code" readonly spellcheck="false">${esc(record.mml)}</textarea>
    <div class="actions"><button id="workshop-import">匯入為「${esc(target?.title ?? '目前專案')}」的候選</button><button id="workshop-import-new" class="secondary">新增專案並匯入</button><button id="workshop-discard" class="quiet">捨棄</button></div></div>`;
}
function offerWorkshopReturn() {
  const id = parseReturnHash(location.hash);
  if (!id) return;
  history.replaceState(null, '', location.pathname + location.search);
  const record = takeReturn(id);
  if (!record) return message('工作坊送回的內容已過期或無法讀取；請回到工作坊再送一次。', true);
  const panel = $('#workshop-return');
  const targetId = projects.some(p => p.id === record.origin?.projectId) ? record.origin.projectId : workspace.id;
  const target = projects.find(p => p.id === targetId) ?? { id: workspace.id, title: workspace.title };
  panel.innerHTML = workshopReturnPanel(record, target);
  panel.hidden = false;
  const close = () => { panel.hidden = true; panel.innerHTML = ''; };
  const importInto = project => run(async () => {
    if (project && project.id !== workspace.id) { audioFile = null; await commit(await loadProject(project.id)); }
    else if (!project) { audioFile = null; const fresh = await call('newWorkspace'); fresh.title = record.name || '工作坊編輯'; await commit(fresh); }
    await putSource('candidate', returnFileName(record), record.mml, 'supporting');
    close();
    message(`已匯入為候選（${UNVERIFIED_LABEL}）；請依本頁的技術驗證與審核重新確認。`, true);
  }, { revisionBound: false, projectBound: false });
  $('#workshop-import').onclick = () => importInto(target);
  $('#workshop-import-new').onclick = () => importInto(null);
  $('#workshop-discard').onclick = () => { close(); message('已捨棄工作坊送回的內容。'); };
  panel.scrollIntoView?.({ block: 'start' });
}
async function buildAudit(){ try{ const r=await fetch('./build.json'); if(!r.ok) return null; return (await r.json()).audit??null; } catch { return null; } }
function network(){ $('#network').textContent=navigator.onLine?'本地執行 · Online':'本地執行 · Offline'; }
addEventListener('online',network);addEventListener('offline',network);network();
// ─── Listening sessions ─────────────────────────────────────────────────────
// A listen link (#listen=…) opens its own session beside whatever project is
// open, never plays by itself, and is removed from the address bar once read.
// Notes taken on a session that came from a project are mirrored onto that
// project as plain data (`listeningNotes`), without a revision change: they
// are not evidence and move no gate.
function mirrorListeningNote(projectId,op){
  if(updateFlow?.stale||applyingUpdate)return Promise.reject(Error('Studio 需要重新載入後才能同步備註到專案'));
  return new Promise((resolve,reject)=>{run(async()=>{try{
    const apply=list=>{const notes=sanitizeStoredNotes(list);return op.type==='delete'?notes.filter(note=>note.id!==op.id):[...notes.filter(note=>note.id!==op.note.id),op.note];};
    if(workspace?.id===projectId){workspace=await saveProject({...workspace,listeningNotes:apply(workspace.listeningNotes)});showSaveState();}
    else{const stored=await loadProject(projectId);await saveProject({...stored,listeningNotes:apply(stored.listeningNotes)});}
    resolve();
  }catch(error){reject(error);}},{revisionBound:false,projectBound:false});});
}
listening=createListening({root:$('#listening'),call,message,copyText,audio:listenAudio,saveProjectNote:mirrorListeningNote});
$('#open-listening').onclick=()=>listening.showSessions().catch(error=>message(error.message,true));
listening.importFromLocation().catch(error=>message(error.message,true));
addEventListener('hashchange',()=>listening.importFromLocation().catch(error=>message(error.message,true)));
try {
  identity=await call('identity');
  identity={...identity,provenance:await buildAudit()};
  try { projects=await listProjectSummaries(); } catch(error){message(error.message,true);}
  try { workspace=projects[0]?await loadProject(projects[0].id):null; } catch(error){message(error.message,true);workspace=null;}
  workspace??=await call('newWorkspace');
  $('#boot').hidden=true;$('#app').hidden=false;await run(()=>commit(workspace),{revisionBound:false});
  offerWorkshopReturn();
  if('serviceWorker' in navigator) registerServiceWorker();
} catch(error){$('#boot').textContent=error.message;$('#boot').className='boot-error';$('#boot').hidden=false;$('#app').hidden=true;}
