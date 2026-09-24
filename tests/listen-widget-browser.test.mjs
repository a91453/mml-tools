// Headless smoke test of the in-chat listening player.
//
// The player page is loaded the way a host loads it -- in a sandboxed iframe,
// from the exact HTML `resources/read` serves -- behind a minimal MCP Apps
// host that answers `ui/initialize`, delivers the `studio_listen` result and
// records what the player asks of it. What is checked is scheduler state, not
// sound: where playback starts, which notes it queues first, and what text a
// feedback button would post into the conversation.
//
// Skipped when no Chromium is installed (CI's unit job has none); the browser
// jobs and a local checkout with Playwright's Chromium run it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NODE_LISTEN_CODEC, createListenConfig, runListenTool } from '../server/mcp-listen.mjs';
import { parseListenMml } from '../server/listen/mml-events.mjs';
import { decodeListenLink } from '../studio/web/listen-link.mjs';
import { barStart, listenBars as studioWebBars } from '../studio/web/listen-timeline.mjs';
import { beatNumber } from '../studio/web/roll-geometry.mjs';
import { syntheticBank } from './fixtures/synthetic-soundfont.mjs';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { chromium = null; }
// The pinned Playwright's own Chromium, an explicit override, or any other
// Chromium build already present in the Playwright browser directory.
function installedChromiums() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return [];
  return readdirSync(root).filter(name => /^chromium-\d+$/.test(name)).sort().reverse()
    .flatMap(name => ['chrome-linux64', 'chrome-linux'].map(dir => join(root, name, dir, 'chrome')));
}
const executable = (() => {
  if (!chromium) return null;
  const candidates = [process.env.STUDIO_BROWSER_CHROMIUM, (() => { try { return chromium.executablePath(); } catch { return null; } })(), ...installedChromiums()];
  return candidates.find(path => path && existsSync(path)) ?? null;
})();
const skip = executable ? false : 'Chromium for Playwright is not installed';

const SONG = 'MML@t120o5c4e4d4f4e2g2f4a4g4b4a1,t120o4l2cegcfaec1,t120o3c1f1c1c1,,,t120o2c1f1g1c1;';
const COMPARE = 'MML@t120o5c4e4d4f4e2g2f4a4g4b4d1,t120o4l2cegcfaec1,t120o3c1f1c1c1,,,t120o2c1f1g1c1;';
const listen = createListenConfig({ studioWebOrigin: 'https://studio.example' });

async function listenResult(args) {
  const { structuredContent, text } = await runListenTool(args, { application: null, owner: null, listen });
  return { content: [{ type: 'text', text }], structuredContent, isError: false };
}

// A delivered Final with a one-beat pickup under 4/4, 16 beats at T120. The
// player's bars run 0-1, 1-5, 5-9, 9-13, 13-16; the listen link carries no
// pickup, so the Studio Web counts 0-4, 4-8, 8-12, 12-16 over the same notes.
const PICKUP_MML = `MML@${Array.from({ length: 6 }, () => `t120o4${'c4'.repeat(16)}`).join(',')};`;
const FINAL_ID = `art_${'ab'.repeat(32)}`;
const pickupFinal = {
  async getArtifact() {
    return {
      canonical: { status: 'CANONICAL_LOADED' }, operation: 'succeeded',
      artifact: {
        type: 'final_mml', artifact_id: FINAL_ID, project_id: `prj_${'cd'.repeat(16)}`, candidate_id: 'g11d:rev:synthetic', song_state: 'VALIDATED',
        mml: PICKUP_MML, final_bar: { pickup: '1', final_partial: null, meter_text: '0 4/4' },
      },
    };
  },
  async getProject() { return { project: { title: 'Synthetic pickup Final' } }; },
};
const pickupFinalView = async (args = {}) => (await runListenTool({ artifact_id: FINAL_ID, ...args }, { application: pickupFinal, owner: null, listen })).structuredContent;

// Where the Studio Web opens a link (studio/web/listen-ui.mjs startBeat): a
// bar counted from beat 0 over the link's own meter text, or the beat itself.
function studioWebStartBeat(payload, endBeat) {
  if (payload.start?.bar) {
    const { bars } = studioWebBars(payload.meter_text ?? null, endBeat);
    return beatNumber(barStart(bars, Math.min(payload.start.bar, bars.length)));
  }
  return beatNumber(payload.start?.beat ?? '0');
}

