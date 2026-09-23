import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { serveStudio } from '../../scripts/serve-studio-web.mjs';
import { installWorkerControls, runAuditChecks } from './audit.mjs';
import { runRawMidiChecks } from './raw-midi.mjs';
import { runFinalDeliveryChecks } from './final-delivery.mjs';
import { runMobileAdaptationChecks } from './mobile-adaptation.mjs';
import { runFinalReductionChecks } from './final-reduction.mjs';
import { runLibraryChecks, runLibraryMigrationCheck } from './library.mjs';
import { runPlayerReadbackChecks } from './player-readback.mjs';
import { runDecisionComposerChecks } from './decision-composer.mjs';
import { runListeningChecks } from './listening.mjs';
import { runDefaultBankChecks } from './default-bank.mjs';
import { DEFAULT_BANK_UPSTREAM } from '../web/preview/default-bank.mjs';
import { runWorkshopChecks } from './workshop.mjs';

// A browser build that is not installed is neither a pass nor a failed
// assertion, so it is recorded as NOT_RUN with its reason rather than being
// skipped quietly. The run still fails on it unless the caller says otherwise,
// which keeps CI -- where every engine is installed -- honest.
const executable = { chromium: process.env.STUDIO_BROWSER_CHROMIUM, webkit: process.env.STUDIO_BROWSER_WEBKIT };
const allowMissingEngine = process.env.STUDIO_BROWSER_ALLOW_MISSING === '1';

