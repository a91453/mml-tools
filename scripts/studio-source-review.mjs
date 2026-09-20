// A private, read-only audition packet. Lane heuristics are never accepted roles.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createStudioApplication } from '../studio/backend/application/index.mjs';

const beat = value => { const [n, d = '1'] = String(value).split('/'); return Number(n) / Number(d); };
export function sectionRanges(events, width = 32) {
  if (!(width > 0) || !Number.isFinite(width)) throw Error('Invalid section width');
  const end = Math.max(0, ...events.map(event => beat(event.end)));
  return Array.from({ length: Math.ceil(end / width) }, (_, i) => ({ start: i * width, end: Math.min(end, (i + 1) * width) }));
}
export function renderSourceReview(packet) {
  const data = JSON.stringify(packet).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>來源聲部核對 · 尚未驗收</title><style>body{font:17px system-ui;max-width:960px;margin:auto;padding:24px;color:#182c37;background:#f5f4ef}section{background:white;border:1px solid #ccc;border-radius:12px;padding:16px;margin:16px 0}button,select,input,textarea{font:inherit;margin:6px;padding:10px;max-width:95%}textarea{display:block;width:90%;min-height:100px}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.muted{color:#536471}label{display:block}</style>
<h1>來源聲部核對</h1><p>這是來源 MIDI 的七條或多條單音線試聽；尚未分配為已接受的 Melody／和弦，也不是 Final MML。合成音色僅供辨認音符，不能代替遊戲音色。</p>
<section><h2>1. 選段與試聽</h2><label>樂譜段落<select id="section"></select></label><label>來源聲部<select id="lane"></select></label><button id="play">播放 MIDI 片段</button><button id="stop">停止</button><p id="playing" aria-live="polite"></p><pre id="identity"></pre></section>
<section><h2>2. 對照原音</h2><audio id="audio" controls src="reference.m4a"></audio><p>先用播放器尋找對應段落。對齊仍未確認，請勿把自動估計當成事實。</p><label>此段原音起點（秒）<input id="offset" type="number" min="0" step="0.1" placeholder="實際確認後填入"></label><button id="original">播放指定原音位置</button></section>
<section><h2>3. 記錄聽到的角色</h2><p>請記錄「哪條聲部在哪一段是主旋律／回應／伴奏／低音」，以及不確定、漏音或對不上的位置。不能判定的部分維持未確認。</p><label>審查者<input id="reviewer" autocomplete="off"></label><textarea id="notes" placeholder="例如：第 1 段，track 0 lane 1 的前半是前奏主線；後半仍需核對。"></textarea><button id="save">保存此段筆記</button><button id="download">下載全部筆記</button><p id="saved" aria-live="polite"></p></section>
<script type="application/json" id="packet">${data}</script><script>
const p=JSON.parse(document.querySelector('#packet').textContent),$=s=>document.querySelector(s),notes={},voices=[];
let ctx,timer; const number=v=>{const [n,d=1]=String(v).split('/');return Number(n)/Number(d)};
const tempos=p.tempo.map(t=>({beat:number(t.beat),bpm:t.bpm})).sort((a,b)=>a.beat-b.beat);
function seconds(b){let out=0;for(let i=0;i<tempos.length&&tempos[i].beat<b;i++)out+=(Math.min(b,tempos[i+1]?.beat??b)-tempos[i].beat)*60/tempos[i].bpm;return out}
p.sections.forEach((s,i)=>$('#section').add(new Option('第 '+(i+1)+' 段 · beat '+s.start+'–'+s.end,i)));
$('#lane').add(new Option('全部來源聲部（保留原始複音）','all'));p.lanes.forEach((l,i)=>$('#lane').add(new Option(l.id+' · '+l.events.length+' 音',i)));
$('#identity').textContent=JSON.stringify(p.binding,null,2);
function stop(){clearTimeout(timer);for(const o of voices.splice(0))try{o.stop()}catch{}$('#audio').pause();$('#playing').textContent='已停止'}
$('#stop').onclick=stop;
$('#play').onclick=async()=>{stop();ctx??=new AudioContext();await ctx.resume();const s=p.sections[$('#section').value],ls=$('#lane').value==='all'?p.lanes:[p.lanes[Number($('#lane').value)]],base=ctx.currentTime+.05;
for(const l of ls)for(const e of l.events){const a=Math.max(s.start,number(e.start)),b=Math.min(s.end,number(e.end));if(b<=a)continue;const o=ctx.createOscillator(),g=ctx.createGain();o.type='triangle';o.frequency.value=440*2**((e.pitch-69)/12);const t=base+seconds(a)-seconds(s.start),duration=seconds(b)-seconds(a);g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(.045,t+Math.min(.008,duration/3));g.gain.setValueAtTime(.045,t+duration-Math.min(.02,duration/3));g.gain.linearRampToValueAtTime(0,t+duration);o.connect(g).connect(ctx.destination);o.start(t);o.stop(t+duration+.01);voices.push(o)}
$('#playing').textContent='正在播放 MIDI 來源片段；沒有寫入審查結果';timer=setTimeout(stop,(seconds(s.end)-seconds(s.start)+.1)*1000)};
$('#original').onclick=async()=>{stop();const raw=$('#offset').value;if(!raw||!Number.isFinite(Number(raw))||Number(raw)<0){$('#playing').textContent='請填實際確認的原音起點';return}$('#audio').currentTime=Number(raw);await $('#audio').play()};
$('#section').onchange=()=>{stop();const n=notes[$('#section').value];$('#notes').value=n?.text??'';$('#offset').value=n?.recording_start_seconds??''};
$('#save').onclick=()=>{if(!$('#notes').value.trim()||!$('#reviewer').value.trim()){$('#saved').textContent='請填審查者與實際筆記';return}notes[$('#section').value]={section:p.sections[$('#section').value],lane:$('#lane').value==='all'?'all':p.lanes[Number($('#lane').value)].id,reviewer:$('#reviewer').value.trim(),text:$('#notes').value.trim(),recording_start_seconds:$('#offset').value?Number($('#offset').value):null};$('#saved').textContent='已保存 '+Object.keys(notes).length+' 段；離開前請下載'};
$('#download').onclick=()=>{const result={schema:'mml-studio/source-review-notes@1',binding:p.binding,reviewed_at:new Date().toISOString(),notes:Object.values(notes),notice:'Human notes only. No confirmations or Canonical verdicts have been recorded.'};const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='source-review-notes.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
</script></html>`;
}

export async function createSourceReview({ application, owner, projectId, runId, outputDirectory }) {
  const status = await application.getRun(owner, projectId, runId);
  if (status.staleness?.length) throw Error('Run is stale');
  const { project } = await application.getProject(owner, projectId);
  const { suggestion } = await application.suggestArrangement(owner, projectId);
  if (suggestion.baseline_id !== status.run.baseline_id) throw Error('Baseline changed');
  const laneIds = [...new Set([...Object.values(suggestion.roles).flatMap(r => r.lane_ids), ...suggestion.pending.lanes.map(l => l.lane_id)])].sort();
  const lanes = [];
  for (const id of laneIds) {
    const events = [];
    for (let offset = 0;; offset += 100) {
      const page = await application.listBaselineEvents(owner, projectId, { laneId: id, offset, limit: 100 });
      events.push(...page.events); if (page.events.length < 100) break;
    }
    lanes.push({ id, events });
  }
  // Tempo is read from the stored source through the existing MIDI adapter.
  const midi = project.assets.find(a => ['official_midi', 'third_party_midi'].includes(a.kind) && status.run.inputs.asset_ids.includes(a.asset_id));
  if (!midi) throw Error('This audition packet currently requires a selected MIDI source');
  const { ingestMIDI } = await import('../studio/backend/source/index.mjs');
  const fragment = ingestMIDI(application.readAssetBytes(owner, projectId, midi.asset_id).bytes, { sourceId: 'review:source', kind: 'third-party-midi', authority: 'supporting' });
  if (!fragment.tempoEvents.some(t => beat(t.beat) === 0)) throw Error('No initial tempo; cannot invent audition timing');
  const events = lanes.flatMap(l => l.events);
  if (events.length !== fragment.events.length || new Set(events.map(e => e.event_id)).size !== events.length) throw Error('Lane packet is not lossless');
  const fresh = await application.getRun(owner, projectId, runId);
  if (fresh.run.revision !== status.run.revision || fresh.staleness?.length) throw Error('Run changed while reading');
  const audio = project.assets.find(a => a.kind === 'original_audio');
  if (audio && !/\.m4a$/i.test(audio.filename)) throw Error('This packet currently supports M4A reference audio only');
  const packet = { schema: 'mml-studio/source-review-packet@1', status: 'REVIEW_REQUIRED',
    binding: { project_id: projectId, run_id: runId, revision: status.run.revision, baseline_id: suggestion.baseline_id, source_sha256: midi.sha256,
      audio_asset_id: audio?.asset_id ?? null, audio_sha256: audio?.sha256 ?? null },
    tempo: fragment.tempoEvents, sections: sectionRanges(events), lanes, note_count: events.length };
  await mkdir(outputDirectory); // never overwrite an earlier review
  if (audio) await writeFile(join(outputDirectory, 'reference.m4a'), application.readAssetBytes(owner, projectId, audio.asset_id).bytes);
  await writeFile(join(outputDirectory, 'packet.json'), JSON.stringify(packet));
  await writeFile(join(outputDirectory, 'index.html'), renderSourceReview(packet));
  return { ...packet.binding, note_count: events.length, lanes: lanes.map(l => ({ id: l.id, note_count: l.events.length })), sections: packet.sections.length, output: resolve(outputDirectory), status: packet.status };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: v } = parseArgs({ options: { 'data-dir': { type: 'string' }, 'project-id': { type: 'string' }, 'run-id': { type: 'string' }, out: { type: 'string' } } });
  for (const key of ['data-dir', 'project-id', 'run-id', 'out']) if (!v[key]) throw Error(`--${key} is required`);
  const app = createStudioApplication({ dataDirectory: join(v['data-dir'], 'store'), durability: 'persistent' });
  console.log(JSON.stringify(await createSourceReview({ application: app, owner: 'local:external-agent', projectId: v['project-id'], runId: v['run-id'], outputDirectory: v.out }), null, 2));
}