// A plain page at an https origin with no host bridge, holding the player.
async function standalone(page, html = listen.widgetHtml()) {
  await page.route('https://widget.test/', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto('https://widget.test/');
}
const load = (page, view) => page.evaluate(value => window.__mmlListen.load(value), view);

const HOST = `<!doctype html><html><body style="margin:0">
<iframe id="player" sandbox="allow-scripts" style="width:760px;height:760px;border:0"></iframe>
<script>
window.received = []; window.requests = [];
const frame = document.getElementById('player');
window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow) return;
  const message = event.data;
  window.received.push(message);
  const reply = result => frame.contentWindow.postMessage({ jsonrpc: '2.0', id: message.id, result }, '*');
  if (message.method === 'ui/initialize') reply({ protocolVersion: '2026-01-26', hostInfo: { name: 'synthetic-host', version: '1' }, hostCapabilities: { openLinks: {}, message: { text: {} } }, hostContext: { theme: 'dark', displayMode: 'inline' } });
  if (message.method === 'ui/notifications/initialized') frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: window.toolResult }, '*');
  if (message.method === 'ui/message' || message.method === 'ui/open-link') { window.requests.push(message); reply({}); }
});
window.start = (html, result) => { window.toolResult = result; frame.srcdoc = html; };
</script></body></html>`;

async function withBrowser(work) {
  const browser = await chromium.launch({ executablePath: executable, args: ['--mute-audio'] });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await work(page, errors);
    assert.deepEqual(errors, [], 'the player raised no page errors');
  } finally { await browser.close(); }
}

async function hosted(page, result) {
  await page.setContent(HOST);
  await page.evaluate(({ html, result }) => window.start(html, result), { html: listen.widgetHtml(), result });
  await page.waitForFunction(() => document.getElementById('player').contentWindow && window.received.some(message => message.method === 'ui/notifications/initialized'));
  const frame = page.frames().find(candidate => candidate !== page.mainFrame());
  await frame.waitForFunction(() => window.__mmlListen?.snapshot().loaded === true);
  return frame;
}

const snapshot = frame => frame.evaluate(() => window.__mmlListen.snapshot());

test('the player loads a studio_listen result over the MCP Apps bridge and renders roles and markers', { skip }, async () => {
  const result = await listenResult({
    mml: SONG, meter_text: '0 4/4', title: 'Synthetic <img src=x onerror="window.pwned=1">',
    markers: [{ bar: 3, role: 'Melody', kind: 'changed', label: 'raised <b>ending</b>' }, { beat: '13', kind: 'note', label: 'bass entry' }],
  });
  await withBrowser(async page => {
    const frame = await hosted(page, result);
    const initialize = await page.evaluate(() => window.received.find(message => message.method === 'ui/initialize'));
    assert.equal(initialize.params.protocolVersion, '2026-01-26');
    assert.equal(initialize.params.appInfo.name, 'mml-studio-listen');
    assert.ok(await page.evaluate(() => window.received.some(message => message.method === 'ui/notifications/size-changed' && message.params.height > 100)));

    const state = await snapshot(frame);
    assert.deepEqual(state.roles, ['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5']);
    assert.equal(state.bar_count, 5);
    assert.equal(state.duration, 9);
    assert.deepEqual(state.markers.map(marker => [marker.kind, marker.beat]), [['changed', '8'], ['note', '13']]);
    assert.equal(state.audio_state, 'not_started', 'no audio before a user gesture');
    assert.equal(state.bridge.connected, true);
    assert.equal(await frame.getAttribute('html', 'data-theme'), 'dark');

    // Every string from the result is rendered as text, never as markup.
    assert.equal(await frame.textContent('#title'), 'Synthetic <img src=x onerror="window.pwned=1">');
    assert.equal(await frame.evaluate(() => document.querySelectorAll('img, b').length), 0);
    assert.equal(await frame.evaluate(() => window.pwned), undefined);
    assert.equal(await frame.locator('#markers li').count(), 2);
    assert.match(await frame.textContent('#markers li:first-child'), /第3小節 · 0:04\.0.*Melody.*raised <b>ending<\/b>/);
    assert.equal(await frame.isVisible('#ab'), false, 'no A/B switch without a compare version');
    assert.equal(await frame.isVisible('#open-web'), true);
    assert.match(await frame.textContent('#preview-notice'), /不是遊戲內音色/);

    // The page times notes with the same parser the Node tests pin.
    const events = await frame.evaluate(() => window.__mmlListen.events());
    assert.deepEqual(events, parseListenMml(SONG).tracks.map(track => ({ role: track.role, total: track.total, events: track.events })));
  });
});

