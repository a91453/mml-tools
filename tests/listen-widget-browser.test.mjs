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