let server=null;
const results=[];
const mml='MML@t120o4c1,t120o3e1,t120o2c1,,,;';
const mxml='<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note><barline><repeat direction="backward"/></barline></measure></part></score-partwise>';
const out=new URL('../browser-results/',import.meta.url);
await mkdir(out,{recursive:true});
let failed=false;
try {
  for(const profile of [
    {name:'iphone-webkit',engine:webkit,engineName:'webkit',viewport:{width:390,height:844},isMobile:true,hasTouch:true},
    {name:'ipad-webkit',engine:webkit,engineName:'webkit',viewport:{width:820,height:1180},isMobile:true,hasTouch:true},
    {name:'desktop-chromium',engine:chromium,engineName:'chromium',viewport:{width:1440,height:1000}},
  ]) {
    let browser,page,context;
    const errors=[],requests=[];
    // One origin per profile, so the offline restart can be proven by killing
    // the server rather than by a browser offline emulation.
    server=await serveStudio({port:0});
    const base=`http://127.0.0.1:${server.address().port}`;
    try {
      try{browser=await profile.engine.launch(executable[profile.engineName]?{executablePath:executable[profile.engineName]}:{});}
      catch(error){throw Object.assign(Error(error.message),{engineMissing:true});}
      context=await browser.newContext({viewport:profile.viewport,isMobile:profile.isMobile,hasTouch:profile.hasTouch});
      // Never the real network: this context should never ask for the free
      // default bank at all (the no-external-request check below says so); its
      // download is exercised in a context of its own (default-bank.mjs).
      await context.route(DEFAULT_BANK_UPSTREAM.url,route=>route.abort('blockedbyclient'));
      page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push({url:r.url(),method:r.method()}));
      // aria-busy false is a claim that what is on screen is settled, so a gate
      // still reading ANALYSIS_RUNNING at that moment is the app contradicting
      // itself -- a failed or abandoned analysis leaving its placeholder behind
      // with no further render coming. Watch for it across the whole run, over
      // reloads, rather than at one assertion point.
      await page.addInitScript(()=>{
        new MutationObserver(()=>{
          const app=document.querySelector('#app');
          if(!app||app.getAttribute('aria-busy')==='true'||!app.textContent.includes('ANALYSIS_RUNNING'))return;
          try{sessionStorage.setItem('settledWhileRunning',String(Number(sessionStorage.getItem('settledWhileRunning')||0)+1));}catch{}
        }).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-busy']});
      });
      await installWorkerControls(page);
      const idle=()=>page.waitForFunction(()=>document.querySelector('#app')?.getAttribute('aria-busy')!=='true'&&document.querySelector('#app h1'));
      const file=async(slot,content,name)=>{await page.locator(`[data-intake="${slot}"]`).setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from(content)});await page.waitForFunction(name=>document.querySelector('#intake')?.textContent.includes(name),name);await idle();};
      await page.goto(base);await page.locator('#app h1').waitFor();await idle();
      assert.equal(await page.locator('#copy-mml').isEnabled(),false);
      // iPhone/iPad grey out an .xml an accept list does not map; the bytes decide the reader.
      assert.deepEqual(await page.locator('[data-intake]').evaluateAll(inputs=>inputs.filter(input=>input.hasAttribute('accept')).map(input=>input.dataset.intake)),[],'source pickers carry no accept list');
      await page.screenshot({path:fileURLToPath(new URL(`${profile.name}-empty.png`,out)),fullPage:true});
      await page.getByLabel('專案／歌曲名稱',{exact:true}).fill('Studio browser fixture');
      await page.getByLabel('錄音版本（專輯／MV／Live 等）',{exact:true}).fill('Synthetic studio v1');
      await page.getByLabel('有效音樂起點（秒）',{exact:true}).fill('0');
      await page.getByLabel('有效音樂終點（秒）',{exact:true}).fill('2');
      await page.getByLabel('來源確認的拍號圖',{exact:true}).fill('0 4/4');
      await page.locator('[name="audioRequired"]').selectOption('no');
      await page.locator('[name="preview"]').selectOption('none');
      await page.getByRole('button',{name:'儲存專案設定',exact:true}).click();await page.locator('h1').filter({hasText:'Studio browser fixture'}).waitFor();await idle();
      // Serialization: while the candidate commit owns one busy window, fire two
      // distinct file choices in a deterministic order. Both change events must
      // observe aria-busy=true and both must survive the render that replaces the
      // inputs. A child-list observer records when each queued file first becomes
      // visible, making FIFO an integration assertion rather than just final-state
      // membership. The old single-slot implementation rejects the second waiter.
      await page.evaluate(content=>{
        const names=['queued-baseline.mml','queued-previous.mml'];
        window.queuedIntake={armed:true,fired:[],busyAtDispatch:[],appliedOrder:[]};
        const recordApplied=()=>{
          const text=document.querySelector('#intake')?.textContent??'';
          for(const name of names) if(text.includes(name)&&!window.queuedIntake.appliedOrder.includes(name)) window.queuedIntake.appliedOrder.push(name);
        };
        new MutationObserver(recordApplied).observe(document,{subtree:true,childList:true});
        new MutationObserver(()=>{
          if(!window.queuedIntake.armed||document.querySelector('#app')?.getAttribute('aria-busy')!=='true')return;
          const actions=[['baseline',names[0]],['previous',names[1]]];
          const inputs=actions.map(([slot])=>document.querySelector(`[data-intake="${slot}"]`));
          if(inputs.some(input=>!input))return;
          window.queuedIntake.armed=false;
          actions.forEach(([slot,name],index)=>{
            window.queuedIntake.busyAtDispatch.push(document.querySelector('#app')?.getAttribute('aria-busy')==='true');
            const transfer=new DataTransfer();
            transfer.items.add(new File([content],name,{type:'text/plain'}));
            inputs[index].files=transfer.files;
            inputs[index].dispatchEvent(new Event('change'));
            window.queuedIntake.fired.push(`${slot}:${name}`);
          });
        }).observe(document,{subtree:true,attributes:true,attributeFilter:['aria-busy']});
      },mml);
      await page.locator('[data-intake="candidate"]').setInputFiles({name:'candidate.mml',mimeType:'text/plain',buffer:Buffer.from(mml)});
      await page.waitForFunction(()=>window.queuedIntake?.fired.length===2);
      assert.deepEqual(await page.evaluate(()=>window.queuedIntake.busyAtDispatch),[true,true],'both waiter file actions must be dispatched inside the same busy window');
      assert.deepEqual(await page.evaluate(()=>window.queuedIntake.fired),['baseline:queued-baseline.mml','previous:queued-previous.mml'],'waiter actions must enter serialization in the intended order');
      await idle();
      assert.deepEqual(await page.evaluate(()=>window.queuedIntake.appliedOrder),['queued-baseline.mml','queued-previous.mml'],'queued intake actions must be applied in FIFO order');
      const intakeCards=page.locator('#intake .intake-grid .card');
      assert.equal(await intakeCards.nth(0).locator('strong').textContent(),'candidate.mml','the in-flight intake still applies');
      assert.equal(await intakeCards.nth(1).locator('strong').textContent(),'queued-baseline.mml','the first waiter is applied to the baseline slot');
      assert.equal(await intakeCards.nth(2).locator('strong').textContent(),'queued-previous.mml','the second waiter is applied to the previous slot instead of being dropped');
      assert.equal(await page.locator('#copy-mml').isEnabled(),true);
      assert.equal(await page.locator('.hero .badge').textContent(),'CANDIDATE');
      assert.equal(await page.locator('#track-3').inputValue(),'');
      for(const name of ['source','version','lead','core3','full6','tempo','adaptation','regression']) {
        await page.locator('#review-form [name="name"]').selectOption(name);
        await page.locator('#review-form [name="evidence"]').fill('synthetic fixture: full piece');
        await page.locator('#review-form [name="note"]').fill(`Reviewed ${name}`);
        await page.getByRole('button',{name:'記錄已完成審核',exact:true}).click();
        await page.locator('.review-log').filter({hasText:`Reviewed ${name}`}).waitFor();await idle();
      }
      assert.equal(await page.locator('.hero .badge').textContent(),'VALIDATED');
      // G10 C2B: the source-aware micro-timing gate is user-facing, so it must
      // render as its own card with an honest badge and its structured
      // diagnostics -- never silently omitted, and never folded into the MML
      // technical gate, which answers a different question.
      const microTiming=page.locator('#gates .gate').filter({hasText:'來源感知微時值'});
      assert.equal(await microTiming.count(),1,'the source-aware micro-timing gate must be rendered');
      assert.equal(await page.locator('#gates .gate').filter({hasText:'MML 技術語法'}).count(),1,'the MML technical gate stays a separate card');
      assert.equal(await microTiming.locator('.badge').textContent(),'PASS','this fixture has no sub-grid interval');
      for(const field of ['candidateCount','sourceSupportedCount','technicalResidueCount','unknownCount','unresolvedStreamIssueCount']) assert.ok((await microTiming.textContent()).includes(field),`the micro-timing gate must surface ${field}`);
      await page.getByText('記錄 In-game Accepted',{exact:true}).click();
      await page.locator('#acceptance [name="client"]').fill('Synthetic controlled test only');
      await page.locator('#acceptance [name="instrument"]').fill('three-role piano');
      await page.locator('#acceptance [name="evidence"]').fill('not a real game certification');
      await page.getByRole('button',{name:'此 exact-MML 已實機接受',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('.hero .badge')?.textContent==='IN_GAME_ACCEPTED');await idle();
      // Check clipboard invocation + exact payload; permission itself is OS-specific.
      await page.evaluate(()=>{window.copied=null;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copied=text;}}});});
      await page.locator('#copy-mml').click();assert.equal(await page.evaluate(()=>window.copied),mml);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal viewport overflow');
      await page.screenshot({path:fileURLToPath(new URL(`${profile.name}-reviewed.png`,out)),fullPage:true});
      // Boot must announce aria-busy; otherwise its
      // ANALYSIS_RUNNING placeholder is indistinguishable from a settled result:
      // a restored VALIDATED/IN_GAME_ACCEPTED project reads as demoted to
      // CANDIDATE until the real analysis lands, and idle() has nothing to wait
      // on. Record the transition rather than racing it.
      await page.addInitScript(()=>{window.bootAnnouncedBusy=false;new MutationObserver(()=>{if(document.querySelector('#app')?.getAttribute('aria-busy')==='true')window.bootAnnouncedBusy=true;}).observe(document,{subtree:true,attributes:true,attributeFilter:['aria-busy']});});
      await page.reload();await page.locator('#app h1').waitFor();await idle();
      assert.equal(await page.evaluate(()=>window.bootAnnouncedBusy),true,'boot analysis must announce aria-busy before showing a state');
      assert.equal(await page.locator('.hero .badge').textContent(),'IN_GAME_ACCEPTED');
      await runFinalDeliveryChecks({page,idle,file,mml});
      await runFinalReductionChecks({page,idle,file,screenshot:()=>page.locator('#final-reduction').screenshot({path:fileURLToPath(new URL(`${profile.name}-final-reduction.png`,out))})});
      await runMobileAdaptationChecks({page,idle,file,screenshot:()=>page.locator('#mobile-adaptation').screenshot({path:fileURLToPath(new URL(`${profile.name}-mobile-adaptation.png`,out))})});
      await runAuditChecks({page,idle,file,mml});
      await runRawMidiChecks({page,idle,base,requests,screenshot:name=>page.screenshot({path:fileURLToPath(new URL(`${profile.name}-${name}.png`,out)),fullPage:true})});
      await runLibraryChecks({page,idle});
      await runLibraryMigrationCheck({browser,base});
      await runDefaultBankChecks({browser,base,profile});
      await runPlayerReadbackChecks({page,idle,file});
      await runListeningChecks({page,base});
      await runDecisionComposerChecks({page,idle,screenshot:()=>page.locator('#review').screenshot({path:fileURLToPath(new URL(`${profile.name}-decision-composer.png`,out))})});
      await runWorkshopChecks({page,base,idle,file,profile,screenshot:name=>page.screenshot({path:fileURLToPath(new URL(`${profile.name}-${name}.png`,out))})});
      // A revision change invalidates all reviews/acceptance before re-analysis.
      await file('candidate',mml.replace('o4c1','o4d1'),'changed.mml');assert.equal(await page.locator('.hero .badge').textContent(),'CANDIDATE');
      await page.locator('#audio-file').setInputFiles({name:'original.wav',mimeType:'audio/wav',buffer:Buffer.from('synthetic audio')});
      await page.locator('#audio-file-status').filter({hasText:'尚未上傳'}).waitFor();
      // The status line renders before the audio invalidation commit settles, and
      // subsequent assertions need the audio invalidation commit to settle.
      await idle();
      assert.ok(requests.every(r=>r.method==='GET'&&r.url.startsWith(base)),'Symbolic intake and audio selection cause no upload or external request');
      await file('baseline',mxml.replace('<score-partwise>','<score-partwise xmlns:m="urn:fixture">').replace('<repeat ', '<m:repeat '),'repeat.musicxml');assert.ok((await page.locator('#gates').textContent()).includes('UNSUPPORTED'));
      // Service worker must cache the actual module graph for offline restart.
      await page.evaluate(()=>navigator.serviceWorker.ready);
      await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);
      // Take the origin away instead of emulating offline: whatever renders now
      // was served by the service worker out of its own cache.
      server.closeAllConnections();await new Promise(closed=>server.close(closed));
      await page.reload();await page.locator('#app h1').waitFor();await idle();
      assert.equal(await page.locator('.hero .badge').textContent(),'CANDIDATE');
      assert.ok((await page.locator('#gates').textContent()).includes('UNSUPPORTED'));
      assert.equal(await page.evaluate(()=>Number(sessionStorage.getItem('settledWhileRunning')||0)),0,'aria-busy must never go false with a gate still reading ANALYSIS_RUNNING');
      assert.deepEqual(errors,[]);
      results.push({profile:profile.name,status:'PASS',checks:['Files picker','Final generation panel','exact Final copy/download/display identity','role-body copy labelled','clipboard fallback exact string','attempt vs applied delivery separated','P1 character-count disclaimer','superseded Final not copyable','refused attempt beside valid pasted delivery','whole-score exports agree','pasted-whitespace delivery exports agree','Final reduction preview is read-only','reduction accounting buckets visible','pending reduction material never presented as applied','event-level reduction decision accepted','reduction apply certifies no gate','reduction IndexedDB reload','re-preview carries the applied decisions','reduction rollback to parent candidate','local MML/MusicXML','full review workflow','state separation','exact clipboard payload','IndexedDB reload','boot busy signal','busy-window two-waiter FIFO','boot waiter drain','project-scoped queue','stable Core3 evidence IDs','Worker failure and recovery','unsaved failure state','IndexedDB stale-token rejection','Final pitch boundary','settled state never ANALYSIS_RUNNING','source-aware micro-timing gate visible','revision invalidation','unsupported fail closed','no implicit uploads','responsive layout','offline module graph','Raw MIDI file picker','binary intake and source digest','Raw MIDI section structure','Core3 vs Full6 separation','percussion visible and never pitched','byte-exact IndexedDB reload','exact rational timing through the browser','superseded MIDI request discarded','malformed MIDI fails visibly','same-file reselect after failure','no Raw MIDI upload','save-state indicator','whole-library ZIP export and restore','IndexedDB v1 to v2 migration','player readback through the real engine','incomplete playback not recordable','free default bank: nothing downloaded on page load','first play shows the download notice and progress','downloaded bank and derived subset verified by SHA-256','default bank plays labelled, with the 11 game instrument names','cached subset replays after reload with no second request','altered or unreachable default bank refused with a visible message','user bank overrides the default bank','listen link import without autoplay','listen link cleared from the address bar','listening session separate from projects','play from bar/time/marker through the real scheduler','stop and replay from the same point','changed bars and A/B ranged playback','listening notes, copy for AI and project mirroring','listening session deletion','decision composer preview writes nothing','previewed decision accepted exactly','accepted decision moves no gate','workshop opens a Studio MML as a copy','workshop language switch keeps the score','workshop dark/light theme on load','workshop roll edit with undo/redo','workshop 3MLE export/import','workshop WAV export through the render worker','workshop video preview','workshop edit returns as an unverified derived candidate']});
    } catch(error) {
      if(error.engineMissing){
        results.push({profile:profile.name,engine:profile.engineName,status:'NOT_RUN',reason:error.message.split('\n')[0]});
        if(!allowMissingEngine)failed=true;
        continue;
      }
      failed=true;results.push({profile:profile.name,status:'FAIL',error:error.stack,consoleErrors:errors});
      if(page)await page.screenshot({path:fileURLToPath(new URL(`${profile.name}-failure.png`,out)),fullPage:true}).catch(()=>{});
    } finally {if(browser)await browser.close();if(server.listening){server.closeAllConnections();server.close();}}
  }
} finally {if(server?.listening){server.closeAllConnections();server.close();}}
await writeFile(new URL('results.json',out),JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
// The JSON above runs to hundreds of lines; name what did not pass last.
for(const r of results.filter(r=>r.status!=='PASS')){
  const message=String(r.error??r.reason??'').split('\n')[0];
  console.log(`${r.status} ${r.profile}: ${message}`);
  if(r.status==='FAIL'&&process.env.GITHUB_ACTIONS==='true')console.log(`::error title=Browser profile ${r.profile} failed::${message.replace(/%/g,'%25')}`);
}
if(failed)process.exitCode=1;
