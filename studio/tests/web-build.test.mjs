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
  // The backward repeat is expanded in the built engine exactly as in the native one.
  assert.equal(intake(xml).complete,true);
  assert.equal(intake(xml).project.events.length,2);
  const {canonical,canonicalDigest}=await import('../web-build/studio/web/published.mjs');
  assert.equal(createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),canonicalDigest);
  // The vendored loader honours the same opt-in list as the source loader.
  const vendoredLoader=await import('../web-build/studio/backend/bootstrap/index.mjs');
  assert.equal(vendoredLoader.loadPublishedCanonical({supportedCanonicalVersion:['unsupported-release',canonical.metadata.canonical_version]}).metadata.canonical_version,canonical.metadata.canonical_version);
  assert.throws(()=>vendoredLoader.loadPublishedCanonical({supportedCanonicalVersion:['unsupported-release']}),/CANONICAL_NOT_LOADED/);
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

test('the timbre preview engine is vendored from npm, self-contained, licensed and offline', async () => {
  execFileSync(process.execPath, ['scripts/build-studio-web.mjs'], { cwd: root });
  const read = path => readFile(new URL(`../web-build/${path}`, import.meta.url), 'utf8');
  const lib = await read('vendor/spessasynth/lib.js');
  assert.doesNotMatch(lib, /from ["']spessasynth_core["']/, 'no bare specifier survives in the browser build');
  assert.match(lib, /from "\.\/core\.js"/);
  for (const path of ['vendor/spessasynth/lib.js', 'vendor/spessasynth/core.js', 'vendor/spessasynth/processor.js']) {
    assert.doesNotMatch(await read(path), /sourceMappingURL=/, `${path} must not ask for an unlisted source map`);
  }
  assert.match(await read('vendor/spessasynth/processor.js'), /registerProcessor\(/);
  // The license rides inside the vendored code: an extension-less LICENSE file
  // is not servable by type-allowlisting hosts and would fail the SW install.
  assert.match(lib, /^\/\*! SpessaSynth — vendored from npm: spessasynth_lib@\d+\.\d+\.\d+, spessasynth_core@\d+\.\d+\.\d+/);
  assert.match(lib, /Apache License\s+Version 2\.0/);
  // The player readback names the engine it captured and relies on the worklet
  // posting each event with its own audio clock. Both are pinned here, so an
  // engine upgrade that changes either fails the build instead of a readback.
  const { ENGINE_VERSIONS } = await import('../web/preview/player.mjs');
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.ok(lib.startsWith(`/*! SpessaSynth — vendored from npm: ${ENGINE_VERSIONS.lib}, ${ENGINE_VERSIONS.core} `));
  assert.equal(`spessasynth_lib@${pkg.dependencies?.spessasynth_lib ?? pkg.devDependencies?.spessasynth_lib}`, ENGINE_VERSIONS.lib);
  assert.equal(`spessasynth_core@${pkg.dependencies?.spessasynth_core ?? pkg.devDependencies?.spessasynth_core}`, ENGINE_VERSIONS.core);
  assert.match(await read('vendor/spessasynth/processor.js'), /post\(\{type:"eventCall",data:\w+,currentTime:this\.synthesizer\.currentTime\}\)/);
  assert.match(lib, /this\.worklet\.port\.onmessage = \(e\) => this\.handleMessage\(e\.data\);/);
  for (const path of ['vendor/spessasynth/core.js', 'vendor/spessasynth/processor.js']) assert.match(await read(path), /SPDX-License-Identifier: Apache-2\.0/);
  const sw = await read('sw.js');
  // The readback takes its expected velocities from the backend renderer's
  // instrument table, so that table must be offline too.
  for (const path of ['vendor/spessasynth/lib.js', 'vendor/spessasynth/core.js', 'vendor/spessasynth/processor.js', 'studio/web/preview/player.mjs', 'studio/web/preview/readback.mjs', 'studio/backend/audio/instruments.mjs', 'studio/web/preview/worklet-console.mjs']) {
    assert.ok(sw.includes(`./${path}`), `offline asset missing: ${path}`);
  }
  // No sound bank is in the build, the manifest or the precache list: the
  // free default bank is downloaded from its upstream by the browser that
  // first needs it and kept only there, and a bank the user picks never ships.
  const build = JSON.parse(await read('build.json'));
  const paths = build.files.map(([path]) => path);
  assert.ok(paths.every(path => !/\.(dls|sf2|sf3)$/i.test(path) && !path.startsWith('vendor/soundbank/') && !path.startsWith('studio/web/default-bank/')), 'no bank file ships');
  assert.doesNotMatch(sw, /\.(dls|sf2|sf3)['"]|vendor\/soundbank|default-bank\.json|default-bank\//i, 'the Service Worker precaches no bank');
  // Nor inside another file: no RIFF sound-bank header, raw or base64.
  const bankHeader = /RIFF[\s\S]{4}(sfbk|DLS )|UklGR[A-Za-z0-9+/]{7}(ZmJr|TFMg)/;
  for (const path of paths) assert.doesNotMatch((await readFile(new URL(`../web-build/${path}`, import.meta.url))).toString('latin1'), bankHeader, `${path} carries no sound bank`);
  const { DEFAULT_BANK_UPSTREAM } = await import('../web/preview/default-bank.mjs');
  assert.match(await read('studio/web/preview/default-bank.mjs'), new RegExp(DEFAULT_BANK_UPSTREAM.sha256), 'the browser pins the upstream digest');
  for (const path of ['studio/web/preview/default-bank.mjs', 'studio/web/preview/default-bank-trim.mjs', 'studio/web/preview/default-bank-worker.mjs', 'studio/web/preview/instruments.mjs']) {
    assert.ok(sw.includes(`./${path}`), `offline asset missing: ${path}`);
  }
  assert.match(await read('studio/web/preview/default-bank-worker.mjs'), /from '\.\.\/\.\.\/\.\.\/vendor\/spessasynth\/core\.js'/, 'the subset is made with the vendored engine, nothing else');
  // Every precached file must have a type the static hosts serve, or the
  // whole Service Worker install fails and the app never works offline.
  const servable = new Set(['.html', '.mjs', '.js', '.css', '.json', '.webmanifest', '.svg', '.png']);
  for (const [path] of build.files) assert.ok(servable.has(path.slice(path.lastIndexOf('.'))) && path.includes('.'), `unservable precache entry: ${path}`);
});