test('play from a bar, a time and a marker (with one bar of pre-roll) schedules from the right place', { skip }, async () => {
  const result = await listenResult({ mml: SONG, meter_text: '0 4/4', title: 'Synthetic', markers: [{ bar: 3, kind: 'changed', label: 'x' }] });
  await withBrowser(async page => {
    const frame = await hosted(page, result);
    await frame.fill('#jump-bar', '3');
    await frame.click('#jump-bar-go');
    let state = await snapshot(frame);
    assert.equal(state.playing, true);
    assert.notEqual(state.audio_state, 'not_started', 'the click created the audio context');
    assert.equal(state.last_start.reason, 'bar');
    assert.equal(state.last_start.seconds, 4, 'bar 3 of 4/4 at T120 starts at 4 s');
    assert.equal(state.last_start.bar, 3);
    assert.equal(state.last_start.beatInBar, 1);
    const first = state.scheduled.filter(entry => !entry.resumed);
    assert.ok(first.length >= 4);
    assert.ok(first.every(entry => entry.song_seconds >= 4), 'nothing before the start point is queued');
    assert.deepEqual(first.slice(0, 4).map(entry => [entry.role, entry.pitch, entry.song_seconds]), [[0, 77, 4], [1, 65, 4], [2, 48, 4], [5, 43, 4]]);
    assert.ok(Math.abs(first[0].when - state.last_start.ctxStart) < 1e-9, 'the first note sounds at the scheduled start');
    assert.ok(state.scheduled.length < 20, 'only a lookahead window is queued, not the whole song');

    await frame.fill('#jump-time', '0:06.5');
    await frame.click('#jump-time-go');
    state = await snapshot(frame);
    assert.equal(state.last_start.reason, 'time');
    assert.equal(state.last_start.seconds, 6.5);
    // A note already sounding at the start point (the Melody whole note from
    // 6 s) is resumed, not dropped.
    assert.ok(state.scheduled.some(entry => entry.resumed && entry.role === 0 && entry.song_seconds === 6));

    await frame.click('#markers li button:has-text("聽這裡")');
    state = await snapshot(frame);
    assert.equal(state.last_start.reason, 'marker:m1');
    assert.equal(state.last_start.seconds, 2, 'a marker in bar 3 is heard from the start of bar 2');
    assert.equal(state.last_start.bar, 2);

    // Solo and mute change what is audible without rescheduling.
    await frame.click('#roles .role:nth-child(2) button[title$="獨奏"]');
    assert.deepEqual((await snapshot(frame)).audible_roles, ['Chord1']);
    await frame.click('#roles .role:nth-child(2) button[title$="獨奏"]');
    await frame.click('#roles .role:nth-child(1) button[title$="靜音"]');
    assert.deepEqual((await snapshot(frame)).audible_roles, ['Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5']);

    await frame.click('#play');
    assert.equal((await snapshot(frame)).playing, false, 'play toggles to pause');
  });
});

