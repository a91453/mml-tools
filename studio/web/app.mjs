import { listProjects, saveProject } from './storage.mjs';
import { createWorkerClient } from './worker-client.mjs';
import { createTaskQueue } from './task-queue.mjs';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = value => `<pre>${esc(JSON.stringify(value, null, 2))}</pre>`;
const badge = status => `<span class="badge ${status === 'N/A' ? 'na' : esc(status)}">${esc(status)}</span>`;
const detail = (label, value) => `<details><summary>${esc(label)}</summary>${json(value)}</details>`;
const options = (values, selected) => values.map(([value, label]) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`).join('');
const roles = ['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5'];
const reviewLabels = { source: '來源完整與可追溯', version: 'Version Drift／已接受版本', lead: 'Lead 樂句、休止與接棒', core3: 'Core3 單人完整性', full6: 'Full6 和聲、重疊與密度', tempo: 'Tempo、拍號與時間範圍', audio: '原曲音訊證據', adaptation: 'Mobile 最小適配', regression: '回歸與已接受優點' };
const gateLabels = { implementation: '分析模組', source: '來源完整性', baseline: '來源基準', technical: 'MML 技術語法', core3: 'Core3', leadDemotion: 'Lead 降級證據', crossSourceHarmony: '跨來源和聲', versionDrift: '版本差異', originalAudio: '原曲音訊', playerReadback: '播放器實際回讀', pendingDecisions: '待決仲裁', intake: '版本／音樂範圍', lead: 'Lead 審核', full6: 'Full6 審核', tempo: 'Tempo／時值審核', adaptation: 'Mobile 適配', regression: '回歸審核', deliveryIdentity: '交付事件一致性' };
let workspace, report, identity, projects = [], audioFile = null, uploadController = null, busy = 0;
const queued = createTaskQueue();
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
function intakeCard(slot, title, hint) {
  const asset = workspace.assets[slot];
  return `<div class="card"><h3>${title}</h3><p class="meta">${hint}</p>${asset ? `<p><strong>${esc(asset.name)}</strong></p><p class="meta">${esc(asset.format)} · ${asset.project.events.length} events</p>${badge(asset.unsupported.length ? 'UNSUPPORTED' : asset.complete ? 'PENDING' : 'PENDING')} <small>${asset.complete ? '解析完成，等待來源審核' : '來源未完整'}</small>${detail('來源 authority／warnings／unsupported', { sources: asset.project.sources, warnings: asset.warnings, errors: asset.errors, unsupported: asset.unsupported })}` : '<div class="empty">尚未加入來源<br>MusicXML · MML · Canonical IR</div>'}<label class="file-button secondary">${asset ? '更換來源' : '選擇檔案'}<input type="file" data-intake="${slot}" accept=".xml,.musicxml,.mml,.txt,.json,application/xml,text/xml,text/plain,application/json" aria-label="${title}檔案"></label>${asset ? `<button class="quiet" data-download-ir="${slot}">匯出 IR</button>` : ''}</div>`;
}
function diffTable(diff) {
  if (!diff) return '<p class="empty">加入來源基準後顯示事件層級差異。</p>';
  return `<div class="scroll"><table><thead><tr><th>新增音</th><th>移除音</th><th>音高／時值／力度修改</th><th>角色移動</th><th>Tempo 變化</th></tr></thead><tbody><tr><td>${diff.summary.noteAdded}</td><td>${diff.summary.noteRemoved}</td><td>${diff.summary.noteModified}</td><td>${diff.summary.roleMoved}</td><td>${diff.summary.tempoChanged + diff.summary.tempoAdded + diff.summary.tempoRemoved}</td></tr></tbody></table></div>${detail('逐事件差異（音高、起訖拍、角色、力度）', diff)}`;
}
function render() {
  const r = report, w = workspace, s = w.settings;
  const gates = Object.entries(r.gates ?? {});
  $('#app').innerHTML = `
    <div class="hero"><p class="eyebrow">LOCAL-FIRST / STUDIO V1</p><div class="hero-line"><h1>${esc(w.title)}</h1>${badge(r.state)}</div><p>保留來源、看見差異，再決定如何演奏。你的符號樂譜與審核紀錄在本機處理。</p><div class="state-path"><span class="${r.state === 'CANDIDATE' ? 'current' : ''}">01　Candidate</span><span class="${r.state === 'VALIDATED' ? 'current' : ''}">02　Validated</span><span class="${r.state === 'IN_GAME_ACCEPTED' ? 'current' : ''}">03　In-game Accepted</span></div><p class="meta">${w.savedAt ? `本機已保存 ${esc(new Date(w.savedAt).toLocaleString())}` : '尚未儲存'} · Revision ${w.revision}</p></div>
    <section id="intake"><div class="section-heading"><h2>01　專案與來源</h2><small>裝置本地處理</small></div>
      <div class="card"><form id="settings"><div class="field-grid">${input('title', '專案／歌曲名稱', w.title)}${input('recording', '錄音版本（專輯／MV／Live 等）', s.recording)}${input('offset', '有效音樂起點（秒）', s.offset, 'type="number" min="0" step="any"')}${input('end', '有效音樂終點（秒）', s.end, 'type="number" min="0" step="any"')}<label>來源確認的拍號圖<textarea name="meterText" placeholder="例如：0 4/4&#10;32 3/4">${esc(s.meterText)}</textarea></label><div><label>原曲音訊是否為來源集的一部分？<select name="audioRequired">${options([['unknown','尚未確認'],['yes','是，需要 Audio evidence'],['no','否，本專案沒有原曲音訊']],s.audioRequired)}</select></label><label>本次是否使用驗證播放器？<select name="preview">${options([['unknown','尚未確認'],['none','本次未使用播放器／preview'],['used','有使用，需要實際回讀（v1 尚待支援）']],s.preview)}</select></label></div></div><div class="actions"><button>儲存專案設定</button></div><p class="meta">來源、設定或候選內容變更後，先前審核與實機接受將失效。</p></form></div>
      <div class="row"><p class="meta">MusicXML 預設為第三方 supporting。只有已確認的官方譜可選 primary symbolic。</p><select id="authority" aria-label="MusicXML 來源權威"><option value="supporting">第三方／未確認</option><option value="primary-symbolic">已確認官方 symbolic</option></select></div>
      <div class="grid intake-grid">${intakeCard('candidate','目前候選','這次要審核的版本')}${intakeCard('baseline','Source-Faithful Baseline','編修之前、可逐事件比對的來源基準')}${intakeCard('previous','已接受的前一版','有歷史版本時，用於回歸比較')}</div>
      <details class="card"><summary>貼上 MML／Canonical IR，或附上交付 MML</summary><form id="paste"><div class="field-grid"><label>用途<select name="slot">${options([['candidate','目前候選'],['baseline','來源基準'],['previous','已接受前版'],['delivery','IR 候選對應的交付 MML']],'candidate')}</select></label>${input('name','檔名','pasted.mml')}</div><label>完整文字<textarea name="content" class="code" required spellcheck="false" placeholder="MML@…,…,…,…,…,…;"></textarea></label><div class="actions"><button>在本機載入</button></div></form></details>
    </section>
    <section id="gates"><div class="section-heading"><h2>02　Analysis Gate</h2><span class="ready-count">${r.blockers?.length ?? 0} 項待處理</span></div><div class="gate-grid">${gates.map(([name,g])=>`<div class="gate"><strong>${esc(gateLabels[name] ?? name)}</strong>${badge(g.status)}<p>${esc(g.reason ?? g.blockers?.join(' · ') ?? '')}</p>${detail('檢查內容',g)}</div>`).join('')}</div><p class="note">技術語法通過只代表 TECHNICAL_PASS。未審核、未知與 unsupported 均不會被升級為 PASS。</p></section>
    <section id="review"><div class="section-heading"><h2>03　比對與審核</h2><small>先看證據，再記錄決策</small></div>
      <div class="card"><h3>Version Drift</h3><p class="review-subtitle">來源基準 → 目前候選。變動數量是診斷資訊。</p>${diffTable(r.lineage?.sourceToCandidate)}<details><summary>已接受前版 → 目前候選</summary>${diffTable(r.lineage?.previousToCandidate)}</details></div>
      <div class="grid"><div class="card"><h3>Lead / Core3</h3><p class="meta">前三軌的 Lead、核心和聲、必要低音／內聲部需能獨立成立。</p>${r.core3 ? detail('連續性、缺口、音域與角色報告',r.core3) : '<p class="empty">等待來源基準</p>'}${detail('Lead 降級證據結果',r.leadReports ?? [])}<div id="core3-changes">${(r.core3?.unapproved ?? []).map((change,index)=>`<form class="conflict" data-core3="${index}"><p class="meta">${esc(change.type)} · ${esc(change.eventId)}</p>${input('reason','保留此變動的正面理由','')}${input('evidence','來源／段落證據','')}<button class="secondary">記錄此變動審核</button></form>`).join('')}</div></div><div class="card"><h3>六軌重疊與密度</h3><p class="meta">全部 15 組跨軌持續同音、低中音摩擦及同步起音皆供審核；不自動刪音。</p>${detail('跨軌檢查',r.technical?.song?.review ?? {status:'PENDING'})}<p class="note">Rashisa 等具名歷史回歸：FIXTURE_PENDING。通用測試成功不代表這些歌曲已通過。</p></div></div>
      <div class="card"><h3>Harmony arbitration</h3><p class="meta">${r.harmony?.unresolvedCount ?? '—'} 項跨來源衝突待審核。保留須有理由及證據；其他方案先記為 PENDING，待候選實際修改後重新比對。</p>${(r.harmony?.conflicts ?? []).map((c,index)=>`<form class="conflict" data-harmony="${index}"><div class="row"><strong>${esc(c.intervalName)} · ${esc(c.leftRole)} / ${esc(c.rightRole)}</strong>${badge(c.resolved?'PASS':'PENDING')}</div><p class="meta">拍 ${esc(c.start)}–${esc(c.end)} · pitch ${c.leftPitch} / ${c.rightPitch}<br>${esc(c.leftEventId)}<br>${esc(c.rightEventId)}</p>${c.resolved?json(c.decision):`<div class="field-grid"><label>決策<select name="action">${options([['pending','仍待審核'],['keep','保留，已核對'],['omit','建議省略'],['move-role','建議移動角色'],['octave','建議改八度'],['redistribute','建議重新分配']],'pending')}</select></label>${input('reason','音樂／角色理由','')}${input('evidence','來源及段落／event 證據','')}</div><button class="secondary">記錄仲裁</button>`}</form>`).join('') || '<p class="empty">目前沒有跨來源衝突報告。Full6 人工審核仍然需要。</p>'}</div>
      ${r.importedDecisions?.length ? `<div class="card"><h3>匯入的仲裁紀錄</h3><p class="meta">舊的 accepted 狀態保留為歷史。本輪需以目前候選重新記錄保留理由。</p>${r.importedDecisions.map((d,index)=>`<form class="conflict" data-imported-decision="${index}">${detail(d.id,d)}${input('reason','目前保留這些事件的理由','')}${input('evidence','本輪來源／段落證據','')}<button class="secondary">確認保留目前事件</button></form>`).join('')}</div>` : ''}
      <details class="card"><summary>Lead 降級的完整證據鏈</summary><form id="lead-form"><div class="field-grid">${input('eventId','來源基準 Melody event ID','')}${input('destinationRole','目標角色（Chord1–Chord5 或 omitted）','')}<label>段落角色<select name="sectionRole">${options(['unknown','vocal-active','vocal-rest','instrumental','intro','interlude','solo','outro'].map(x=>[x,x]),'unknown')}</select></label><label>樂譜角色<select name="scoreClass">${options(['unknown','lead','accompaniment','inner','counter','duplicate'].map(x=>[x,x]),'unknown')}</select></label>${input('scoreCitation','樂譜來源／event／段落證據','')}<label>音訊角色<select name="audioClass">${options(['unknown','foreground','background','mixed'].map(x=>[x,x]),'unknown')}</select></label>${input('audioCitation','音訊來源／時間窗證據（不可用則留空）','')}${input('positiveReason','目標角色的正面理由','')}<label>接棒與 Core3 檢查<select name="continuity"><option value="unknown">尚未確認</option><option value="checked">已確認無 Lead 缺口且 Core3 成立</option></select></label></div><button class="secondary">執行 Lead evidence gate</button></form></details>
      <div class="card"><h3>記錄本輪人工審核</h3><p class="meta">只在已完成對照／聽驗時記錄；原因與證據綁定目前 revision。紀錄不會清除工具找到的未解決缺口或 unsupported。</p><form id="review-form"><div class="field-grid"><label>審核項目<select name="name">${options(Object.entries(reviewLabels),'source')}</select></label>${input('evidence','來源 ID、event、時間窗或實機紀錄','')}<label class="wide">審核結論與理由<textarea name="note" required></textarea></label></div><button>記錄已完成審核</button></form>${Object.entries(w.reviews).map(([name,v])=>`<div class="review-log"><strong>${esc(reviewLabels[name])}</strong> · ${esc(v.note)}<br><span class="muted">${esc(v.evidence)}</span></div>`).join('')}</div>
    </section>
    <section id="audio"><div class="section-heading"><h2>04　Audio evidence</h2><small>僅主動要求時上傳</small></div><div class="card"><p class="note safe">選取音訊只會留在本機。按下「要求 Audio Alignment」才會傳送該音訊及候選的衍生音符／時間特徵；MusicXML／MML 原始文字不會上傳。</p><p id="audio-file-status" class="meta">${audioFile?esc(`${audioFile.name} · ${(audioFile.size/1048576).toFixed(1)} MiB · 尚未上傳`):'未選取音訊。雲端未連線。'}</p><label class="file-button secondary">選擇 M4A／FLAC／WAV<input id="audio-file" type="file" accept=".m4a,.flac,.wav,audio/mp4,audio/flac,audio/wav"></label><details><summary>Audio Worker 連線（選用）</summary><label>HTTPS alignment endpoint<input id="audio-endpoint" type="url" placeholder="https://your-worker.example/align" autocomplete="off"></label><label>本次工作階段 access token<input id="audio-token" type="password" autocomplete="off"></label><p class="meta">Token 僅存於目前畫面記憶體。v1 沒有預設雲端服務；未設定時保持 PENDING。</p></details><div class="actions"><button id="request-audio" ${!audioFile || !w.assets.candidate?'disabled':''}>要求 Audio Alignment</button><button id="cancel-audio" class="quiet" ${uploadController?'':'disabled'}>取消上傳／等待</button><label class="file-button quiet">匯入既有 alignment report<input id="audio-report" type="file" accept=".json,application/json"></label></div><div id="audio-progress" role="status"></div>${detail('音訊證據、控制點、信心與漂移',w.audio?.report ?? {status:'PENDING',reason:'SONG_AUDIO_EVIDENCE_MISSING'})}<p class="meta">Audio evidence 不會修改、刪除或重排 symbolic events。信心分數本身不代表音高真值。</p></div></section>
    <section id="delivery"><div class="section-heading"><h2>05　Readiness 與交付</h2>${badge(r.state)}</div><div class="card"><p class="note">${r.state==='CANDIDATE'?'目前為 Candidate，尚有必要 Gate 未通過。複製內容仍屬候選版本。':r.state==='VALIDATED'?'必要非實機 Gate 已通過。等待使用者於目標遊戲 client 實際接受。':'已有本輪 exact-MML 實機接受紀錄。'}</p><div class="actions"><button id="copy-mml" ${r.rawMml?'':'disabled'}>複製完整 MML@</button><button id="export-mml" class="secondary" ${r.rawMml?'':'disabled'}>下載六軌文字</button><button id="export-report" class="quiet">下載分析報告</button></div>${r.tracks?r.tracks.map((track,i)=>`<div class="track"><div class="row"><label for="track-${i}">${roles[i]} <small>${track.length} / 2400</small></label><button data-copy-track="${i}" class="quiet">複製</button></div><textarea id="track-${i}" class="code" readonly spellcheck="false">${esc(track)}</textarea></div>`).join(''):'<p class="empty">需有通過 Final 技術語法且與候選事件一致的六軌 MML。MusicXML／IR 不會自動縮編或猜測角色；可附上對應的交付 MML 進行回讀。</p>'}<details><summary>記錄 In-game Accepted</summary><form id="acceptance"><div class="field-grid">${input('client','Client／地區／版本','')}${input('instrument','樂器與軌道配置','')}${input('evidence','實機結果／截圖或紀錄定位','')}</div><button ${r.state==='CANDIDATE'?'disabled':''}>此 exact-MML 已實機接受</button></form>${w.acceptance?json(w.acceptance):''}</details></div></section>
    <details class="card"><summary>Published Canonical 與建置身分</summary><p class="meta">本機使用建置時由 Published main 取得並核驗的完整固定快照。離線模式不宣稱已確認最新 main。</p>${json(identity.metadata)}${json(identity.provenance)}${identity.documents.map(d=>`<details><summary>${esc(d.path)} · ${esc(d.authority)}</summary><a href="${esc(d.url)}" target="_blank" rel="noopener">GitHub 固定快照</a><pre>${esc(d.content)}</pre></details>`).join('')}</details>`;
  bind();
}
async function putSource(slot, name, content, authority = 'supporting') {
  if (slot === 'delivery') { const next = await call('invalidate',workspace); next.deliveryMml = content; await commit(next); return; }
  const asset = await call('intake', { name, content, id: crypto.randomUUID(), meterText: workspace.settings.meterText, authority });
  const next = await call('invalidate',workspace); next.assets[slot] = asset;
  await commit(next);
}
async function copyText(value, textarea) {
  try { await navigator.clipboard.writeText(value); message('已複製'); }
  catch { if (textarea) { textarea.focus(); textarea.select(); } else { const box=document.createElement('textarea');box.value=value;$('#delivery').append(box);box.focus();box.select(); } message('Safari 未授予剪貼簿權限。已選取文字，可長按複製。',true); }
}
function bind() {
  $('#settings').onsubmit = event => { event.preventDefault(); const data=Object.fromEntries(new FormData(event.target)); run(async()=>{
    const next=await call('invalidate',workspace); next.title=data.title; const {title,...settings}=data; next.settings=settings;
    if(settings.meterText!==workspace.settings.meterText) for(const [slot,a] of Object.entries(next.assets)) if(a.format==='MML') next.assets[slot]=await call('intake',{name:a.name,content:a.content,id:a.project.sources[0].id,meterText:settings.meterText});
    await commit(next);
  },{revisionBound:false}); };
  document.querySelectorAll('[data-intake]').forEach(input=>input.onchange=()=>{const file=input.files[0],authority=$('#authority').value;if(file)run(async()=>{if(file.size>4194304)throw Error('UNSUPPORTED: symbolic file exceeds 4 MiB');await putSource(input.dataset.intake,file.name,await file.text(),authority);},{revisionBound:false});});
  document.querySelectorAll('[data-download-ir]').forEach(button=>button.onclick=()=>{const asset=workspace.assets[button.dataset.downloadIr];download('canonical-project.json',JSON.stringify(asset.project,null,2));});
  $('#paste').onsubmit=event=>{event.preventDefault();const data=Object.fromEntries(new FormData(event.target)),authority=$('#authority').value;run(()=>putSource(data.slot,data.name,data.content,authority),{revisionBound:false});};
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
  $('#lead-form').onsubmit=event=>{event.preventDefault();const d=Object.fromEntries(new FormData(event.target));run(async()=>{
    if(![...roles.slice(1),'omitted'].includes(d.destinationRole))throw Error('目標角色必須為 Chord1–Chord5 或 omitted');const event=workspace.assets.baseline?.project.events.find(e=>e.id===d.eventId&&e.role==='Melody');if(!event)throw Error('找不到基準 Melody event');
    const next=structuredClone(workspace);next.acceptance=null;next.leadEvidence=next.leadEvidence.filter(e=>e.eventId!==event.id);next.leadEvidence.push({eventId:event.id,destinationRole:d.destinationRole,sourceIdentity:{sourceId:event.sourceIds[0],sourceEventId:event.sourceEventIds[0]},sectionRole:d.sectionRole,scoreEvidence:{availability:d.scoreCitation?'available':'unavailable',classification:d.scoreClass,citation:d.scoreCitation},audioEvidence:{availability:d.audioCitation?'available':'unavailable',classification:d.audioClass,citation:d.audioCitation},positiveReason:d.positiveReason,continuity:{checked:d.continuity==='checked',createsLeadGap:d.continuity==='checked'?false:null,replacementEventIds:[]},core3:{checked:d.continuity==='checked',status:d.continuity==='checked'?'PASS':'PENDING'},revision:workspace.revision});await commit(next);
  });};
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
  $('#copy-mml').onclick=()=>copyText(report.rawMml);
  document.querySelectorAll('[data-copy-track]').forEach(button=>button.onclick=()=>{const i=Number(button.dataset.copyTrack);copyText(report.tracks[i],$(`#track-${i}`));});
  $('#export-mml').onclick=()=>download('six-track-mml.txt',`${report.rawMml}\n\n${report.tracks.map((t,i)=>`${roles[i]}\n${t}`).join('\n\n')}`,'text/plain');
  $('#export-report').onclick=()=>download('studio-analysis.json',JSON.stringify({canonical:identity.metadata,provenance:identity.provenance,revision:workspace.revision,...report},null,2));
  $('#acceptance').onsubmit=event=>{event.preventDefault();const data=Object.fromEntries(new FormData(event.target));run(async()=>commit(await call('recordAcceptance',workspace,data)));};
}

