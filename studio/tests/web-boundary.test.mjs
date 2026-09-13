import test from 'node:test';
import assert from 'node:assert/strict';
import { requestAudioAlignment } from '../web/audio-client.mjs';
import { newWorkspace, intake, analyzeWorkspace, recordReview, REVIEW_NAMES } from '../web/model.mjs';

const mml='MML@t120o4c1,t120o3e1,t120o2c1,,,;';
const project = intake({name:'local-only.mml',content:mml,id:'source',meterText:'0 4/4'}).project;
test('audio requires explicit intent, file type, HTTPS endpoint and credentials before a network request',async()=>{
  let calls=0;const fetcher=async()=>{calls++;};
  const base={requested:true,file:new File(['test'],'original.wav'),project,endpoint:'https://worker.example/align',token:'session-token',fetcher};
  for(const args of [{...base,requested:false},{...base,endpoint:'http://worker.example/align'},{...base,token:''},{...base,file:new File(['test'],'original.exe')}]) await assert.rejects(requestAudioAlignment(args));
  assert.equal(calls,0);
});
test('explicit audio payload excludes source text and validates audio identity without mutating events',async()=>{
  const before=JSON.stringify(project);const file=new File(['test'],'original.wav');
  const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(n=>n.toString(16).padStart(2,'0')).join('');
  const report={schema:'mabinogi-mobile-mml-studio/audio-alignment@1',audio:{sha256:sha},symbolic:{project_id:project.id},evidence_policy:{changes_symbolic_truth:false},alignment:{control_points:[{beat:0,seconds:0},{beat:4,seconds:2}],metrics:{confidence:1,score_frame_coverage:1,audio_frame_coverage:1}}};
  const fetcher=async(url,options)=>{
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.method,'POST');
    const bytes=new Uint8Array(await options.body.arrayBuffer());const size=Number(options.headers['X-Project-Bytes']);const payload=new TextDecoder().decode(bytes.slice(0,size));
    assert.ok(!payload.includes(mml));assert.ok(!payload.includes('local-only.mml'));assert.equal(JSON.parse(payload).sources,undefined);
    return new Response(JSON.stringify(report),{status:200});
  };
  await requestAudioAlignment({requested:true,file,project,endpoint:'https://worker.example/align',token:'session-token',fetcher});
  assert.equal(JSON.stringify(project),before);
  report.audio.sha256='0'.repeat(64);
  await assert.rejects(requestAudioAlignment({requested:true,file,project,endpoint:'https://worker.example/align',token:'session-token',fetcher}),/AUDIO_IDENTITY_MISMATCH/);
});
test('imported accepted decisions remain pending until reviewed in this revision',()=>{
  let w=newWorkspace();w.title='fixture';w.settings={meterText:'0 4/4',recording:'synthetic',offset:'0',end:'2',audioRequired:'no',preview:'none'};
  const candidate=structuredClone(project);candidate.decisions=[{id:'imported',eventIds:[candidate.events[0].id],action:'keep',status:'accepted',reason:'old decision',evidence:[],metadata:{}}];
  w.assets.candidate=intake({name:'candidate.json',content:JSON.stringify(candidate),id:'candidate'});
  w.assets.baseline=intake({name:'baseline.mml',content:mml,id:'baseline',meterText:'0 4/4'});
  for(const name of REVIEW_NAMES)w=recordReview(w,name,'reviewed','synthetic source');
  assert.equal(analyzeWorkspace(w).gates.pendingDecisions.status,'PENDING');
  assert.equal(analyzeWorkspace(w).state,'CANDIDATE');
});