test('feedback is collected at the playhead and posted into the conversation as a user message', { skip }, async () => {
  const result = await listenResult({ mml: SONG, meter_text: '0 4/4', title: 'Synthetic', markers: [{ bar: 3, role: 'Melody', kind: 'changed', label: 'raised ending' }] });
  await withBrowser(async page => {
    const frame = await hosted(page, result);
    await frame.fill('#jump-bar', '4');
    await frame.click('#jump-bar-go');
    await frame.click('#play');
    await frame.click('#mark');
    await frame.click('#draft-add');
    assert.equal((await snapshot(frame)).feedback_count, 0, 'a kind must be chosen');
    await frame.click('#draft-kinds button:has-text("音不對")');
    await frame.selectOption('#draft-role', 'Chord1');
    await frame.fill('#draft-text', 'the second chord sounds wrong');
    await frame.click('#draft-add');
    await frame.click('#markers li button:has-text("聽過沒問題")');
    let state = await snapshot(frame);
    assert.equal(state.feedback_count, 2);
    const lines = state.feedback_text.split('\n');
    assert.equal(lines[0], 'MML 試聽回饋：Synthetic');
    assert.match(lines[1], new RegExp(`^MML sha256 ${result.structuredContent.mml_sha256.slice(0, 12)}｜內嵌 MML$`));
    assert.equal(lines[2], '- 第3小節 第1拍｜beat 8｜0:04.0｜Melody｜聽過，沒問題｜raised ending｜[changed]');
    assert.match(lines[3], /^- 第4小節 第1(?:\.\d+)?拍｜beat 1[23](?:\.\d+)?｜0:06\.\d｜Chord1｜音不對｜the second chord sounds wrong$/);
    assert.match(lines.at(-1), /不是任何 Gate 的確認、證據或接受/);

    await frame.click('[data-tab="feedback"]');
    await frame.click('#send');
    await page.waitForFunction(() => window.requests.some(message => message.method === 'ui/message'));
    const sent = await page.evaluate(() => window.requests.find(message => message.method === 'ui/message').params);
    assert.deepEqual(sent, { role: 'user', content: [{ type: 'text', text: state.feedback_text }] });
    state = await snapshot(frame);
    assert.equal(state.last_send.via, 'ui/message');
    assert.equal(state.feedback_count, 0, 'sent feedback is cleared');

    // Open in Studio Web: the server's link, and one re-encoded at the cursor.
    await frame.click('#open-web');
    await frame.click('#open-web-here');
    await page.waitForFunction(() => window.requests.filter(message => message.method === 'ui/open-link').length === 2);
    const [whole, here] = await page.evaluate(() => window.requests.filter(message => message.method === 'ui/open-link').map(message => message.params.url));
    assert.equal(whole, result.structuredContent.listen_link.url);
    const payload = await decodeListenLink(here.split('#listen=')[1], NODE_LISTEN_CODEC);
    assert.equal(payload.mml, SONG);
    assert.equal(payload.start.bar, 4);
    assert.deepEqual(payload.markers, [{ beat: '8', role: 'Melody', kind: 'changed', label: 'raised ending' }]);
  });
});

test('without a host bridge: Apps SDK globals, then a copy fallback', { skip }, async () => {
  const result = await listenResult({ mml: SONG, compare_mml: COMPARE, meter_text: '0 4/4', title: 'Synthetic' });
  await withBrowser(async page => {
    // Apps SDK globals only: data from toolOutput, feedback via sendFollowUpMessage.
    await page.addInitScript(view => {
      window.followUps = [];
      window.openai = { toolOutput: view, theme: 'light', sendFollowUpMessage: async ({ prompt }) => { window.followUps.push(prompt); } };
    }, result.structuredContent);
    await page.route('https://widget.test/', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: listen.widgetHtml() }));
    await page.goto('https://widget.test/');
    await page.waitForFunction(() => window.__mmlListen?.snapshot().loaded === true);
    assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
    assert.equal(await page.isVisible('#ab'), true, 'a compare version offers A/B');
    await page.click('#ver-b');
    assert.equal((await page.evaluate(() => window.__mmlListen.snapshot())).version, 'B');
    await page.click('#markers li:first-child');
    await page.click('#mark');
    await page.click('#draft-kinds button:has-text("主旋律")');
    await page.click('#draft-add');
    await page.click('[data-tab="feedback"]');
    await page.click('#send');
    await page.waitForFunction(() => window.followUps.length === 1);
    const prompt = await page.evaluate(() => window.followUps[0]);
    assert.match(prompt, new RegExp(`MML sha256 ${result.structuredContent.compare_mml_sha256.slice(0, 12)}`), 'feedback on B names B');
    assert.match(prompt, /主旋律｜版本B/);
  });
  await withBrowser(async page => {
    // Nothing at all: the page still plays and offers the text to copy.
    await page.setContent(listen.widgetHtml());
    await page.evaluate(view => window.__mmlListen.load(view), result.structuredContent);
    await page.click('#mark');
    await page.click('#draft-kinds button:has-text("太吵")');
    await page.click('#draft-add');
    await page.click('[data-tab="feedback"]');
    await page.click('#send');
    await page.waitForFunction(() => !document.getElementById('copy-area').hidden);
    const text = await page.inputValue('#copy-area');
    assert.match(text, /^MML 試聽回饋：Synthetic\n/);
    assert.match(text, /太吵/);
    assert.equal((await page.evaluate(() => window.__mmlListen.snapshot())).last_send.via, null);
    assert.match(await page.textContent('#status'), /複製/);
  });
});

