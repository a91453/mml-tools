import { createServiceClient } from './client.mjs';
const $ = selector => document.querySelector(selector);
const client = createServiceClient();
let projectId = '', current = null, lastReview = null, busy = false;
const selectionKey = 'mml-service-selection';
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
  $('#start').disabled = busy || !projectId;
  $('#start-existing').disabled = busy || !projectId || !$('#existing-source').value;
  $('#upload-audio').disabled = busy || !projectId;
  $('#review').disabled = busy || !current?.run?.candidate_id;
  $('#handoff').disabled = busy || !current?.run;
  $('#download-final').disabled = busy || current?.run?.state !== 'completed' || !current.run.final_artifact_id || Boolean(current.staleness?.length);
  $('#retry-start').hidden = !saved(attemptKey(projectId))?.asset_id;
}
async function act(fn) {
  if (busy) return;
  busy = true; $('#workspace').setAttribute('aria-busy', 'true');
  const states = [...document.querySelectorAll('button, input, select')].map(element => [element, element.disabled]);
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
  current = result; lastReview = null; $('#review-summary').replaceChildren(); $('#save-review').hidden = true;
  $('#handoff-text').hidden = true;
  const run = result?.run;
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
}
async function loadProject(id, runId = null) {
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
}
$('#login').onclick = () => act(async () => { location.assign(await client.loginURL()); });
$('#logout').onclick = () => act(async () => { try { await client.logout(); } finally { renderRun(null); authView(); } });
$('#open-service').onsubmit = event => { event.preventDefault(); act(async () => {
  const url = new URL(new FormData(event.target).get('origin'));
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('請填入 HTTPS 服務來源網址，不含路徑或憑證');
  location.assign(url.origin + '/studio/');
}); };
$('#create-project').onsubmit = event => { event.preventDefault(); const title = new FormData(event.target).get('title'); act(async () => {
  const result = await client.request('/api/v1/projects', { body: { title } }); await loadProjects(result.project.project_id);
}); };
$('#projects').onchange = () => act(() => loadProject($('#projects').value));
$('#runs').onchange = () => act(() => loadRun($('#runs').value));
$('#refresh').onclick = () => act(() => loadProjects(projectId));
$('#existing-source').onchange = controls;
$('#start').onclick = () => act(async () => {
  const file = $('#midi').files[0]; if (!file || !/\.midi?$/i.test(file.name)) throw Error('請選擇 MIDI 檔案');
  const attempt = { idempotency_key: crypto.randomUUID(), stage: 'upload_requested', filename: file.name };
  save(attemptKey(projectId), attempt); text('#attempt-status', '正在上傳；若回應中斷，先重新讀取來源清單。');
  const uploaded = await client.upload(projectId, file, $('#source-kind').value);
  attempt.asset_id = uploaded.asset.asset_id; save(attemptKey(projectId), { ...attempt, stage: 'uploaded' });
  await startAttempt(attempt);
});
$('#retry-start').onclick = () => act(async () => { const attempt = saved(attemptKey(projectId)); if (!attempt?.asset_id) throw Error('沒有可重用的啟動請求'); await startAttempt(attempt); });
$('#start-existing').onclick = () => act(() => startAttempt({ asset_id: $('#existing-source').value, idempotency_key: crypto.randomUUID() }));
$('#upload-audio').onclick = () => act(async () => { await client.upload(projectId, $('#audio').files[0], 'original_audio'); await loadProject(projectId, current?.run?.run_id); message('已加入原曲音訊；對齊與聽驗仍需另行執行。'); });
$('#review').onclick = () => act(async () => {
  const runId = current.run.run_id, candidate = current.run.candidate_id;
  const result = await client.request(endpoint('/review'), { body: { candidate_id: candidate } });
  const latest = await client.request(endpoint(`/runs/${runId}`));
  if (latest.run.candidate_id !== candidate || latest.staleness?.length) { renderRun(latest); throw Error('候選或來源已改變，請讀取目前任務後重新審查'); }
  lastReview = result; $('#review-summary').replaceChildren();
  detail($('#review-summary'), '候選審查：Gates 與阻塞', { candidate_id: candidate, gates: result.review.gates, blockers: result.review.blockers });
  $('#save-review').hidden = false; message('已重新計算審查；沒有新增人工確認。');
});
$('#save-review').onclick = () => { if (lastReview) download('candidate-review.json', JSON.stringify(lastReview, null, 2)); };
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
} catch (error) { message(error.message); text('#connection-status', '尚未連上服務；本機專案不受影響。'); $('#open-service').hidden = false; }
controls();
