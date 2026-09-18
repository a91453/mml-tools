import { listProjects, saveProject } from './storage.mjs';
import { createWorkerClient } from './worker-client.mjs';
import { createTaskQueue } from './task-queue.mjs';
// Request identity only. The MIDI decoder, the Canonical conversion and the
// G11-B/G11-C derivation all live behind the Worker, so the main thread never
// imports the backend and never parses a source file itself.
import { createSourceRequestLedger } from './source-requests.mjs';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = value => `<pre>${esc(JSON.stringify(value, null, 2))}</pre>`;
const badge = status => `<span class="badge ${status === 'N/A' ? 'na' : esc(status)}">${esc(status)}</span>`;
const detail = (label, value) => `<details><summary>${esc(label)}</summary>${json(value)}</details>`;
const options = (values, selected) => values.map(([value, label]) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`).join('');
const roles = ['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5'];
const reviewLabels = { source: '來源完整與可追溯', version: 'Version Drift／已接受版本', lead: 'Lead 樂句、休止與接棒', core3: 'Core3 單人完整性', full6: 'Full6 和聲、重疊與密度', tempo: 'Tempo、拍號與時間範圍', audio: '原曲音訊證據', adaptation: 'Mobile 最小適配', regression: '回歸與已接受優點' };
const gateLabels = { finalReductionIntegrity: 'Final 六角色收斂完整性', mobileAdaptationIntegrity: 'Mobile 適配完整性', implementation: '分析模組', source: '來源完整性', baseline: '來源基準', technical: 'MML 技術語法', microTiming: '來源感知微時值（1/64 以下）', core3: 'Core3 來源連續性', core3Completeness: 'Core3 單人完整性（Gate 4）', leadDemotion: 'Lead 降級證據', leadPromotion: 'Lead 升級證據', crossSourceHarmony: '跨來源和聲', versionDrift: '版本差異', originalAudio: '原曲音訊', playerReadback: '播放器實際回讀', pendingDecisions: '待決仲裁', intake: '版本／音樂範圍', lead: 'Lead 審核', full6: 'Full6 審核', tempo: 'Tempo／時值審核', adaptation: 'Mobile 適配', regression: '回歸審核', deliveryIdentity: '交付事件一致性' };
let workspace, report, identity, projects = [], audioFile = null, uploadController = null, busy = 0;
let mobilePreview = null;
let reductionPreview = null;
let reductionDecisions = [];
const queued = createTaskQueue();
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
  projects = await listProjects();
  $('#projects').innerHTML = options(projects.map(p => [p.id, p.title]), workspace?.id);
}
async function commit(next) {
  mobilePreview = null;
  reductionPreview = null;
  reductionDecisions = [];
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
  return `<div class="card"><h3>${title}</h3><p class="meta">${hint}</p>${asset ? `<p><strong>${esc(asset.name)}</strong></p><p class="meta">${esc(asset.format)} · ${asset.project.events.length} events</p>${source}${badge(asset.unsupported.length ? 'UNSUPPORTED' : 'PENDING')} <small>${asset.complete ? '解析完成，等待來源審核' : '來源未完整'}</small>${detail('來源 authority／warnings／unsupported', { sources: asset.project.sources, warnings: asset.warnings, errors: asset.errors, unsupported: asset.unsupported })}` : '<div class="empty">尚未加入來源<br>MusicXML · MML · MIDI · Canonical IR</div>'}<label class="file-button secondary">${asset ? '更換來源' : '選擇檔案'}<input type="file" data-intake="${slot}" accept=".xml,.musicxml,.mml,.txt,.json,.mid,.midi,application/xml,text/xml,text/plain,application/json,audio/midi,audio/x-midi" aria-label="${title}檔案"></label>${asset ? `<button class="quiet" data-download-ir="${slot}">匯出 IR</button>` : ''}</div>`;
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
    <label for="final-mml">完整六軌 Final MML<textarea id="final-mml" class="code final" readonly spellcheck="false">${esc(applied)}</textarea></label>
    <div class="actions"><button id="copy-final">複製完整 Final MML</button><button id="download-final" class="secondary">下載 Final MML</button></div>
    <p class="meta">逐角色內容如下。每個「複製」<strong>只會複製該角色的內容</strong>，不是可直接貼上的完整六軌樂譜。</p>
    ${(report.tracks ?? []).map((track, index) => `<div class="role-body"><div class="row"><label for="final-role-${index}">${roles[index]}${track ? '' : ' <small>（空軌）</small>'}</label><button data-copy-role="${index}" class="quiet" ${track ? '' : 'disabled'}>複製此角色內容</button></div><textarea id="final-role-${index}" class="code" readonly spellcheck="false">${esc(track)}</textarea></div>`).join('')}
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
  return `<table class="reduction-ledger"><thead><tr><th>來源事件</th><th>角色</th><th>原因</th><th>Lead</th><th>Core3</th></tr></thead><tbody>${rows.slice(0, 200).map(item => `<tr>
    <td><code>${esc(item.baselineEventId)}</code><br><span class="muted">${esc((item.sourceEventIds ?? []).join(' · '))}</span></td>
    <td>${esc(item.currentRole ?? '—')} → ${esc(item.proposedRole ?? '—')}</td>
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
    ${plan ? `<p>${badge(plan.status)} · 共 ${a.total} 個來源事件 · 保留 ${a.retained} · 重新分配 ${a.redistributed} · 超出容量 ${a.overflow} · 待決 ${a.pending} · 已接受省略 ${a.omitted}</p>
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
    ${plan ? `<p>${badge(plan.status)} · ${mobilePreview ? `${plan.changes.length} 個音符需調整` : `適配已套用 · ${plan.changes.length} 個音符已調整`}</p>${plan.blockers.length ? detail('無法自動修正的項目', plan.blockers) : ''}${plan.warnings.length ? detail('仍需審核的項目',plan.warnings) : ''}${detail('逐音修改前後',plan.changes)}<p class="meta">套用只建立候選版本，仍需重新審核 Mobile、Core3 與回歸結果。尚未支援樂器指派、鼓面映射、碰撞修復與 G12。</p>` : ''}
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
  </section>`;
}
function render() {
  const r = report, w = workspace, s = w.settings;
  const gates = Object.entries(r.gates ?? {});
  $('#app').innerHTML = `
    <div class="hero"><p class="eyebrow">LOCAL-FIRST / STUDIO V1</p><div class="hero-line"><h1>${esc(w.title)}</h1>${badge(r.state)}</div><p>保留來源、看見差異，再決定如何演奏。你的符號樂譜與審核紀錄在本機處理。</p><div class="state-path"><span class="${r.state === 'CANDIDATE' ? 'current' : ''}">01　Candidate</span><span class="${r.state === 'VALIDATED' ? 'current' : ''}">02　Validated</span><span class="${r.state === 'IN_GAME_ACCEPTED' ? 'current' : ''}">03　In-game Accepted</span></div><p class="meta">${w.savedAt ? `本機已保存 ${esc(new Date(w.savedAt).toLocaleString())}` : '尚未儲存'} · Revision ${w.revision}</p></div>
    <section id="intake"><div class="section-heading"><h2>01　專案與來源</h2><small>裝置本地處理</small></div>
      <div class="card"><form id="settings"><div class="field-grid">${input('title', '專案／歌曲名稱', w.title)}${input('recording', '錄音版本（專輯／MV／Live 等）', s.recording)}${input('offset', '有效音樂起點（秒）', s.offset, 'type="number" min="0" step="any"')}${input('end', '有效音樂終點（秒）', s.end, 'type="number" min="0" step="any"')}<label>來源確認的拍號圖<textarea name="meterText" placeholder="例如：0 4/4&#10;32 3/4">${esc(s.meterText)}</textarea></label><div><label>原曲音訊是否為來源集的一部分？<select name="audioRequired">${options([['unknown','尚未確認'],['yes','是，需要 Audio evidence'],['no','否，本專案沒有原曲音訊']],s.audioRequired)}</select></label><label>本次是否使用驗證播放器？<select name="preview">${options([['unknown','尚未確認'],['none','本次未使用播放器／preview'],['used','有使用，需要實際回讀（v1 尚待支援）']],s.preview)}</select></label></div></div><div class="actions"><button>儲存專案設定</button></div><p class="meta">來源、設定或候選內容變更後，先前審核與實機接受將失效。</p></form></div>
      <div class="row"><p class="meta">MusicXML 與 MIDI 預設為第三方 supporting。只有已確認的官方譜／官方 MIDI 可選 primary symbolic；這只改變來源紀錄，不會讓不完整的來源變完整。</p><select id="authority" aria-label="MusicXML／MIDI 來源權威"><option value="supporting">第三方／未確認</option><option value="primary-symbolic">已確認官方 symbolic</option></select></div>
      <div class="grid intake-grid">${intakeCard('candidate','目前候選','這次要審核的版本')}${intakeCard('baseline','Source-Faithful Baseline','編修之前、可逐事件比對的來源基準')}${intakeCard('previous','已接受的前一版','有歷史版本時，用於回歸比較')}</div>
      <details class="card"><summary>貼上 MML／Canonical IR，或附上交付 MML</summary><form id="paste"><div class="field-grid"><label>用途<select name="slot">${options([['candidate','目前候選'],['baseline','來源基準'],['previous','已接受前版'],['delivery','IR 候選對應的交付 MML']],'candidate')}</select></label>${input('name','檔名','pasted.mml')}</div><label>完整文字<textarea name="content" class="code" required spellcheck="false" placeholder="MML@…,…,…,…,…,…;"></textarea></label><div class="actions"><button>在本機載入</button></div></form></details>
    </section>
    ${rawMidiSection(r.rawMidi)}
    <section id="gates"><div class="section-heading"><h2>03　Analysis Gate</h2><span class="ready-count">${r.blockers?.length ?? 0} 項待處理</span></div><div class="gate-grid">${gates.map(([name,g])=>`<div class="gate"><strong>${esc(gateLabels[name] ?? name)}</strong>${badge(g.status)}<p>${esc(g.reason ?? g.blockers?.join(' · ') ?? '')}</p>${detail('檢查內容',g)}</div>`).join('')}</div><p class="note">技術語法通過只代表 TECHNICAL_PASS。未審核、未知與 unsupported 均不會被升級為 PASS。</p></section>
    <section id="review"><div class="section-heading"><h2>04　比對與審核</h2><small>先看證據，再記錄決策</small></div>
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
    <section id="delivery"><div class="section-heading"><h2>07　Readiness 與實機接受</h2>${badge(r.state)}</div><div class="card"><p class="note">${r.state==='CANDIDATE'?'目前為 Candidate，尚有必要 Gate 未通過。複製內容仍屬候選版本。':r.state==='VALIDATED'?'必要非實機 Gate 已通過。等待使用者於目標遊戲 client 實際接受。':'已有本輪 exact-MML 實機接受紀錄。'}</p><p class="meta">本節記錄的是<strong>實機接受</strong>。產生與匯出 Final MML 在上方第 06 節。「下載六軌對照文字」是含角色標題的<strong>對照用</strong>文字檔，<strong>不是</strong>可直接貼上的樂譜；可貼上的完整字串請用「複製完整 MML@」或第 06 節的匯出。</p><div class="actions"><button id="copy-mml" ${r.rawMml?'':'disabled'}>複製完整 MML@</button><button id="export-mml" class="secondary" ${r.rawMml?'':'disabled'}>下載六軌對照文字</button><button id="export-report" class="quiet">下載分析報告</button></div>${r.tracks?`${r.tracks.map((track,i)=>`<div class="track"><div class="row"><label for="track-${i}">${roles[i]} <small>${track.length} / ${PUBLISHED_ROLE_CHARACTER_LIMIT} 字元</small></label><button data-copy-track="${i}" class="quiet">複製</button></div><textarea id="track-${i}" class="code" readonly spellcheck="false">${esc(track)}</textarea></div>`).join('')}<p class="note">${P1_LOCAL_NOTE}</p>`:'<p class="empty">需有通過 Final 技術語法且與候選事件一致的六軌 MML。MusicXML／IR 不會自動縮編或猜測角色；可在第 06 節產生，或附上對應的交付 MML 進行回讀。</p>'}<details><summary>記錄 In-game Accepted</summary><form id="acceptance"><div class="field-grid">${input('client','Client／地區／版本','')}${input('instrument','樂器與軌道配置','')}${input('evidence','實機結果／截圖或紀錄定位','')}</div><button ${r.state==='CANDIDATE'?'disabled':''}>此 exact-MML 已實機接受</button></form>${w.acceptance?json(w.acceptance):''}</details></div></section>
    <details class="card"><summary>Published Canonical 與建置身分</summary><p class="meta">本機使用建置時由 Published main 取得並核驗的完整固定快照。離線模式不宣稱已確認最新 main。</p>${json(identity.metadata)}${identity.provenance?json(identity.provenance):''}${identity.documents.map(d=>`<details><summary>${esc(d.path)} · ${esc(d.authority)}</summary><a href="${esc(d.url)}" target="_blank" rel="noopener">GitHub 固定快照</a><pre>${esc(d.content)}</pre></details>`).join('')}</details>`;
  bind();
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
    const decisions = reductionDecisions;
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
}

$('#new-project').onclick=()=>run(async()=>{audioFile=null;await commit(await call('newWorkspace'));},{revisionBound:false,projectBound:false});
$('#projects').onchange=()=>{const id=$('#projects').value;run(async()=>{const selected=projects.find(p=>p.id===id);if(!selected)throw Error('找不到選取的專案，請重新開啟');audioFile=null;await commit(selected);},{revisionBound:false,projectBound:false});};
$('#export-project').onclick=()=>{if(workspace)download('mml-studio-project.json',JSON.stringify({...workspace,canonical:identity.metadata},null,2));};
$('#restore-project').onchange=()=>{const file=$('#restore-project').files[0];if(file)run(async()=>{if(file.size>16*1048576)throw Error(`Project backup is ${(file.size/1048576).toFixed(1)} MiB; the restore limit is 16 MiB. Export the sources separately if a MIDI project exceeds it.`);audioFile=null;await commit(await call('importWorkspace',await file.text()));message('已匯入；先前審核保留為歷史，本輪需要重新審核。');},{revisionBound:false,projectBound:false});};
// Build/Git provenance is audit metadata served by build.json, deliberately
// outside the hashed runtime bundle. Display-only: its absence never relaxes
// Canonical verification, which already ran fail-closed inside the worker.
async function buildAudit(){ try{ const r=await fetch('./build.json'); if(!r.ok) return null; return (await r.json()).audit??null; } catch { return null; } }
function network(){ $('#network').textContent=navigator.onLine?'本地執行 · Online':'本地執行 · Offline'; }
addEventListener('online',network);addEventListener('offline',network);network();
try {
  identity=await call('identity');
  identity={...identity,provenance:await buildAudit()};
  try { projects=await listProjects(); } catch(error){message(error.message,true);}
  workspace=projects[0]??await call('newWorkspace');
  $('#boot').hidden=true;$('#app').hidden=false;await run(()=>commit(workspace),{revisionBound:false});
  if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js',{scope:'./'}).then(reg=>{reg.addEventListener('updatefound',()=>message('新版離線資源下載中；關閉所有 Studio 分頁後再開啟可套用。'));}).catch(()=>message('離線資源尚未安裝，請保持連線並重試。',true));
} catch(error){$('#boot').textContent=error.message;$('#boot').className='boot-error';$('#boot').hidden=false;$('#app').hidden=true;}