// A short synthetic sine as a WAV file. The sample-library layout labels its
// notes audio/mp3; decodeAudioData sniffs the bytes, so WAV stands in for it.
function sineWav(frequency) {
  const rate = 8000;
  const frames = 1600;
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + frames * 2, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / rate) * 12000), 44 + i * 2);
  return buffer.toString('base64');
}

test('better timbre is opt-in: an SF2 file stays in memory, a sample library is fetched only when configured', { skip }, async () => {
  const view = (await listenResult({ mml: SONG, meter_text: '0 4/4', title: 'Synthetic' })).structuredContent;
  await withBrowser(async page => {
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    await page.route('https://widget.test/', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: listen.widgetHtml() }));
    await page.goto('https://widget.test/');
    await page.evaluate(value => window.__mmlListen.load(value), view);
    assert.equal(await page.isVisible('#samples-block'), false, 'no sample library is offered unless configured');
    await page.click('[data-tab="sound"]');
    await page.setInputFiles('#sf2-file', { name: 'synthetic.sf2', mimeType: 'application/octet-stream', buffer: Buffer.from(syntheticBank()) });
    await page.waitForFunction(() => /已載入 1 個 preset/.test(document.getElementById('sf2-status').textContent));
    let state = await page.evaluate(() => window.__mmlListen.snapshot());
    assert.equal(state.voice, 'sf2');
    assert.deepEqual(state.sf2_presets, ['0:5 Synthetic Lead']);
    await page.fill('#jump-bar', '1');
    await page.click('#jump-bar-go');
    state = await page.evaluate(() => window.__mmlListen.snapshot());
    assert.ok(state.voice_counts.sf2 > 0, JSON.stringify(state.voice_counts));
    assert.ok(state.voice_counts.synth > 0, 'keys outside the bank fall back to the preview synth');
    assert.deepEqual(requests, ['https://widget.test/'], 'loading a bank sends nothing anywhere');
    await page.setInputFiles('#sf2-file', { name: 'bank.dls', mimeType: 'application/octet-stream', buffer: Buffer.from('RIFF') });
    assert.match(await page.textContent('#sf2-status'), /DLS/);
  });

  const samples = createListenConfig({ samplesUrl: 'https://samples.example/banks/gm/', samplesCredit: 'Synthetic sample credit' });
  await withBrowser(async page => {
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    const library = `if (typeof(MIDI) === 'undefined') var MIDI = {};\nMIDI.Soundfont = MIDI.Soundfont || {};\nMIDI.Soundfont.acoustic_grand_piano = {\n"C3": "data:audio/mp3;base64,${sineWav(130.81)}",\n"C4": "data:audio/mp3;base64,${sineWav(261.63)}",\n"C5": "data:audio/mp3;base64,${sineWav(523.25)}"\n};`;
    await page.route('https://widget.test/', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: samples.widgetHtml() }));
    await page.route('https://samples.example/**', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: library }));
    await page.goto('https://widget.test/');
    await page.evaluate(value => window.__mmlListen.load(value), view);
    await page.click('[data-tab="sound"]');
    assert.equal(await page.textContent('#samples-credit'), 'Synthetic sample credit');
    assert.deepEqual(requests, ['https://widget.test/'], 'nothing is fetched before the person chooses samples');
    await page.check('#voice-samples');
    await page.waitForFunction(() => /取樣已就緒/.test(document.getElementById('samples-status').textContent));
    assert.deepEqual(requests.slice(1), ['https://samples.example/banks/gm/acoustic_grand_piano-mp3.js'], 'one file per chosen program, from the configured origin only');
    await page.fill('#jump-bar', '2');
    await page.click('#jump-bar-go');
    const state = await page.evaluate(() => window.__mmlListen.snapshot());
    assert.equal(state.voice, 'samples');
    assert.ok(state.voice_counts.samples > 0, JSON.stringify(state.voice_counts));
  });
});

