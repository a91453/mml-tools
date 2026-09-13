import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { serveStudio } from '../../scripts/serve-studio-web.mjs';

let server=null;
const results=[];
const mml='MML@t120o4c1,t120o3e1,t120o2c1,,,;';
const mxml='<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note><barline><repeat direction="backward"/></barline></measure></part></score-partwise>';
const out=new URL('../browser-results/',import.meta.url);
await mkdir(out,{recursive:true});
let failed=false;
try {
  for(const profile of [
    {name:'iphone-webkit',engine:webkit,viewport:{width:390,height:844},isMobile:true,hasTouch:true},
    {name:'ipad-webkit',engine:webkit,viewport:{width:820,height:1180},isMobile:true,hasTouch:true},
    {name:'desktop-chromium',engine:chromium,viewport:{width:1440,height:1000}},
  ]) {
    let browser,page,context;
    const errors=[],requests=[];
    // One origin per profile, so the offline restart can be proven by killing
    // the server rather than by a browser offline emulation.
    server=await serveStudio({port:0});
    const base=`http://127.0.0.1:${server.address().port}`;
    try {
      browser=await profile.engine.launch();
      context=await browser.newContext({viewport:profile.viewport,isMobile:profile.isMobile,hasTouch:profile.hasTouch});
      page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push({url:r.url(),method:r.method()}));
      const idle=()=>page.waitForFunction(()=>document.querySelector('#app')?.getAttribute('aria-busy')!=='true'&&document.querySelector('#app h1'));
      const file=async(slot,content,name)=>{await page.locator(`[data-intake="${slot}"]`).setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from(content)});await page.waitForFunction(name=>document.querySelector('#intake')?.textContent.includes(name),name);await idle();};
      await page.goto(base);await page.locator('#app h1').waitFor();await idle();
      assert.equal(await page.locator('#copy-mml').isEnabled(),false);
      await page.screenshot({path:new URL(`${profile.name}-empty.png`,out).pathname,fullPage:true});
      await page.getByLabel('專案／歌曲名稱',{exact:true}).fill('Studio browser fixture');
      await page.getByLabel('錄音版本（專輯／MV／Live 等）',{exact:true}).fill('Synthetic studio v1');
      await page.getByLabel('有效音樂起點（秒）',{exact:true}).fill('0');
      await page.getByLabel('有效音樂終點（秒）',{exact:true}).fill('2');
      await page.getByLabel('來源確認的拍號圖',{exact:true}).fill('0 4/4');
      await page.locator('[name="audioRequired"]').selectOption('no');
      await page.locator('[name="preview"]').selectOption('none');
      await page.getByRole('button',{name:'儲存專案設定',exact:true}).click();await page.locator('h1').filter({hasText:'Studio browser fixture'}).waitFor();await idle();
      await file('candidate',mml,'candidate.mml');await file('baseline',mml,'baseline.mml');
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
      await page.screenshot({path:new URL(`${profile.name}-reviewed.png`,out).pathname,fullPage:true});
      await page.reload();await page.locator('#app h1').waitFor();await idle();assert.equal(await page.locator('.hero .badge').textContent(),'IN_GAME_ACCEPTED');
      // A revision change invalidates all reviews/acceptance before re-analysis.
      await file('candidate',mml.replace('o4c1','o4d1'),'changed.mml');assert.equal(await page.locator('.hero .badge').textContent(),'CANDIDATE');
      await page.locator('#audio-file').setInputFiles({name:'original.wav',mimeType:'audio/wav',buffer:Buffer.from('synthetic audio')});
      await page.locator('#audio-file-status').filter({hasText:'尚未上傳'}).waitFor();
      // The status line renders before the audio invalidation commit settles, and
      // an intake fired while #app is aria-busy is dropped by design; wait it out.
      await idle();
      assert.ok(requests.every(r=>r.method==='GET'&&r.url.startsWith(base)),'Symbolic intake and audio selection cause no upload or external request');
      await file('baseline',mxml,'repeat.musicxml');assert.ok((await page.locator('#gates').textContent()).includes('UNSUPPORTED'));
      // Service worker must cache the actual module graph for offline restart.
      await page.evaluate(()=>navigator.serviceWorker.ready);
      await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);
      // Take the origin away instead of emulating offline: whatever renders now
      // was served by the service worker out of its own cache.
      server.closeAllConnections();await new Promise(closed=>server.close(closed));
      await page.reload();await page.locator('#app h1').waitFor();await idle();
      assert.equal(await page.locator('.hero .badge').textContent(),'CANDIDATE');
      assert.ok((await page.locator('#gates').textContent()).includes('UNSUPPORTED'));
      assert.deepEqual(errors,[]);
      results.push({profile:profile.name,status:'PASS',checks:['Files picker','local MML/MusicXML','full review workflow','state separation','exact clipboard payload','IndexedDB reload','revision invalidation','unsupported fail closed','no implicit uploads','responsive layout','offline module graph']});
    } catch(error) {
      failed=true;results.push({profile:profile.name,status:'FAIL',error:error.stack,consoleErrors:errors});
      if(page)await page.screenshot({path:new URL(`${profile.name}-failure.png`,out).pathname,fullPage:true}).catch(()=>{});
    } finally {if(browser)await browser.close();if(server.listening){server.closeAllConnections();server.close();}}
  }
} finally {if(server?.listening){server.closeAllConnections();server.close();}}
await writeFile(new URL('results.json',out),JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
if(failed)process.exitCode=1;
