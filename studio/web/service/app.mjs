import { createServiceClient } from './client.mjs';
const $ = selector => document.querySelector(selector);
const client = createServiceClient();
let projectId = '', current = null, lastReview = null, busy = false;
let mobilePreview = null, reviewBinding = null;
let agentEnabled = false, agentTask = null, agentTimer = null;
const mobileRoles = ['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5'];
const selectionKey = 'mml-service-selection';
// The last service address typed here (a per-viewer convenience only).
const originKey = 'mml-service-origin';
const attemptKey = id => `mml-service-start:${id}`;
const text = (selector, value) => { $(selector).textContent = value; };
const message = value => text('#message', value);
const saved = key => { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } };
const save = (key, value) => sessionStorage.setItem(key, JSON.stringify(value));
const endpoint = tail => `/api/v1/projects/${projectId}${tail}`;
function fillSelect(selector, rows, selected, empty) {
  const select = $(selector); select.replaceChildren();
  if (!rows.length) select.add(new Option(empty, ''));
  for (const [value, label] of rows) select.add(new Option(label, value));
  if (rows.some(row => row[0] === selected)) select.value = selected;
}
function download(name, value, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function authView() {
  const signedIn = client.authenticated();
  $('#workspace').hidden = !signedIn; $('#logout').hidden = !signedIn; $('#login').hidden = signedIn;
  text('#connection-status', signedIn ? '已登入；專案與外部 agent 使用同一個服務。' : '請登入服務以開啟專案。');
}
function controls() {
  $('#agent-auto').disabled = busy || !agentEnabled;
  $('#agent-start').disabled = busy || !agentEnabled || !current?.run || current.run.state === 'completed' || agentTask?.state === 'running';
  $('#agent-stop').disabled = busy || !current?.run || agentTask?.state !== 'running';
  $('#start').disabled = busy || !projectId;
  $('#start-existing').disabled = busy || !projectId || !$('#existing-source').value;
  $('#upload-audio').disabled = busy || !projectId;
  $('#upload-extra').disabled = busy || !projectId;
  $('#review').disabled = busy || !current?.run?.candidate_id;
  $('#handoff').disabled = busy || !current?.run;
  $('#download-final').disabled = busy || current?.run?.state !== 'completed' || !current.run.final_artifact_id || Boolean(current.staleness?.length);
  $('#retry-start').hidden = !saved(attemptKey(projectId))?.asset_id;
  const mobileReady = mobileAvailable();
  $('#mobile-preview').disabled = busy || !mobileReady;
  $('#mobile-apply').disabled = busy || !mobileReady || mobilePreview?.plan.status !== 'PASS';
  $('#gate8-submit').disabled = busy || !mobileReady || !reviewBinding;
}
function mobileAvailable() {
  const run = current?.run;
  return Boolean(run?.candidate_id && run.state !== 'completed' && !run.report_artifact_id && !run.pending_step
    && !current.staleness?.length && run.steps.some(step => step.step === 'final_reduction' && ['completed', 'skipped'].includes(step.status)));
}
const binding = () => ({ projectId, runId: current.run.run_id, revision: current.run.revision, candidateId: current.run.candidate_id });
async function requireCurrent(expected) {
  if (projectId !== expected.projectId || current?.run?.run_id !== expected.runId) throw Error('專案或任務已切換，請重新讀取');
  const latest = await client.request(endpoint(`/runs/${expected.runId}`));
  if (latest.staleness?.length || latest.run.revision !== expected.revision || latest.run.candidate_id !== expected.candidateId) {
    renderRun(latest); throw Error('候選、來源或任務 revision 已變動，請重新預覽／審查');
  }
}
const evidenceLines = selector => $(selector).value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
function readMobileProfile() {
  const roles = {};
  for (const role of mobileRoles) {
    const value = field => $(`#mobile-${role}-${field}`).value.trim();
    const integer = field => {
      const raw = value(field);
      if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw Error(`${role} 的數值必須是整數`);
      return Number(raw);
    };
    const rule = {};
    if (value('low') || value('high')) rule.pitchRange = [integer('low'), integer('high')];
    if (value('default')) rule.defaultVolume = integer('default');
    if (value('delta')) rule.volumeDelta = integer('delta');
    if (Object.keys(rule).length) roles[role] = rule;
  }
  return { schema: 'mml-studio/mobile-adaptation-profile@1', id: $('#mobile-profile-id').value.trim(),
    reason: $('#mobile-reason').value.trim(), evidence: evidenceLines('#mobile-evidence'), roles };
}
function clearMobilePreview() { mobilePreview = null; $('#mobile-plan').replaceChildren(); controls(); }
async function act(fn) {
  if (busy) return;
  busy = true; $('#workspace').setAttribute('aria-busy', 'true');
  const states = [...document.querySelectorAll('button, input, select, textarea')].map(element => [element, element.disabled]);
  for (const [element] of states) element.disabled = true;
  message('');
  try { await fn(); } catch (error) { message(error.message); if (error.authentication) authView(); }
  finally { busy = false; for (const [element, disabled] of states) element.disabled = disabled; $('#workspace').setAttribute('aria-busy', 'false'); controls(); }
}
function detail(parent, title, value, className = '') {
  const node = document.createElement('details'); node.className = className;
  const summary = document.createElement('summary'); summary.textContent = title;
  const pre = document.createElement('pre'); pre.textContent = JSON.stringify(value, null, 2);
  node.append(summary, pre); parent.append(node);
}
function renderRun(result) {
  if (!result) { clearTimeout(agentTimer); agentTask = null; $('#agent-recovery').hidden = true; text('#agent-status', '選擇歌曲任務後查看 agent 狀態。'); }
  current = result; lastReview = null; $('#review-summary').replaceChildren(); $('#save-review').hidden = true;
  mobilePreview = null; reviewBinding = null; $('#mobile-plan').replaceChildren();
  $('#mobile-review-form').reset();
  $('#handoff-text').hidden = true;
  const run = result?.run;
  text('#mobile-context', run?.candidate_id ? `審查候選：${run.candidate_id} · revision ${run.revision}${mobileAvailable() ? '' : '；請先完成角色／六軌分配，或讀取尚未結案的有效任務。'}` : '尚無可適配候選。');
  text('#run-state', run?.state ?? '尚未啟動');
  text('#run-identity', run ? `${run.run_id} · revision ${run.revision}` : '');
  text('#halt', run ? `${run.halt?.reason ?? '流程已回傳'}${result.staleness?.length ? '；輸入已變動，不能沿用舊結果。' : ''}` : '選擇來源後啟動任務。');
  text('#run-json', result ? JSON.stringify(result, null, 2) : '');
  $('#steps').replaceChildren(); $('#requests').replaceChildren(); $('#proposals').replaceChildren();
  for (const step of run?.steps ?? []) { const li = document.createElement('li'); li.textContent = `${step.step} — ${step.status}`; $('#steps').append(li); }
  for (const request of run?.review_requests ?? []) detail($('#requests'), `${request.code}${request.gate ? ` · ${request.gate}` : ''}`, request, 'request');
  controls();
}
async function loadRun(id) {
  clearTimeout(agentTimer); agentTask = null;
  if (!id) { renderRun(null); return; }
  const result = await client.request(endpoint(`/runs/${id}`)); renderRun(result);
  save(selectionKey, { project_id: projectId, run_id: id });
  const proposals = await client.request(endpoint(`/proposals?run_id=${encodeURIComponent(id)}`));
  for (const proposal of proposals.proposals ?? []) {
    const button = document.createElement('button'); button.className = 'secondary proposal';
    button.textContent = `${proposal.kind} · ${proposal.state} · ${proposal.proposal_id}`;
    button.onclick = () => act(async () => {
      const full = await client.request(endpoint(`/proposals/${proposal.proposal_id}`));
      detail($('#proposals'), `提案紀錄 ${proposal.proposal_id}`, full);
    });
    $('#proposals').append(button);
  }
  if (!proposals.proposals?.length) text('#proposals', '目前沒有提案。');
  await loadAgent(projectId, id);
}
async function loadAgent(observedProject, observedRun) {
  const result = await client.request(`/api/v1/projects/${observedProject}/runs/${observedRun}/agent`);
  if (projectId !== observedProject || current?.run?.run_id !== observedRun) return;
  agentTask = result.task;
  $('#agent-recovery').hidden = !agentTask?.pending_action;
  text('#agent-pending', agentTask?.pending_action ? JSON.stringify(agentTask.pending_action, null, 2) : '');
  text('#agent-status', !result.enabled ? '此服務尚未啟用自動 agent。可使用外部接續資訊。'
    : agentTask ? `${agentTask.state} · ${agentTask.reason} · 已執行 ${agentTask.steps} 步` : '可啟動自動 agent；缺少來源或審查依據時會停下。');
  controls();
  clearTimeout(agentTimer);
  if (agentTask?.state === 'running') agentTimer = setTimeout(() => {
    if (!client.authenticated() || projectId !== observedProject || current?.run?.run_id !== observedRun) return;
    loadAgent(observedProject, observedRun).catch(error => { text('#agent-status', error.message); });
  }, 2000);
}
async function startAgent() {
  const id = current?.run?.run_id, observedProject = projectId;
  if (!id) return;
  const latest = await client.request(endpoint(`/runs/${id}`));
  if (projectId !== observedProject || current?.run?.run_id !== id) throw Error('任務已切換');
  const key = `mml-agent-start:${observedProject}:${id}`;
  const prior = saved(key);
  // Keep the exact request across an uncertain response; never mint a new job by retrying blindly.
  const request = prior ?? { expected_run_revision: latest.run.revision, idempotency_key: crypto.randomUUID(), authorization: 'reversible-proposals' };
  save(key, request);
  try { await client.request(endpoint(`/runs/${id}/agent`), { body: request }); }
  catch (error) { if (!error.uncertain) sessionStorage.removeItem(key); throw error; }
  sessionStorage.removeItem(key);
  await loadAgent(observedProject, id);
  message('Agent 已啟動；可在下方查看停止原因。完成後重新讀取任務以查看候選與輸出。');
}
$('#agent-start').onclick = () => act(startAgent);
$('#agent-stop').onclick = () => act(async () => {
  await client.request(endpoint(`/runs/${current.run.run_id}/agent/stop`), { body: {} });
  await loadAgent(projectId, current.run.run_id);
});
$('#agent-reconcile').onclick = () => act(async () => {
  const id = current?.run?.run_id, pending = agentTask?.pending_action;
  if (!id || !pending) throw Error('沒有待核對的 agent 操作');
  const latest = await client.request(endpoint(`/runs/${id}`));
  await client.request(endpoint(`/runs/${id}/agent/reconcile`), { body: {
    pending_action_fingerprint: pending.fingerprint, expected_run_revision: latest.run.revision,
    inspected: true, reason: $('#agent-recovery-reason').value.trim(),
  } });
  $('#agent-recovery-reason').value = ''; await loadRun(id);
});
async function loadProject(id, runId = null) {
  if (projectId !== id) $('#mobile-profile-form').reset();
  projectId = id; renderRun(null); text('#project-identity', id || '尚無服務專案');
  if (!id) { fillSelect('#runs', [], '', '尚無 run'); fillSelect('#existing-source', [], '', '尚無來源'); controls(); return; }
  const [project, runs] = await Promise.all([client.request(endpoint('')), client.request(endpoint('/runs'))]);
  fillSelect('#existing-source', project.project.assets.filter(asset => ['official_midi', 'third_party_midi'].includes(asset.kind)).map(asset => [asset.asset_id, `${asset.filename} · ${asset.asset_id}`]), '', '尚無 MIDI');
  fillSelect('#runs', runs.runs.map(run => [run.run_id, `${run.state} · ${run.run_id}`]), runId ?? saved(selectionKey)?.run_id, '尚無 run');
  const attempt = saved(attemptKey(id)); text('#attempt-status', attempt ? `上次啟動階段：${attempt.stage}。先核對服務現況。` : '');
  save(selectionKey, { project_id: id, run_id: $('#runs').value || null });
  await loadRun($('#runs').value); controls();
}
async function loadProjects(preferred) {
  agentEnabled = (await client.request('/api/v1/agent')).enabled;
  const result = await client.request('/api/v1/projects');
  fillSelect('#projects', result.projects.map(project => [project.project_id, project.title]), preferred ?? saved(selectionKey)?.project_id, '尚無專案');
  await loadProject($('#projects').value);
}
async function startAttempt(attempt) {
  save(attemptKey(projectId), { ...attempt, stage: 'start_requested' });
  const result = await client.request(endpoint('/runs'), { body: { asset_ids: [attempt.asset_id], idempotency_key: attempt.idempotency_key } });
  sessionStorage.removeItem(attemptKey(projectId));
  await loadProject(projectId, result.run.run_id);
  message('任務已啟動。請查看停下原因，並把接續資訊交給外部 agent。');
  if ($('#agent-auto').checked && agentEnabled) await startAgent();
}
$('#login').onclick = () => act(async () => { location.assign(await client.loginURL()); });
$('#logout').onclick = () => act(async () => { clearTimeout(agentTimer); try { await client.logout(); } finally { renderRun(null); authView(); } });
$('#open-service').onsubmit = event => { event.preventDefault(); act(async () => {
  const url = new URL(new FormData(event.target).get('origin'));
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('請填入 HTTPS 服務來源網址，不含路徑或憑證');
  try { localStorage.setItem(originKey, url.origin); } catch {}
  location.assign(url.origin + '/studio/');
}); };
$('#create-project').onsubmit = event => { event.preventDefault(); const title = new FormData(event.target).get('title'); act(async () => {
  const result = await client.request('/api/v1/projects', { body: { title } }); await loadProjects(result.project.project_id);
}); };
$('#projects').onchange = () => act(() => loadProject($('#projects').value));
$('#runs').onchange = () => act(() => loadRun($('#runs').value));
$('#refresh').onclick = () => act(() => loadProjects(projectId));
$('#existing-source').onchange = controls;
// The service refuses a media type it does not list rather than guess a
// parser from it (asset-service.mjs). Browsers report platform types it does
// not list -- Windows names a MIDI file audio/mid, and .aac/.ogg/.webm
// recordings arrive as audio/aac, audio/ogg, audio/webm -- so a picked file is
// declared with a listed type, as the MusicXML branch below already does. The
// declaration is metadata only: intake reads the bytes, and the asset kind is
// what the owner chose.
const AUDIO_TYPES_THE_SERVICE_LISTS = new Set(['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/mpeg', 'audio/flac', 'audio/x-flac', 'audio/wav', 'audio/x-wav']);
const withType = (file, type) => (file && file.type !== type ? new File([file], file.name, { type }) : file);
const midiFile = file => withType(file, 'audio/midi');
const audioFile = file => (file && !AUDIO_TYPES_THE_SERVICE_LISTS.has(file.type) ? withType(file, 'application/octet-stream') : file);
$('#start').onclick = () => act(async () => {
  const file = $('#midi').files[0]; if (!file || !/\.midi?$/i.test(file.name)) throw Error('請選擇 MIDI 檔案');
  const attempt = { idempotency_key: crypto.randomUUID(), stage: 'upload_requested', filename: file.name };
  save(attemptKey(projectId), attempt); text('#attempt-status', '正在上傳；若回應中斷，先重新讀取來源清單。');
  const uploaded = await client.upload(projectId, midiFile(file), $('#source-kind').value);
  attempt.asset_id = uploaded.asset.asset_id; save(attemptKey(projectId), { ...attempt, stage: 'uploaded' });
  await startAttempt(attempt);
});
$('#retry-start').onclick = () => act(async () => { const attempt = saved(attemptKey(projectId)); if (!attempt?.asset_id) throw Error('沒有可重用的啟動請求'); await startAttempt(attempt); });
$('#start-existing').onclick = () => act(() => startAttempt({ asset_id: $('#existing-source').value, idempotency_key: crypto.randomUUID() }));
$('#upload-extra').onclick = () => act(async () => {
  const file = $('#extra-source').files[0], kind = $('#extra-kind').value;
  const musicxml = kind.endsWith('_musicxml');
  if (!file || !(musicxml ? /\.(musicxml|xml|mxl)$/i : /\.midi?$/i).test(file.name)) throw Error(musicxml ? '請選擇 MusicXML（.musicxml、.xml 或壓縮的 .mxl）' : '請選擇 MIDI 檔案');
  // A .musicxml file often carries a vendor type (or none) that the service does
  // not list; the bytes are XML text either way. A compressed .mxl is declared
  // as the MusicXML archive type; the service reads which one it is from the
  // bytes, not from this declaration.
  const declared = /\.mxl$/i.test(file.name) ? 'application/vnd.recordare.musicxml' : 'application/xml';
  const uploaded = await client.upload(projectId, musicxml ? new File([file], file.name, { type: declared }) : midiFile(file), kind);
  await loadProject(projectId, current?.run?.run_id);
  message(`已加入來源 ${uploaded.asset.asset_id}；尚未啟動任務，也不代表來源已被採用。`);
});
$('#upload-audio').onclick = () => act(async () => { await client.upload(projectId, audioFile($('#audio').files[0]), 'original_audio'); await loadProject(projectId, current?.run?.run_id); message('已加入原曲音訊；對齊與聽驗仍需另行執行。'); });
$('#review').onclick = () => act(async () => {
  const observed = binding(); reviewBinding = null;
  const runId = current.run.run_id, candidate = current.run.candidate_id;
  const result = await client.request(endpoint('/review'), { body: { candidate_id: candidate } });
  const latest = await client.request(endpoint(`/runs/${runId}`));
  if (latest.run.revision !== observed.revision || latest.run.candidate_id !== candidate || latest.staleness?.length) { renderRun(latest); throw Error('候選或來源已改變，請讀取目前任務後重新審查'); }
  lastReview = result; reviewBinding = observed; $('#review-summary').replaceChildren();
  detail($('#review-summary'), '候選審查：Gates 與阻塞', { candidate_id: candidate, gates: result.review.gates, blockers: result.review.blockers });
  detail($('#review-summary'), '來源／上一版本差異與已記錄的候選審查', { lineage: result.review.lineage, confirmations: result.review.confirmations, stale_confirmations: result.review.stale_confirmations });
  $('#save-review').hidden = false; message('已重新計算審查；沒有新增人工確認。');
});
$('#save-review').onclick = () => { if (lastReview) download('candidate-review.json', JSON.stringify(lastReview, null, 2)); };
for (const role of mobileRoles) {
  const fieldset = document.createElement('fieldset'), legend = document.createElement('legend');
  legend.textContent = role; fieldset.append(legend);
  for (const [field, labelText, min, max] of [['low', '最低音高', 0, 107], ['high', '最高音高', 0, 107], ['default', '未決音量的設定值', 0, 15], ['delta', '音量增減', -15, 15]]) {
    const label = document.createElement('label'), input = document.createElement('input');
    label.textContent = labelText; input.id = `mobile-${role}-${field}`; input.type = 'number'; input.step = '1'; input.min = min; input.max = max;
    label.append(input); fieldset.append(label);
  }
  $('#mobile-roles').append(fieldset);
}
$('#mobile-profile-form').oninput = clearMobilePreview;
$('#mobile-profile-form').onsubmit = event => { event.preventDefault(); act(async () => {
  if (!mobileAvailable()) throw Error('請先完成角色與六軌分配');
  const observed = binding(), profile = readMobileProfile(), acceptedBy = $('#mobile-reviewer').value.trim();
  if (!acceptedBy) throw Error('請填入接受者名稱');
  clearMobilePreview(); await requireCurrent(observed);
  const result = await client.request(endpoint('/mobile-adaptation/plan'), { body: { candidate_id: observed.candidateId, profile } });
  await requireCurrent(observed);
  mobilePreview = { binding: observed, profile, acceptedBy, plan: result.adaptation.plan };
  detail($('#mobile-plan'), `Mobile 預覽：${mobilePreview.plan.status}`, result.adaptation.plan);
  message(mobilePreview.plan.status === 'PASS' ? '預覽可執行；請檢查事件變化後接受。Gate 8 仍需另行審查。' : '預覽有阻塞，請依報告修正資料或補充證據。');
}); };
$('#mobile-apply').onclick = () => act(async () => {
  const preview = mobilePreview;
  if (!mobileAvailable() || preview?.plan.status !== 'PASS' || JSON.stringify(readMobileProfile()) !== JSON.stringify(preview.profile)
    || $('#mobile-reviewer').value.trim() !== preview.acceptedBy) { clearMobilePreview(); throw Error('請先重新預覽目前的 profile'); }
  await requireCurrent(preview.binding);
  // Resume uses the existing reviewer path, keeping the adaptation on this run.
  // Invalidate the local acceptance before sending: an uncertain response must
  // be inspected, not retried as a second relative adaptation.
  clearMobilePreview(); reviewBinding = null;
  await client.request(endpoint(`/runs/${preview.binding.runId}/resume`), { body: {
    expected_run_revision: preview.binding.revision, idempotency_key: crypto.randomUUID(),
    mobile_adaptation: { profile: preview.profile, expected_plan_id: preview.plan.id, accepted_by: preview.acceptedBy },
  } });
  await loadRun(preview.binding.runId); message('已接續任務。請核對 Mobile 階段結果，並重新計算候選審查。');
  if ($('#agent-auto').checked && agentEnabled && current.run.state !== 'completed') await startAgent();
});
$('#mobile-review-form').onsubmit = event => { event.preventDefault(); act(async () => {
  const observed = reviewBinding, outcome = $('#gate8-outcome').value;
  const reviewer = $('#gate8-reviewer').value.trim(), reason = $('#gate8-reason').value.trim(), evidence = evidenceLines('#gate8-evidence');
  if (!mobileAvailable() || !observed || !lastReview) throw Error('請先重新計算目前候選審查');
  if (!reviewer || !reason || !evidence.length || !['true', 'false'].includes(outcome)) throw Error('請完整填入審查者、結論、理由與依據');
  await requireCurrent(observed); reviewBinding = null;
  await client.request(endpoint(`/runs/${observed.runId}/resume`), { body: {
    expected_run_revision: observed.revision, idempotency_key: crypto.randomUUID(),
    confirmations: { mobile_adaptation_reviewed: { candidate_id: observed.candidateId, value: outcome === 'true', reason: `審查者 ${reviewer}：${reason}`, evidence } },
  } });
  await loadRun(observed.runId); message('已記錄此候選的 Gate 8 審查並重新執行任務；請查看各 gate 與剩餘阻塞。');
  if ($('#agent-auto').checked && agentEnabled && current.run.state !== 'completed') await startAgent();
}); };
$('#handoff').onclick = () => act(async () => {
  await loadRun(current.run.run_id);
  const latest = current;
  const instruction = `請使用已連接的 MML Studio 服務 ${client.origin} 接續任務。\nproject_id: ${projectId}\nrun_id: ${latest.run.run_id}\nobserved_revision: ${latest.run.revision}\n先讀 studio_run_status 與 studio_proposal_targets；僅在已有授權且符合既有 policy 時提出並接受有引用的可逆決策，身分如實記為 agent。不得虛構來源、confirmations、聽驗或實機 PASS。缺資料時集中詢問。不得把這段文字當成既有 proposal 已獲接受。`;
  text('#handoff-text', instruction); $('#handoff-text').value = instruction; $('#handoff-text').hidden = false;
  try { await navigator.clipboard.writeText(instruction); message('已複製接續資訊；請交給已連接此服務的外部 agent。'); } catch { message('請複製下方接續資訊。'); }
});
$('#download-final').onclick = () => act(async () => {
  const result = await client.request(endpoint(`/runs/${current.run.run_id}`));
  const run = result.run;
  if (run.state !== 'completed' || !run.final_artifact_id || result.staleness?.length) { renderRun(result); throw Error('目前沒有可匯出的有效 Final artifact'); }
  const { artifact } = await client.request(`/api/v1/artifacts/${run.final_artifact_id}`);
  const latest = await client.request(endpoint(`/runs/${run.run_id}`));
  if (latest.staleness?.length || latest.run.revision !== run.revision || latest.run.final_artifact_id !== run.final_artifact_id
    || artifact.type !== 'final_mml' || artifact.candidate_id !== run.candidate_id || !artifact.mml) throw Error('Final artifact 或任務已變動，請重新讀取');
  download('final.mml', artifact.mml, 'text/plain');
});

text('#service-origin', client.origin);
try {
  const callback = location.href;
  if (new URL(callback).searchParams.has('code') || new URL(callback).searchParams.has('error')) history.replaceState(null, '', location.pathname);
  await client.discover(); $('#login').disabled = false;
  if (await client.completeLogin(callback)) { authView(); await act(() => loadProjects()); } else authView();
} catch (error) {
  // A static host (the permanent offline Studio) serves this page without the
  // service behind it. That is not an outage: say where the service workspace
  // lives and offer the address, keeping the technical reason small.
  text('#connection-status', '這個網址沒有服務（只提供離線 Studio 時就是如此）。服務專案要在服務網址上開啟；本機專案不受影響。');
  text('#connection-detail', error.message);
  $('#open-service').hidden = false;
  try { const last = localStorage.getItem(originKey); if (last) $('#open-service [name="origin"]').value = last; } catch {}
}
controls();