test('a Final with a pickup opens at the start bar studio_listen resolved, as a bar or as its exact beat', { skip }, async () => {
  const view = await pickupFinalView({ start_bar: 3 });
  assert.equal(view.pickup, '1');
  await withBrowser(async page => {
    await standalone(page);
    const openAt = async start => {
      await load(page, start === undefined ? view : { ...view, start });
      return [(await snapshot(page)).cursor_seconds, await page.textContent('#pos-bar')];
    };
    // Whichever form studio_listen sends for this Final, bar 3 after a one-beat
    // pickup starts at beat 5, which is 2.5 s at T120.
    assert.deepEqual(await openAt(), [2.5, '第 3 小節 · 第 1 拍']);
    // The exact beat (the form a pickup Final's start travels in, since the
    // Studio Web would count bar 3 from beat 8) and the bar agree.
    assert.deepEqual(await openAt({ beat: '5' }), [2.5, '第 3 小節 · 第 1 拍']);
    assert.deepEqual(await openAt({ bar: 3 }), [2.5, '第 3 小節 · 第 1 拍']);
    // A different start in an otherwise identical view is a different view.
    assert.deepEqual(await openAt({ beat: '9' }), [4.5, '第 4 小節 · 第 1 拍']);
    assert.deepEqual(await openAt({ beat: '11/2' }), [2.75, '第 3 小節 · 第 1.5 拍']);
    // Clamped to the song; a start the player cannot read opens at the beginning.
    assert.deepEqual(await openAt({ beat: '999' }), [8, '第 5 小節 · 第 4 拍']);
    for (const start of [{ beat: '5.5' }, { beat: 5 }, { beat: '-1' }, { bar: 0 }, { bar: '3' }, null]) {
      assert.equal((await openAt(start))[0], 0, JSON.stringify(start));
    }
  });
});

test('"open here in Studio Web" under a pickup sends the beat of the bar the player is in, which the Studio Web opens at', { skip }, async () => {
  const pickupView = await pickupFinalView();
  const plainView = (await listenResult({ mml: PICKUP_MML, meter_text: '0 4/4', title: 'Synthetic' })).structuredContent;
  assert.equal(plainView.pickup, null);
  await withBrowser(async page => {
    await standalone(page);
    const openHere = async () => decodeListenLink((await page.evaluate(() => window.__mmlListen.hereLink())).split('#listen=')[1], NODE_LISTEN_CODEC);
    for (const [view, bar, beat, start] of [
      [pickupView, 3, 5, { beat: '5' }],
      [pickupView, 1, 0, { beat: '0' }],
      [pickupView, 5, 13, { beat: '13' }],
      [plainView, 3, 8, { bar: 3 }],
    ]) {
      const label = `${view.pickup ? 'pickup' : 'plain'} bar ${bar}`;
      await load(page, view);
      await page.fill('#jump-bar', String(bar));
      await page.click('#jump-bar-go');
      await page.click('#play');
      const state = await snapshot(page);
      assert.deepEqual([state.last_start.bar, state.last_start.beat], [bar, beat], label);
      const payload = await openHere();
      assert.deepEqual(payload.start, start, label);
      assert.equal(payload.pickup, undefined, 'the link document has no pickup');
      assert.equal(studioWebStartBeat(payload, '16'), beat, `${label}: the Studio Web opens where the player is`);
    }
    // Inside a bar the link opens that bar's start, as a bar number would.
    await load(page, pickupView);
    await page.fill('#jump-time', '0:03');
    await page.click('#jump-time-go');
    await page.click('#play');
    const payload = await openHere();
    assert.deepEqual(payload.start, { beat: '5' });
    assert.equal(studioWebStartBeat(payload, '16'), 5);
  });
});