$('#new-project').onclick=()=>run(async()=>{audioFile=null;await commit(await call('newWorkspace'));},{revisionBound:false,projectBound:false});
$('#projects').onchange=()=>{const id=$('#projects').value;run(async()=>{const selected=projects.find(p=>p.id===id);if(!selected)throw Error('找不到選取的專案，請重新開啟');audioFile=null;await commit(selected);},{revisionBound:false,projectBound:false});};
$('#export-project').onclick=()=>{if(workspace)download('mml-studio-project.json',JSON.stringify({...workspace,canonical:identity.metadata},null,2));};
$('#restore-project').onchange=()=>{const file=$('#restore-project').files[0];if(file)run(async()=>{if(file.size>16*1048576)throw Error('Project backup exceeds 16 MiB');audioFile=null;await commit(await call('importWorkspace',await file.text()));message('已匯入；先前審核保留為歷史，本輪需要重新審核。');},{revisionBound:false,projectBound:false});};
function network(){ $('#network').textContent=navigator.onLine?'本地執行 · Online':'本地執行 · Offline'; }
addEventListener('online',network);addEventListener('offline',network);network();
try {
  identity=await call('identity');
  try { projects=await listProjects(); } catch(error){message(error.message,true);}
  workspace=projects[0]??await call('newWorkspace');
  $('#boot').hidden=true;$('#app').hidden=false;await run(()=>commit(workspace),{revisionBound:false});
  if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js',{scope:'./'}).then(reg=>{reg.addEventListener('updatefound',()=>message('新版離線資源下載中；關閉所有 Studio 分頁後再開啟可套用。'));}).catch(()=>message('離線資源尚未安裝，請保持連線並重試。',true));
} catch(error){$('#boot').textContent=error.message;$('#boot').className='boot-error';$('#boot').hidden=false;$('#app').hidden=true;}
