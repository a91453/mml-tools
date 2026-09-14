import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { intake as nativeIntake } from '../web/model.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
test('built offline engine preserves native parser/IR behavior and complete asset integrity',async()=>{
  execFileSync(process.execPath,['scripts/build-studio-web.mjs'],{cwd:root});
  const {intake}=await import('../web-build/studio/web/model.mjs');
  const mml={name:'fixture.mml',id:'fixture',meterText:'0 4/4',content:'MML@t120o4c1,t120o3e1,t120o2c1,,,;'};
  assert.deepEqual(intake(mml),nativeIntake(mml));
  const xml={name:'fixture.musicxml',id:'fixture',content:'<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note><barline><repeat direction="backward"/></barline></measure></part></score-partwise>'};
  assert.deepEqual(intake(xml),nativeIntake(xml));
  assert.equal(intake(xml).complete,false);
  const {canonical,canonicalDigest}=await import('../web-build/studio/web/published.mjs');
  assert.equal(createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),canonicalDigest);
  const build=JSON.parse(await readFile(new URL('../web-build/build.json',import.meta.url)));
  // Executable Service Worker code must be inside the release identity.
  assert.ok(build.files.some(([path])=>path==='sw.js'),'sw.js must be covered by the asset manifest');
  const sw=await readFile(new URL('../web-build/sw.js',import.meta.url),'utf8');
  for(const [path,hash] of build.files){
    const bytes=await readFile(new URL(`../web-build/${path}`,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),hash,path);
    // The Service Worker is covered by the release manifest but does not
    // precache itself: the browser fetches the worker script directly.
    if(path!=='sw.js')assert.ok(sw.includes(`./${path}`),`Offline asset missing: ${path}`);
    if(/\.m?js$/.test(path))assert.doesNotMatch(bytes.toString(),/from ['"]node:/);
  }
  // Dynamic Git provenance is audit-only and must stay out of the hashed bundle.
  assert.equal(canonical.provenance,undefined);
  assert.notEqual(build.release.canonical.rules_snapshot_sha,build.audit.published_main_head);
});