test('a damaged SF2 bank is refused, and a region with no sample data sounds through the synth without stalling playback', { skip }, async () => {
  // Two beats at T120: one second, so playback ends on its own.
  const view = (await listenResult({ mml: 'MML@t120o5c8d8e8f8,,,,,;', meter_text: '0 4/4', title: 'Short' })).structuredContent;
  await withBrowser(async page => {
    await standalone(page);
    await load(page, view);
    await page.click('[data-tab="sound"]');
    const loadBank = async (name, bank) => {
      await page.setInputFiles('#sf2-file', { name, mimeType: 'application/octet-stream', buffer: Buffer.from(bank) });
      await page.waitForFunction(() => { const text = document.getElementById('sf2-status').textContent; return text && !/讀取中/.test(text); });
      return page.textContent('#sf2-status');
    };
    const playToEnd = async () => {
      await page.click('#rewind');
      await page.click('#play');
      assert.equal((await snapshot(page)).playing, true);
      await page.waitForFunction(() => window.__mmlListen.snapshot().playing === false, null, { timeout: 5000 });
      return (await snapshot(page)).voice_counts;
    };
    // The sample header points far past the 146 points of sample data.
    const damaged = syntheticBank({ sample: { start: 100000, end: 100100, startLoop: 100010, endLoop: 100090 } });
    assert.match(await loadBank('damaged.sf2', damaged), /Synthetic Sine.*超出取樣資料範圍/);
    let state = await snapshot(page);
    assert.equal(state.voice, 'synth');
    assert.deepEqual(state.sf2_presets, []);
    assert.equal(await page.isDisabled('#voice-sf2'), true);
    assert.deepEqual(await playToEnd(), { synth: 4, sf2: 0, samples: 0 });

    // A valid bank whose zone offset moves the sample range past the data:
    // loaded, but every note it cannot sound is sounded by the synth.
    assert.match(await loadBank('shifted.sf2', syntheticBank({ zoneGenerators: [[4, 1]] })), /已載入 1 個 preset/);
    state = await snapshot(page);
    assert.equal(state.voice, 'sf2');
    assert.deepEqual(await playToEnd(), { synth: 4, sf2: 0, samples: 0 });

    // The intact bank still sounds through its own samples.
    assert.match(await loadBank('synthetic.sf2', syntheticBank()), /已載入 1 個 preset/);
    assert.deepEqual(await playToEnd(), { synth: 0, sf2: 4, samples: 0 });
  });
});

test('without a host bridge a link opens in a new tab that gets no opener and no referrer, and only a blocked tab is reported', { skip }, async () => {
  const view = (await listenResult({ mml: SONG, meter_text: '0 4/4', title: 'Synthetic' })).structuredContent;
  await withBrowser(async page => {
    const context = page.context();
    const studio = [];
    await context.route('https://studio.example/**', route => { studio.push(route.request()); return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Studio Web</title>' }); });
    await standalone(page);
    await load(page, view);
    const [tab] = await Promise.all([context.waitForEvent('page'), page.click('#open-web')]);
    await tab.waitForURL(url => url.href === view.listen_link.url);
    assert.equal(await tab.evaluate(() => window.opener === null), true, 'the opened page cannot reach the player');
    assert.equal(studio.length, 1);
    assert.equal(await studio[0].headerValue('referer'), null, 'the page is opened without a referrer');
    assert.equal(await page.textContent('#status'), '', 'an opened tab is not reported as a failure');
    assert.equal(await page.evaluate(() => document.getElementById('status').classList.contains('error')), false);
    await tab.close();

    // A blocked popup is still said plainly.
    await page.evaluate(() => { window.open = () => null; });
    await page.click('#open-web');
    await page.waitForFunction(() => /主機沒有開啟連結/.test(document.getElementById('status').textContent));

    // Inside a sandboxed frame (a host whose bridge never answers): when its
    // popups escape the sandbox the tab opens without an opener; when they stay
    // sandboxed the player cannot reach the tab to cut the opener, so the tab
    // is closed and the failure reported rather than left holding the player.
    for (const [sandbox, opens] of [['allow-scripts allow-popups allow-popups-to-escape-sandbox', true], ['allow-scripts allow-popups', false]]) {
      await page.setContent(`<!doctype html><iframe id="player" sandbox="${sandbox}" style="width:760px;height:760px;border:0"></iframe>`);
      await page.evaluate(html => { document.getElementById('player').srcdoc = html; }, listen.widgetHtml());
      const frame = await (await page.$('#player')).contentFrame();
      await frame.waitForFunction(() => window.__mmlListen);
      await frame.evaluate(value => window.__mmlListen.load(value), view);
      if (opens) {
        const [popup] = await Promise.all([context.waitForEvent('page'), frame.click('#open-web')]);
        await popup.waitForURL(url => url.href === view.listen_link.url);
        assert.equal(await popup.evaluate(() => window.opener === null), true, sandbox);
        assert.equal(await frame.textContent('#status'), '', sandbox);
        await popup.close();
      } else {
        await frame.click('#open-web');
        await frame.waitForFunction(() => /主機沒有開啟連結/.test(document.getElementById('status').textContent));
        await page.waitForTimeout(500);
        assert.deepEqual(context.pages().map(open => open.url()), [page.url()], `${sandbox}: no tab is left open`);
      }
    }
  });
});
