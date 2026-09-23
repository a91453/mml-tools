// ─── MML listening widget ───────────────────────────────────────────────────
//
// Inlined after mml-events.mjs, sf2.mjs and the Studio Web listen-link
// contract (studio/web/listen-link.mjs, as `ListenLink`) into one module
// script. It renders
// a `mml-studio/listen-view@1` object (the `studio_listen` structuredContent),
// plays it with WebAudio only after a user gesture, and turns what the person
// hears into feedback text they can post back into the conversation.
//
// It never calls a tool, never writes a record and never fetches anything
// except, when the deployment configured one, a sample library. Feedback is
// conversation text; it is not, and is never presented as, a gate
// confirmation, evidence or acceptance.
//
// Hosts: MCP Apps (`ui/*` JSON-RPC over postMessage, spec 2026-01-26) first;
// the Apps SDK `window.openai` globals as a fallback; a plain page (tests, a
// host with no bridge) through `window.__mmlListen.load(view)`.

const VIEW_SCHEMA = 'mml-studio/listen-view@1';
const MCP_APPS_PROTOCOL = '2026-01-26';
const ROLE_COUNT = 6;
const FEEDBACK_KINDS = ['太吵', '音不對', '節奏', '平衡', '主旋律', '其他'];
const OK_TEXT = '聽過，沒問題';
const KIND_TEXT = { 'provisional-release': 'release 暫定', 'lead-unverified': '主旋律未驗證', pending: '待聽', changed: '已修改', note: '備註' };
const MAX_FEEDBACK = 50;
const LOOKAHEAD = 0.3;
const TICK_MS = 25;
const START_DELAY = 0.08;

const CONFIG = (() => {
  try { return JSON.parse(document.getElementById('mml-listen-config').textContent) || {}; } catch { return {}; }
})();
const $ = id => document.getElementById(id);
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const fmtTime = seconds => {
  const total = Math.max(0, seconds || 0);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${(total - minutes * 60).toFixed(1).padStart(4, '0')}`;
};
const fmtNumber = value => String(Math.round(value * 100) / 100);
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ─── state ─────────────────────────────────────────────────────────────────

const S = {
  view: null,
  viewKey: null,
  songs: { A: null, B: null },
  version: 'A',
  song: null,
  bars: null,
  markers: [],
  songNotes: [],
  mute: new Array(ROLE_COUNT).fill(false),
  solo: new Set(),
  cursorSec: 0,
  viewStart: 0,
  viewBeats: 32,
  feedback: [],
  draft: null,
  voice: 'synth',
  sf2: null,
  sf2Choice: new Array(ROLE_COUNT).fill(0),
  samplePrograms: new Array(ROLE_COUNT).fill(0),
  colors: [],
};

const T = {
  ctx: null, master: null, roleGain: [], playing: false, originSec: 0, ctxStart: 0,
  index: 0, timer: null, live: new Set(), log: [], lastStart: null, raf: 0,
  voiceCounts: { synth: 0, sf2: 0, samples: 0 },
};

// ─── song model ────────────────────────────────────────────────────────────

function buildSong(mml) {
  const parsed = parseListenMml(mml);
  if (!parsed.tracks.length || !parsed.ok) return { error: parsed.error || 'MML 無法讀取' };
  const tempo = listenTempoMap(parsed.tempo);
  const notes = [];
  let pitchMin = 127;
  let pitchMax = 0;
  let maxBeats = 0;
  parsed.tracks.forEach((track, role) => {
    for (const event of track.events) {
      const sb = listenBeatNumber(event.start);
      const eb = listenBeatNumber(event.end);
      if (!(eb > sb) || !Number.isFinite(event.pitch) || event.pitch < 0 || event.pitch > 127) continue;
      pitchMin = Math.min(pitchMin, event.pitch);
      pitchMax = Math.max(pitchMax, event.pitch);
      maxBeats = Math.max(maxBeats, eb - sb);
      notes.push({ r: role, p: event.pitch, sb, eb, s: listenSecondsAt(tempo, sb), e: listenSecondsAt(tempo, eb), v: event.volume });
    }
  });
  notes.sort((a, b) => a.s - b.s || a.r - b.r || a.p - b.p);
  const totalBeats = listenBeatNumber(parsed.total);
  if (pitchMin > pitchMax) { pitchMin = 60; pitchMax = 72; }
  return {
    parsed, tempo, notes, totalBeats, duration: listenSecondsAt(tempo, totalBeats),
    pitchMin, pitchMax, maxBeats, noTempo: parsed.tempo.length === 0,
    pitchesByRole: Array.from({ length: ROLE_COUNT }, (_, role) => [...new Set(notes.filter(n => n.r === role).map(n => n.p))]),
  };
}

const secAtBeat = beat => listenSecondsAt(S.song.tempo, beat);
const beatAtSec = seconds => listenBeatAt(S.song.tempo, seconds);
const barAtBeat = beat => (S.bars ? listenBarAt(S.bars, beat) : null);

function locate(seconds) {
  const beat = beatAtSec(seconds);
  const bar = barAtBeat(beat);
  const beatInBar = bar ? (beat - bar.start) * bar.denominator / 4 + 1 : null;
  return { seconds, beat, bar: bar ? bar.index : null, beatInBar };
}

function placeText(place) {
  const parts = [];
  if (place.bar !== null) parts.push(`第${place.bar}小節 第${fmtNumber(place.beatInBar)}拍`);
  parts.push(`beat ${fmtNumber(place.beat)}`);
  parts.push(fmtTime(place.seconds));
  return parts.join('｜');
}

// Pre-roll: a marker is heard from the start of the bar before it (four
// beats before it when there is no meter map).
function preRollStartBeat(beat) {
  const bar = barAtBeat(beat);
  if (!bar) return Math.max(0, beat - 4);
  return S.bars[Math.max(0, bar.index - 2)].start;
}

// ─── audio ─────────────────────────────────────────────────────────────────

const SYNTH = [
  { type: 'square', cutoff: 3200, level: 0.5 },
  { type: 'triangle', cutoff: 4200, level: 0.85 },
  { type: 'sawtooth', cutoff: 1800, level: 0.42 },
  { type: 'triangle', cutoff: 3000, level: 0.8 },
  { type: 'sine', cutoff: 5000, level: 0.95 },
  { type: 'sawtooth', cutoff: 1100, level: 0.5 },
];

function ensureAudio() {
  if (T.ctx) return T.ctx;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw Error('這個環境不支援 Web Audio，無法播放。');
  const ctx = new AudioContextClass();
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -14;
  compressor.ratio.value = 6;
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(compressor);
  compressor.connect(ctx.destination);
  T.ctx = ctx;
  T.master = master;
  T.roleGain = Array.from({ length: ROLE_COUNT }, () => {
    const gain = ctx.createGain();
    gain.connect(master);
    return gain;
  });
  applyMix();
  return ctx;
}

const audible = role => (S.solo.size ? S.solo.has(role) : !S.mute[role]);

function applyMix() {
  if (T.ctx) T.roleGain.forEach((gain, role) => gain.gain.setTargetAtTime(audible(role) ? 1 : 0, T.ctx.currentTime, 0.01));
  renderRoles();
  drawAll();
}

function track(source, gain) {
  const entry = { source, gain };
  T.live.add(entry);
  source.onended = () => {
    T.live.delete(entry);
    try { gain.disconnect(); } catch { /* already gone */ }
  };
}

function synthNote(ctx, dest, note, when, duration) {
  const spec = SYNTH[note.r];
  const oscillator = ctx.createOscillator();
  oscillator.type = spec.type;
  oscillator.frequency.setValueAtTime(440 * 2 ** ((note.p - 69) / 12), when);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(spec.cutoff, when);
  const gain = ctx.createGain();
  const peak = clamp(note.v, 0, 15) / 15 * 0.2 * spec.level;
  const end = when + Math.max(0.03, duration);
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(peak, when + 0.006);
  gain.gain.setTargetAtTime(peak * 0.72, when + 0.006, 0.15);
  gain.gain.setTargetAtTime(0, end - 0.01, 0.025);
  oscillator.connect(filter);
  filter.connect(gain);
  gain.connect(dest);
  oscillator.start(when);
  oscillator.stop(end + 0.2);
  track(oscillator, gain);
}

function playNote(note, when, duration) {
  const ctx = T.ctx;
  const dest = T.roleGain[note.r];
  // A sampled voice that cannot sound this note (no region, not decoded yet)
  // falls back to the preview synth rather than dropping it.
  let voice = 'synth';
  if (S.voice === 'sf2' && S.sf2 && sf2Note(ctx, dest, note, when, duration)) voice = 'sf2';
  else if (S.voice === 'samples' && sampleNote(ctx, dest, note, when, duration)) voice = 'samples';
  else synthNote(ctx, dest, note, when, duration);
  T.voiceCounts[voice]++;
}

function stopVoices() {
  if (!T.ctx) return;
  const now = T.ctx.currentTime;
  for (const { source, gain } of T.live) {
    try {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(0, now, 0.01);
      source.stop(now + 0.05);
    } catch { /* already stopped */ }
  }
  T.live.clear();
}

function positionSec() {
  if (T.playing && T.ctx) return clamp(T.originSec + Math.max(0, T.ctx.currentTime - T.ctxStart), 0, S.song.duration);
  return S.cursorSec;
}

/**
 * Start playing at a song time. Must run inside a user gesture: the
 * AudioContext is created and resumed synchronously before anything awaits.
 */
function playFrom(seconds, reason) {
  if (!S.song) return;
  let ctx;
  try { ctx = ensureAudio(); } catch (error) { setStatus(error.message, true); return; }
  if (ctx.state === 'suspended') ctx.resume().catch(() => setStatus('瀏覽器沒有允許播放聲音；請再按一次播放。', true));
  stopVoices();
  clearInterval(T.timer);
  const origin = clamp(seconds, 0, Math.max(0, S.song.duration - 0.001));
  const notes = S.song.notes;
  T.originSec = origin;
  T.ctxStart = ctx.currentTime + START_DELAY;
  T.playing = true;
  T.log = [];
  T.voiceCounts = { synth: 0, sf2: 0, samples: 0 };
  let low = 0;
  let high = notes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (notes[middle].s < origin - 1e-9) low = middle + 1;
    else high = middle;
  }
  T.index = low;
  // Notes that began before the start point and are still sounding.
  for (let i = 0; i < low; i++) {
    const note = notes[i];
    if (note.e > origin + 0.02) schedule(note, T.ctxStart, note.e - origin, true);
  }
  T.lastStart = { reason, ...locate(origin), ctxStart: T.ctxStart, firstNoteIndex: low };
  S.cursorSec = origin;
  tick();
  T.timer = setInterval(tick, TICK_MS);
  startFrames();
  renderTransport();
}

function schedule(note, when, duration, resumed = false) {
  if (T.log.length < 400) T.log.push({ role: note.r, pitch: note.p, when, song_seconds: note.s, resumed });
  playNote(note, when, duration);
}

function tick() {
  if (!T.playing) return;
  const ctx = T.ctx;
  const horizon = ctx.currentTime + LOOKAHEAD;
  const notes = S.song.notes;
  while (T.index < notes.length) {
    const note = notes[T.index];
    const when = T.ctxStart + (note.s - T.originSec);
    if (when > horizon) break;
    if (when >= ctx.currentTime - 0.05) schedule(note, Math.max(when, ctx.currentTime), note.e - note.s);
    T.index++;
  }
  if (T.index >= notes.length && ctx.currentTime - T.ctxStart + T.originSec >= S.song.duration + 0.4) stop(true);
}

function stop(ended = false) {
  if (T.playing) S.cursorSec = ended ? 0 : positionSec();
  T.playing = false;
  clearInterval(T.timer);
  T.timer = null;
  stopVoices();
  renderTransport();
  drawAll();
}

function seekSeconds(seconds, reason) {
  const target = clamp(seconds, 0, S.song ? S.song.duration : 0);
  if (T.playing) playFrom(target, reason);
  else {
    S.cursorSec = target;
    followView(beatAtSec(target), true);
    renderTransport();
    drawAll();
  }
}

// ─── SF2 voices (the person's own bank, in memory only) ────────────────────

const sf2Buffers = new Map();

function sf2Note(ctx, dest, note, when, duration) {
  const bank = S.sf2;
  const velocity = Math.round(clamp(note.v, 0, 15) / 15 * 127);
  const regions = soundFontRegions(bank, S.sf2Choice[note.r], note.p, Math.max(1, velocity));
  if (!regions.length) return false;
  const end = when + Math.max(0.03, duration);
  for (const region of regions) {
    const key = `${region.sampleIndex}:${region.start}:${region.end}`;
    let buffer = sf2Buffers.get(key);
    if (buffer === undefined) {
      const data = soundFontSampleData(bank, region);
      buffer = null;
      if (data.length > 1 && region.sampleRate >= 3000 && region.sampleRate <= 768000) {
        buffer = ctx.createBuffer(1, data.length, region.sampleRate);
        buffer.getChannelData(0).set(data);
      }
      sf2Buffers.set(key, buffer);
    }
    if (!buffer) continue;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.setValueAtTime(2 ** (region.semitones / 12), when);
    if (region.loop) {
      source.loop = true;
      source.loopStart = (region.loopStart - region.start) / region.sampleRate;
      source.loopEnd = (region.loopEnd - region.start) / region.sampleRate;
    }
    const gain = ctx.createGain();
    const peak = region.gain * (velocity / 127) * 0.5;
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(peak, when + Math.max(0.002, region.attack));
    gain.gain.setTargetAtTime(0, end, region.release / 4);
    let output = gain;
    if (region.pan && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = region.pan;
      gain.connect(panner);
      output = panner;
    }
    source.connect(gain);
    output.connect(dest);
    source.start(when);
    source.stop(end + region.release + 0.05);
    track(source, gain);
  }
  return true;
}

async function loadSoundFontFile(file) {
  const status = $('sf2-status');
  if (!file) return;
  if (!/\.sf2$/i.test(file.name)) {
    status.textContent = /\.dls$/i.test(file.name) ? 'DLS 音色庫目前不支援；請先轉成 .sf2。' : /\.sf3$/i.test(file.name) ? 'SF3（壓縮取樣）目前不支援；請使用 .sf2。' : '請選擇 .sf2 檔。';
    return;
  }
  status.textContent = '讀取中…（只在這個播放器的記憶體裡）';
  try {
    const bank = parseSoundFont(await file.arrayBuffer());
    if (bank.compressed) throw new SoundFontError('這個音色庫含壓縮取樣（SF3），目前不支援。');
    sf2Buffers.clear();
    S.sf2 = bank;
    S.sf2Choice = new Array(ROLE_COUNT).fill(0);
    $('voice-sf2').disabled = false;
    $('voice-sf2').checked = true;
    setVoice('sf2');
    status.textContent = `已載入 ${bank.presets.length} 個 preset（只在記憶體中，不會上傳）。`;
    renderSf2Presets();
  } catch (error) {
    status.textContent = error instanceof SoundFontError ? error.message : '無法讀取這個檔案。';
  }
}

function renderSf2Presets() {
  const box = $('sf2-presets');
  box.replaceChildren();
  if (!S.sf2) return;
  const roles = S.view ? S.view.roles : LISTEN_ROLES;
  roles.forEach((role, index) => {
    const select = h('select', { 'aria-label': `${role} preset`, onchange: event => { S.sf2Choice[index] = Number(event.target.value); } });
    S.sf2.presets.forEach((preset, presetIndex) => {
      select.append(h('option', { value: presetIndex, text: `${preset.bank}:${preset.program} ${preset.name}`, selected: presetIndex === S.sf2Choice[index] }));
    });
    box.append(h('label', {}, h('span', { text: role }), select));
  });
}

// ─── sample library (only when the deployment configured one) ──────────────

const GM_PROGRAMS = [
  [0, 'acoustic_grand_piano', '鋼琴'], [4, 'electric_piano_1', '電鋼琴'], [6, 'harpsichord', '大鍵琴'],
  [11, 'vibraphone', '顫音琴'], [12, 'marimba', '馬林巴'], [13, 'xylophone', '木琴'], [19, 'church_organ', '管風琴'],
  [21, 'accordion', '手風琴'], [24, 'acoustic_guitar_nylon', '尼龍弦吉他'], [25, 'acoustic_guitar_steel', '鋼弦吉他'],
  [27, 'electric_guitar_clean', '電吉他'], [32, 'acoustic_bass', '低音提琴撥奏'], [33, 'electric_bass_finger', '電貝斯'],
  [40, 'violin', '小提琴'], [41, 'viola', '中提琴'], [42, 'cello', '大提琴'], [45, 'pizzicato_strings', '弦樂撥奏'],
  [46, 'orchestral_harp', '豎琴'], [48, 'string_ensemble_1', '弦樂合奏'], [52, 'choir_aahs', '合唱'],
  [56, 'trumpet', '小號'], [57, 'trombone', '長號'], [58, 'tuba', '低音號'], [60, 'french_horn', '法國號'],
  [65, 'alto_sax', '中音薩克斯'], [68, 'oboe', '雙簧管'], [71, 'clarinet', '單簧管'], [73, 'flute', '長笛'],
  [74, 'recorder', '直笛'], [75, 'pan_flute', '排笛'], [79, 'ocarina', '陶笛'], [80, 'lead_1_square', '方波'],
  [88, 'pad_1_new_age', '合成墊'], [105, 'banjo', '班鳩琴'], [107, 'koto', '箏'], [108, 'kalimba', '拇指琴'],
];
const sampleBanks = new Map();
const NOTE_NAMES = { C: 0, Db: 1, D: 2, Eb: 3, E: 4, F: 5, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };

function sampleBank(program) {
  let bank = sampleBanks.get(program);
  if (bank) return bank;
  bank = { program, state: 'loading', encoded: new Map(), buffers: new Map(), decoding: new Map() };
  sampleBanks.set(program, bank);
  const entry = GM_PROGRAMS.find(item => item[0] === program);
  const url = `${CONFIG.samples.url}${entry[1]}-mp3.js`;
  bank.ready = fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'force-cache' })
    .then(response => {
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      return response.text();
    })
    .then(text => {
      if (text.length > 12 * 1024 * 1024) throw Error('too large');
      const pattern = /"([A-G]b?)(-?\d)"\s*:\s*"data:audio\/(?:mpeg|mp3);base64,([A-Za-z0-9+/=]+)"/g;
      for (const match of text.matchAll(pattern)) {
        const midi = 12 * (Number(match[2]) + 1) + NOTE_NAMES[match[1]];
        if (midi >= 0 && midi <= 127) bank.encoded.set(midi, match[3]);
      }
      if (!bank.encoded.size) throw Error('no samples');
      bank.state = 'ready';
    })
    .catch(() => { bank.state = 'failed'; });
  return bank;
}

function nearestSample(bank, pitch) {
  let best = null;
  for (const midi of bank.encoded.keys()) if (best === null || Math.abs(midi - pitch) < Math.abs(best - pitch)) best = midi;
  return best;
}

function decodeSample(bank, midi) {
  if (bank.buffers.has(midi) || bank.decoding.has(midi) || !T.ctx) return bank.decoding.get(midi) ?? Promise.resolve();
  const binary = atob(bank.encoded.get(midi));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pending = T.ctx.decodeAudioData(bytes.buffer).then(buffer => { bank.buffers.set(midi, buffer); }).catch(() => { bank.buffers.set(midi, null); });
  bank.decoding.set(midi, pending);
  return pending;
}

async function prepareSamples() {
  if (!CONFIG.samples || !S.song) return;
  const status = $('samples-status');
  try { ensureAudio(); } catch (error) { status.textContent = error.message; return; }
  const jobs = [];
  S.samplePrograms.forEach((program, role) => {
    const bank = sampleBank(program);
    jobs.push(bank.ready.then(() => {
      if (bank.state !== 'ready') return;
      return Promise.all(S.song.pitchesByRole[role].map(pitch => decodeSample(bank, nearestSample(bank, pitch))));
    }));
  });
  status.textContent = '取樣載入中…（尚未載入的音先用預覽合成器）';
  await Promise.all(jobs);
  const failed = [...new Set(S.samplePrograms)].filter(program => sampleBanks.get(program)?.state === 'failed');
  status.textContent = failed.length ? '部分取樣無法載入，那些角色會用預覽合成器。' : '取樣已就緒。';
}

function sampleNote(ctx, dest, note, when, duration) {
  const bank = sampleBanks.get(S.samplePrograms[note.r]);
  if (!bank || bank.state !== 'ready') return false;
  const midi = nearestSample(bank, note.p);
  const buffer = bank.buffers.get(midi);
  if (!buffer) {
    if (midi !== null && !bank.decoding.has(midi)) decodeSample(bank, midi);
    return false;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.setValueAtTime(2 ** ((note.p - midi) / 12), when);
  const gain = ctx.createGain();
  const peak = clamp(note.v, 0, 15) / 15 * 0.6;
  const end = when + Math.max(0.03, duration);
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(peak, when + 0.004);
  gain.gain.setTargetAtTime(0, end, 0.06);
  source.connect(gain);
  gain.connect(dest);
  source.start(when);
  source.stop(end + 0.4);
  track(source, gain);
  return true;
}

function renderSamplePrograms() {
  const box = $('samples-programs');
  box.replaceChildren();
  const roles = S.view ? S.view.roles : LISTEN_ROLES;
  roles.forEach((role, index) => {
    const select = h('select', { 'aria-label': `${role} 取樣音色`, onchange: event => { S.samplePrograms[index] = Number(event.target.value); if (S.voice === 'samples') prepareSamples(); } });
    for (const [program, , label] of GM_PROGRAMS) select.append(h('option', { value: program, text: `${label}（GM ${program}）`, selected: program === S.samplePrograms[index] }));
    box.append(h('label', {}, h('span', { text: role }), select));
  });
}

function setVoice(voice) {
  S.voice = voice;
  for (const input of document.querySelectorAll('input[name="voice"]')) input.checked = input.value === voice;
  if (voice === 'samples') prepareSamples();
  if (T.playing) playFrom(positionSec(), 'voice-change');
}

// ─── drawing ───────────────────────────────────────────────────────────────

function readColors() {
  S.colors = Array.from({ length: ROLE_COUNT }, (_, role) => cssVar(`--r${role}`) || '#888');
  S.palette = {
    bg: cssVar('--roll-bg'), grid: cssVar('--roll-grid'), bar: cssVar('--roll-bar'), text: cssVar('--muted'),
    playhead: cssVar('--playhead'), panel: cssVar('--panel'),
    kinds: {
      'provisional-release': cssVar('--k-provisional'), 'lead-unverified': cssVar('--k-lead'), pending: cssVar('--k-pending'),
      changed: cssVar('--k-changed'), note: cssVar('--k-note'),
    },
  };
  overviewCache = null;
}

function sizeCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const g = canvas.getContext('2d');
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { g, width, height };
}

function followView(beat, center = false) {
  const span = S.viewBeats;
  if (center) S.viewStart = Math.max(0, beat - span * 0.25);
  else if (beat < S.viewStart || beat > S.viewStart + span * 0.88) S.viewStart = Math.max(0, beat - span * 0.1);
  if (S.song) S.viewStart = Math.min(S.viewStart, Math.max(0, S.song.totalBeats - span * 0.5));
}

function drawRoll() {
  const canvas = $('roll');
  if (!S.song || !canvas.clientWidth) return;
  const { g, width, height } = sizeCanvas(canvas);
  const song = S.song;
  const p = S.palette;
  const posBeat = beatAtSec(positionSec());
  if (T.playing) followView(posBeat);
  const start = S.viewStart;
  const span = S.viewBeats;
  const x = beat => (beat - start) / span * width;
  const low = song.pitchMin - 2;
  const high = song.pitchMax + 2;
  const rows = high - low + 1;
  const rowHeight = Math.max(2, (height - 14) / rows);
  const y = pitch => 14 + (high - pitch) * (height - 14) / rows;
  g.fillStyle = p.bg;
  g.fillRect(0, 0, width, height);
  // Beat grid, then bar lines with numbers.
  g.strokeStyle = p.grid;
  g.lineWidth = 1;
  g.beginPath();
  for (let beat = Math.ceil(start); beat <= start + span; beat++) { g.moveTo(Math.round(x(beat)) + 0.5, 14); g.lineTo(Math.round(x(beat)) + 0.5, height); }
  g.stroke();
  g.font = '10px system-ui, sans-serif';
  g.fillStyle = p.text;
  if (S.bars) {
    g.strokeStyle = p.bar;
    g.beginPath();
    const labelEvery = Math.max(1, Math.ceil(28 / Math.max(1, width / span * 4)));
    for (const bar of S.bars) {
      if (bar.end < start) continue;
      if (bar.start > start + span) break;
      const px = Math.round(x(bar.start)) + 0.5;
      g.moveTo(px, 0);
      g.lineTo(px, height);
      if ((bar.index - 1) % labelEvery === 0) g.fillText(String(bar.index), px + 2, 10);
    }
    g.stroke();
  }
  // Markers as translucent bands.
  for (const marker of S.markers) {
    const from = marker.beatNumber;
    const to = marker.endBeatNumber ?? from + 0.25;
    if (to < start || from > start + span) continue;
    g.globalAlpha = 0.18;
    g.fillStyle = p.kinds[marker.kind] || p.text;
    g.fillRect(x(from), 12, Math.max(3, x(to) - x(from)), height - 12);
    g.globalAlpha = 1;
    g.fillRect(x(from), 12, 2, 5);
  }
  // Notes.
  const notes = song.notes;
  const first = lowerBoundBeat(notes, start - song.maxBeats);
  for (let i = first; i < notes.length; i++) {
    const note = notes[i];
    if (note.sb > start + span) break;
    if (note.eb < start) continue;
    g.globalAlpha = audible(note.r) ? 0.9 : 0.18;
    g.fillStyle = S.colors[note.r];
    g.fillRect(x(note.sb), y(note.p) - rowHeight / 2, Math.max(1.5, x(note.eb) - x(note.sb) - 1), Math.max(2, rowHeight - 1));
  }
  g.globalAlpha = 1;
  // Playhead (solid while playing, dashed cursor when stopped).
  const px = x(posBeat);
  g.strokeStyle = p.playhead;
  g.lineWidth = 2;
  if (!T.playing) g.setLineDash([4, 3]);
  g.beginPath();
  g.moveTo(px, 0);
  g.lineTo(px, height);
  g.stroke();
  g.setLineDash([]);
}

function lowerBoundBeat(notes, beat) {
  let low = 0;
  let high = notes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (notes[middle].sb < beat) low = middle + 1;
    else high = middle;
  }
  return low;
}

let overviewCache = null;
function drawOverview() {
  const canvas = $('overview');
  if (!S.song || !canvas.clientWidth) return;
  const { g, width, height } = sizeCanvas(canvas);
  const song = S.song;
  const total = Math.max(song.totalBeats, 1e-6);
  const key = `${width}x${height}|${S.version}|${[...S.solo].join()}|${S.mute.join()}|${S.colors.join()}`;
  if (!overviewCache || overviewCache.key !== key) {
    const off = document.createElement('canvas');
    const ratio = window.devicePixelRatio || 1;
    off.width = Math.round(width * ratio);
    off.height = Math.round(height * ratio);
    const og = off.getContext('2d');
    og.setTransform(ratio, 0, 0, ratio, 0, 0);
    og.fillStyle = S.palette.panel;
    og.fillRect(0, 0, width, height);
    const low = song.pitchMin;
    const range = Math.max(1, song.pitchMax - low);
    for (const note of song.notes) {
      og.globalAlpha = audible(note.r) ? 0.75 : 0.12;
      og.fillStyle = S.colors[note.r];
      og.fillRect(note.sb / total * width, 3 + (1 - (note.p - low) / range) * (height - 8), Math.max(1, (note.eb - note.sb) / total * width), 2);
    }
    og.globalAlpha = 1;
    overviewCache = { key, canvas: off };
  }
  g.drawImage(overviewCache.canvas, 0, 0, width, height);
  for (const marker of S.markers) {
    g.fillStyle = S.palette.kinds[marker.kind] || S.palette.text;
    g.fillRect(marker.beatNumber / total * width - 1, 0, 3, height);
  }
  g.strokeStyle = S.palette.text;
  g.lineWidth = 1;
  g.strokeRect(S.viewStart / total * width + 0.5, 0.5, Math.max(4, S.viewBeats / total * width), height - 1);
  g.fillStyle = S.palette.playhead;
  g.fillRect(beatAtSec(positionSec()) / total * width - 1, 0, 2, height);
}

function drawAll() {
  if (!S.song) return;
  drawRoll();
  drawOverview();
}

function startFrames() {
  if (T.raf) return;
  const frame = () => {
    T.raf = 0;
    renderPosition();
    drawAll();
    if (T.playing) T.raf = requestAnimationFrame(frame);
  };
  T.raf = requestAnimationFrame(frame);
}

// ─── rendering ─────────────────────────────────────────────────────────────

let statusTimer = 0;
function setStatus(text, error = false) {
  const node = $('status');
  node.textContent = text;
  node.classList.toggle('error', error);
  clearTimeout(statusTimer);
  if (text && !error) statusTimer = setTimeout(() => { node.textContent = ''; }, 6000);
}

function renderPosition() {
  if (!S.song) return;
  const place = locate(positionSec());
  $('pos-bar').textContent = place.bar !== null ? `第 ${place.bar} 小節 · 第 ${fmtNumber(place.beatInBar)} 拍` : `beat ${fmtNumber(place.beat)}`;
  $('pos-time').textContent = `${fmtTime(place.seconds)} / ${fmtTime(S.song.duration)}`;
}

function renderTransport() {
  $('play').textContent = T.playing ? '❚❚ 暫停' : '▶ 播放';
  renderPosition();
}

function renderRoles() {
  const box = $('roles');
  if (!S.view) return;
  box.replaceChildren();
  S.view.roles.forEach((role, index) => {
    const silent = !audible(index);
    box.append(h('span', { class: `role${silent ? ' silent' : ''}` },
      h('span', { class: 'dot', style: `background:${S.colors[index] || '#888'}` }),
      h('span', { class: 'name', text: role }),
      h('button', { type: 'button', 'aria-pressed': S.mute[index] ? 'true' : 'false', title: `${role} 靜音`, text: 'M', onclick: () => { S.mute[index] = !S.mute[index]; applyMix(); } }),
      h('button', { type: 'button', 'aria-pressed': S.solo.has(index) ? 'true' : 'false', title: `${role} 獨奏`, text: 'S', onclick: () => { if (S.solo.has(index)) S.solo.delete(index); else S.solo.add(index); applyMix(); } })));
  });
}

function markerPlace(marker) {
  return locate(secAtBeat(marker.beatNumber));
}

function renderMarkers() {
  const list = $('markers');
  list.replaceChildren();
  $('count-markers').textContent = S.markers.length ? `(${S.markers.length})` : '';
  if (!S.markers.length) list.append(h('li', { class: 'small', text: '沒有需要特別聽的位置標記。' }));
  for (const marker of S.markers) {
    const place = markerPlace(marker);
    list.append(h('li', { 'data-marker': marker.id },
      h('span', { class: 'kind', 'data-kind': marker.kind, text: KIND_TEXT[marker.kind] || marker.kind }),
      h('span', { class: 'where', text: place.bar !== null ? `第${place.bar}小節 · ${fmtTime(place.seconds)}` : `beat ${fmtNumber(place.beat)} · ${fmtTime(place.seconds)}` }),
      marker.role ? h('span', { class: 'badge', text: marker.role }) : null,
      h('span', { class: 'label', text: marker.label }),
      h('span', { class: 'actions' },
        h('button', { type: 'button', text: '▶ 聽這裡', title: '從前一小節開始播放', onclick: () => playMarker(marker) }),
        h('button', { type: 'button', text: '聽過沒問題', title: '加入回饋（不是 Gate 確認）', onclick: () => addOk(marker) }))));
  }
  const notes = $('song-notes');
  notes.replaceChildren();
  if (S.songNotes.length) {
    notes.append(h('h2', { text: '整曲待確認（沒有特定位置）' }), h('ul', {}, ...S.songNotes.map(note => h('li', { text: note.label }))));
  }
  const parse = S.view.parse || {};
  const extra = [];
  if (S.song.noTempo) extra.push('MML 沒有 T 指令，以 T120 預覽。');
  if (!S.bars) extra.push(S.view.meter_text ? '拍號圖無法用來分小節，只能用拍與時間定位。' : '沒有拍號圖，只能用拍與時間定位（不會自行假設 4/4）。');
  if (parse.finding_count) extra.push(`試聽讀取有 ${parse.finding_count} 則提醒（不是技術檢查結論）。`);
  if (S.view.truncated_markers) extra.push(`另有 ${S.view.truncated_markers} 個標記超過上限未顯示。`);
  if (S.view.response_compaction) extra.push('回應大小上限：標記已合併成較少的區段（×N 是涵蓋的項目數）。');
  $('parse-note').textContent = extra.join(' ');
}

function renderFeedback() {
  const list = $('feedback');
  list.replaceChildren();
  $('count-feedback').textContent = S.feedback.length ? `(${S.feedback.length})` : '';
  if (!S.feedback.length) list.append(h('li', { class: 'small', text: '播放時按「標記問題」記下位置，或在標記上按「聽過沒問題」。' }));
  S.feedback.forEach((item, index) => {
    list.append(h('li', {},
      h('span', { class: 'kind', 'data-kind': 'feedback', text: item.kind }),
      h('span', { class: 'where', text: item.place.bar !== null ? `第${item.place.bar}小節 · ${fmtTime(item.place.seconds)}` : `beat ${fmtNumber(item.place.beat)} · ${fmtTime(item.place.seconds)}` }),
      h('span', { class: 'badge', text: item.role || '全部' }),
      h('span', { class: 'label', text: item.text || '' }),
      h('span', { class: 'actions' },
        h('button', { type: 'button', text: '▶', title: '從這裡播放', onclick: () => playFrom(secAtBeat(preRollStartBeat(item.place.beat)), 'feedback') }),
        h('button', { type: 'button', text: '刪除', onclick: () => { S.feedback.splice(index, 1); renderFeedback(); } }))));
  });
  $('send').disabled = S.feedback.length === 0;
  $('copy').disabled = S.feedback.length === 0;
}

function renderHeader() {
  const view = S.view;
  $('title').textContent = view.title || 'MML 試聽';
  $('source').textContent = view.source?.kind === 'final_artifact' ? `Final ${String(view.source.artifact_id || '').slice(0, 12)}…` : '內嵌 MML';
  $('preview-notice').textContent = view.preview_notice || '預覽合成器，不是遊戲內音色。';
  $('feedback-notice').textContent = view.feedback_notice || '';
  const hasLink = Boolean(linkInfo());
  $('open-web').hidden = !hasLink;
  $('open-web-here').hidden = !hasLink || typeof CompressionStream === 'undefined';
  $('ab').hidden = !S.songs.B;
  $('jump-bar').disabled = !S.bars;
  $('jump-bar-go').disabled = !S.bars;
  $('jump-bar').max = S.bars ? String(S.bars.length) : '';
  if (CONFIG.samples) {
    $('samples-block').hidden = false;
    $('samples-credit').textContent = CONFIG.samples.credit || '';
    renderSamplePrograms();
  }
}

function renderAll() {
  $('empty').hidden = true;
  $('main').hidden = false;
  renderHeader();
  renderRoles();
  renderMarkers();
  renderFeedback();
  renderTransport();
  drawAll();
  reportSize();
}

// ─── loading a view ────────────────────────────────────────────────────────

const BEAT_TEXT = /^\d{1,9}(?:\/[1-9]\d{0,8})?$/;

function acceptView(view) {
  if (!view || typeof view !== 'object' || view.schema !== VIEW_SCHEMA) return null;
  if (typeof view.mml !== 'string' || view.mml.length > 40000) return null;
  if (!Array.isArray(view.roles) || view.roles.length !== ROLE_COUNT || view.roles.some(role => typeof role !== 'string')) return null;
  return view;
}

function loadView(raw) {
  const view = acceptView(raw);
  if (!view) return false;
  const key = [view.mml_sha256, view.compare_mml_sha256, view.title, (view.markers || []).length, view.listen_link?.url?.length, view.start?.bar].join('|');
  if (key === S.viewKey) return true;
  stop();
  const song = buildSong(view.mml);
  if (song.error) {
    $('empty').hidden = false;
    $('empty').textContent = `無法讀取 MML：${song.error}`;
    return false;
  }
  S.view = view;
  S.viewKey = key;
  S.songs = { A: song, B: typeof view.compare_mml === 'string' ? buildSong(view.compare_mml) : null };
  if (S.songs.B?.error) S.songs.B = null;
  S.feedback = [];
  S.solo.clear();
  S.mute.fill(false);
  selectVersion('A');
  S.markers = (Array.isArray(view.markers) ? view.markers : []).filter(marker => marker && BEAT_TEXT.test(String(marker.beat))).slice(0, 500).map((marker, index) => ({
    id: typeof marker.id === 'string' ? marker.id.slice(0, 16) : `m${index + 1}`,
    kind: KIND_TEXT[marker.kind] ? marker.kind : 'note',
    beat: String(marker.beat),
    beatNumber: listenBeatNumber(marker.beat),
    endBeatNumber: BEAT_TEXT.test(String(marker.end_beat ?? '')) ? listenBeatNumber(marker.end_beat) : null,
    role: typeof marker.role === 'string' && view.roles.includes(marker.role) ? marker.role : null,
    label: String(marker.label ?? '').slice(0, 200),
  }));
  S.songNotes = (Array.isArray(view.song_notes) ? view.song_notes : []).slice(0, 50).map(note => ({ label: String(note?.label ?? '').slice(0, 200) }));
  const startBar = view.start && Number.isSafeInteger(view.start.bar) && S.bars ? S.bars[Math.min(S.bars.length, view.start.bar) - 1] : null;
  S.cursorSec = startBar ? secAtBeat(startBar.start) : 0;
  followView(beatAtSec(S.cursorSec), true);
  readColors();
  renderAll();
  return true;
}

function selectVersion(version) {
  const song = S.songs[version];
  if (!song) return;
  const wasPlaying = T.playing;
  const at = S.song ? positionSec() : 0;
  if (wasPlaying) stop();
  S.version = version;
  S.song = song;
  S.bars = listenBars(S.view.meter_text, song.totalBeats, { pickup: S.view.pickup });
  S.viewBeats = S.bars && S.bars.length ? clamp(S.bars.slice(0, 8).reduce((sum, bar) => sum + (bar.end - bar.start), 0), 8, 64) : 32;
  overviewCache = null;
  $('ver-a').setAttribute('aria-pressed', String(version === 'A'));
  $('ver-b').setAttribute('aria-pressed', String(version === 'B'));
  S.cursorSec = Math.min(at, song.duration);
  if (wasPlaying) playFrom(S.cursorSec, 'version');
  drawAll();
}

// ─── jumping ───────────────────────────────────────────────────────────────

function playFromBar(bar) {
  if (!S.bars) { setStatus('沒有拍號圖，無法用小節定位。', true); return; }
  if (!Number.isSafeInteger(bar) || bar < 1 || bar > S.bars.length) { setStatus(`小節需在 1–${S.bars.length}。`, true); return; }
  playFrom(secAtBeat(S.bars[bar - 1].start), 'bar');
}

function parseClock(text) {
  const value = String(text || '').trim();
  let match = /^(\d{1,3}):(\d{1,2}(?:\.\d+)?)$/.exec(value);
  if (match && Number(match[2]) < 60) return Number(match[1]) * 60 + Number(match[2]);
  match = /^\d{1,5}(?:\.\d+)?$/.exec(value);
  return match ? Number(value) : null;
}

function playFromClock(text) {
  const seconds = parseClock(text);
  if (seconds === null || seconds > S.song.duration) { setStatus(`請輸入 0:00–${fmtTime(S.song.duration)} 之間的時間（例如 1:23）。`, true); return; }
  playFrom(seconds, 'time');
}

function playMarker(marker) {
  followView(marker.beatNumber, true);
  playFrom(secAtBeat(preRollStartBeat(marker.beatNumber)), `marker:${marker.id}`);
}

// ─── feedback ──────────────────────────────────────────────────────────────

function openDraft() {
  if (!S.song) return;
  const place = locate(positionSec());
  S.draft = { place, kind: null };
  $('draft-pos').textContent = `${placeText(place)}${S.version === 'B' ? '｜對照版本 B' : ''}`;
  const kinds = $('draft-kinds');
  kinds.replaceChildren(...FEEDBACK_KINDS.map(kind => h('button', {
    type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-pressed': 'false', text: kind,
    onclick: event => {
      S.draft.kind = kind;
      for (const button of kinds.children) {
        const on = button === event.currentTarget;
        button.setAttribute('aria-pressed', String(on));
        button.setAttribute('aria-checked', String(on));
      }
    },
  })));
  const role = $('draft-role');
  const solo = S.solo.size === 1 ? S.view.roles[[...S.solo][0]] : '';
  role.replaceChildren(h('option', { value: '', text: '全部', selected: !solo }), ...S.view.roles.map(name => h('option', { value: name, text: name, selected: name === solo })));
  $('draft-text').value = '';
  $('draft').hidden = false;
  reportSize();
}

function addFeedback(item) {
  if (S.feedback.length >= MAX_FEEDBACK) { setStatus(`回饋最多 ${MAX_FEEDBACK} 則，請先送出。`, true); return false; }
  S.feedback.push(item);
  S.feedback.sort((a, b) => a.place.seconds - b.place.seconds);
  renderFeedback();
  return true;
}

function submitDraft() {
  if (!S.draft) return;
  if (!S.draft.kind) { setStatus('請先選一個問題種類。', true); return; }
  if (addFeedback({ place: S.draft.place, kind: S.draft.kind, role: $('draft-role').value || null, text: $('draft-text').value.trim().slice(0, 200), ref: null, version: S.version })) {
    setStatus(`已記下：${placeText(S.draft.place)} ${S.draft.kind}`);
  }
  S.draft = null;
  $('draft').hidden = true;
  reportSize();
}

function addOk(marker) {
  const place = markerPlace(marker);
  if (addFeedback({ place, kind: OK_TEXT, role: marker.role, text: marker.label, ref: marker.kind, version: S.version })) {
    setStatus(`已加入回饋：${place.bar !== null ? `第${place.bar}小節` : `beat ${fmtNumber(place.beat)}`} ${OK_TEXT}`);
  }
}

function composeFeedback() {
  const view = S.view;
  const lines = [`MML 試聽回饋：${view.title}`];
  const sha = (S.feedback.some(item => item.version === 'B') ? view.compare_mml_sha256 : view.mml_sha256) || '';
  const source = view.source?.kind === 'final_artifact' ? `Final ${view.source.artifact_id}` : '內嵌 MML';
  lines.push(`MML sha256 ${String(sha).slice(0, 12)}｜${source}${S.feedback.some(item => item.version === 'B') ? '｜含對照版本 B 的回饋' : ''}`);
  for (const item of S.feedback) {
    const parts = [placeText(item.place), item.role || '全部', item.kind];
    if (item.text) parts.push(item.text);
    if (item.ref) parts.push(`[${item.ref}]`);
    if (item.version === 'B') parts.push('版本B');
    lines.push(`- ${parts.join('｜')}`);
  }
  lines.push('（以上是試聽感受，給 AI 修改參考；不是任何 Gate 的確認、證據或接受。改好後請再用 studio_listen 給我聽。）');
  return lines.join('\n');
}

async function sendFeedback() {
  if (!S.feedback.length) return;
  const text = composeFeedback();
  $('send').disabled = true;
  setStatus('送出中…');
  const via = await Bridge.sendMessage(text);
  if (via) {
    S.feedback = [];
    renderFeedback();
    setStatus('已把回饋送到對話。');
  } else {
    $('send').disabled = false;
    showCopy(text);
    setStatus('這個主機不支援從播放器送出訊息；請複製下面的文字貼到對話。', true);
  }
  T.lastSend = { via, text };
}

async function copyFeedback() {
  const text = composeFeedback();
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); copied = true; }
  } catch { copied = false; }
  showCopy(text);
  if (!copied) {
    const area = $('copy-area');
    area.focus();
    area.select();
    try { copied = document.execCommand('copy'); } catch { copied = false; }
  }
  setStatus(copied ? '已複製回饋文字。' : '請手動複製下面的文字。', !copied);
}

function showCopy(text) {
  const area = $('copy-area');
  area.value = text;
  area.hidden = false;
  reportSize();
}

// ─── Studio Web link ───────────────────────────────────────────────────────

function linkInfo() {
  const link = S.view?.listen_link;
  if (!link || typeof link.url !== 'string' || typeof link.origin !== 'string') return null;
  if (!/^https:\/\/[^/?#]+$/.test(link.origin) || !link.url.startsWith(`${link.origin}/#listen=`)) return null;
  return link;
}

/** The listen-link@1 document for the current view, starting at `start`. */
function linkPayload(start) {
  const view = S.view;
  const payload = { schema: ListenLink.LISTEN_LINK_SCHEMA, mml: view.mml, title: view.title };
  if (view.meter_text) payload.meter_text = view.meter_text;
  if (start) payload.start = start;
  if (S.markers.length) {
    payload.markers = S.markers.map(marker => {
      const entry = { beat: marker.beat };
      const source = view.markers.find(item => item.id === marker.id);
      if (source?.end_beat) entry.end_beat = source.end_beat;
      if (marker.role) entry.role = marker.role;
      entry.kind = marker.kind;
      entry.label = marker.label;
      return entry;
    });
  }
  if (typeof view.compare_mml === 'string') payload.compare_mml = view.compare_mml;
  if (view.source?.kind === 'final_artifact') payload.source = { project_id: view.source.project_id, artifact_id: view.source.artifact_id };
  return payload;
}

async function hereLink() {
  const link = linkInfo();
  if (!link) return null;
  const place = locate(positionSec());
  const start = place.bar !== null ? { bar: place.bar } : { beat: String(Math.floor(place.beat)) };
  // The shared contract validates, normalises and encodes (CompressionStream
  // 'deflate-raw'); a document it refuses falls back to the server's link.
  try { return ListenLink.listenUrl(`${link.origin}/`, await ListenLink.encodeListenLink(linkPayload(start))); } catch { return link.url; }
}

async function openLink(url) {
  if (!url) return;
  const ok = await Bridge.openLink(url);
  if (!ok) setStatus('主機沒有開啟連結；請改用文字摘要裡的試聽連結。', true);
}

// ─── host bridge ───────────────────────────────────────────────────────────

const Bridge = (() => {
  const parent = window.parent && window.parent !== window ? window.parent : null;
  const pending = new Map();
  let nextId = 1;
  let connected = false;
  let hostCapabilities = null;
  let sizeObserver = null;

  const post = message => { if (parent) parent.postMessage(message, '*'); };
  const request = (method, params, timeout = 8000) => new Promise((resolve, reject) => {
    if (!parent) { reject(Error('no host')); return; }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('timeout')); }, timeout);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    post({ jsonrpc: '2.0', id, method, params });
  });
  const notify = (method, params) => post(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });

  function applyHostContext(context) {
    if (!context || typeof context !== 'object') return;
    if (context.theme === 'dark' || context.theme === 'light') setTheme(context.theme);
    const font = context.styles?.variables?.['--font-sans'];
    if (typeof font === 'string' && font.length < 300 && !/[;{}<>]/.test(font)) document.documentElement.style.setProperty('--font', font);
  }

  window.addEventListener('message', event => {
    if (!parent || event.source !== parent) return;
    const message = event.data;
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return;
    if (message.method === undefined && message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(Object.assign(Error(String(message.error.message || 'error')), { code: message.error.code }));
      else waiter.resolve(message.result);
      return;
    }
    if (typeof message.method !== 'string') return;
    const reply = result => { if (message.id !== undefined) post({ jsonrpc: '2.0', id: message.id, result }); };
    switch (message.method) {
      case 'ui/notifications/tool-result':
        if (message.params?.isError) {
          if (!S.view) $('empty').textContent = `studio_listen 沒有成功：${String(message.params.content?.[0]?.text ?? '').slice(0, 300)}`;
        } else if (message.params?.structuredContent) loadView(message.params.structuredContent);
        break;
      case 'ui/notifications/tool-input':
      case 'ui/notifications/tool-input-partial':
        if (!S.view) $('empty').textContent = '正在準備試聽內容…';
        break;
      case 'ui/notifications/tool-cancelled':
        if (!S.view) $('empty').textContent = '試聽已取消。';
        break;
      case 'ui/notifications/host-context-changed':
        applyHostContext(message.params);
        break;
      case 'ui/resource-teardown':
        stop();
        reply({});
        break;
      case 'ping':
        reply({});
        break;
      default:
        if (message.id !== undefined) post({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    }
  });

  async function connect() {
    if (!parent) return false;
    try {
      const result = await request('ui/initialize', {
        protocolVersion: MCP_APPS_PROTOCOL,
        appInfo: { name: 'mml-studio-listen', version: '1.0.0' },
        appCapabilities: { availableDisplayModes: ['inline'] },
      }, 4000);
      connected = true;
      hostCapabilities = result?.hostCapabilities || {};
      applyHostContext(result?.hostContext);
      notify('ui/notifications/initialized');
      startSizeReports();
      return true;
    } catch { return false; }
  }

  function startSizeReports() {
    if (sizeObserver || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    sizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reportSize);
    });
    sizeObserver.observe(document.body);
  }

  function reportHeight() {
    const height = Math.ceil(document.getElementById('app').getBoundingClientRect().height) + 2;
    if (connected) notify('ui/notifications/size-changed', { width: Math.ceil(window.innerWidth), height });
    else if (window.openai?.notifyIntrinsicHeight) { try { window.openai.notifyIntrinsicHeight(height); } catch { /* optional */ } }
  }

  async function sendMessage(text) {
    if (connected) {
      try {
        const result = await request('ui/message', { role: 'user', content: [{ type: 'text', text }] }, 10000);
        if (!result?.isError) return 'ui/message';
      } catch { /* fall through */ }
    }
    if (typeof window.openai?.sendFollowUpMessage === 'function') {
      try {
        await window.openai.sendFollowUpMessage({ prompt: text });
        return 'openai.sendFollowUpMessage';
      } catch { /* fall through */ }
    }
    return null;
  }

  async function openLink(url) {
    if (connected) {
      try {
        const result = await request('ui/open-link', { url }, 8000);
        if (!result?.isError) return true;
      } catch { /* fall through */ }
    }
    if (typeof window.openai?.openExternal === 'function') {
      try { window.openai.openExternal({ href: url }); return true; } catch { /* fall through */ }
    }
    try { return Boolean(window.open(url, '_blank', 'noopener,noreferrer')); } catch { return false; }
  }

  return {
    connect, sendMessage, openLink, reportHeight,
    get connected() { return connected; },
    get hostCapabilities() { return hostCapabilities; },
  };
})();

function reportSize() { Bridge.reportHeight(); }

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  readColors();
  renderRoles();
  drawAll();
}

// ─── wiring ────────────────────────────────────────────────────────────────

function wire() {
  $('play').addEventListener('click', () => {
    if (T.playing) stop();
    else playFrom(positionSec() >= S.song.duration - 0.01 ? 0 : positionSec(), 'play');
  });
  // Stop returns the cursor to where this playback started, so the same
  // passage can be heard again with one more press.
  $('stop').addEventListener('click', () => {
    const back = T.lastStart ? T.lastStart.seconds : 0;
    stop();
    seekSeconds(back, 'stop');
  });
  $('rewind').addEventListener('click', () => seekSeconds(0, 'rewind'));
  $('mark').addEventListener('click', openDraft);
  $('draft-add').addEventListener('click', submitDraft);
  $('draft-text').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); submitDraft(); } });
  $('draft-cancel').addEventListener('click', () => { S.draft = null; $('draft').hidden = true; reportSize(); });
  $('jump-bar-go').addEventListener('click', () => playFromBar(Number($('jump-bar').value)));
  $('jump-bar').addEventListener('keydown', event => { if (event.key === 'Enter') playFromBar(Number($('jump-bar').value)); });
  $('jump-time-go').addEventListener('click', () => playFromClock($('jump-time').value));
  $('jump-time').addEventListener('keydown', event => { if (event.key === 'Enter') playFromClock($('jump-time').value); });
  $('ver-a').addEventListener('click', () => selectVersion('A'));
  $('ver-b').addEventListener('click', () => selectVersion('B'));
  $('zoom-in').addEventListener('click', () => { S.viewBeats = clamp(S.viewBeats / 1.5, 4, 512); drawAll(); });
  $('zoom-out').addEventListener('click', () => { S.viewBeats = clamp(S.viewBeats * 1.5, 4, 512); drawAll(); });
  $('send').addEventListener('click', sendFeedback);
  $('copy').addEventListener('click', copyFeedback);
  $('open-web').addEventListener('click', () => openLink(linkInfo()?.url));
  $('open-web-here').addEventListener('click', async () => openLink(await hereLink()));
  $('sf2-file').addEventListener('change', event => loadSoundFontFile(event.target.files?.[0]));
  for (const input of document.querySelectorAll('input[name="voice"]')) input.addEventListener('change', event => { if (event.target.checked) setVoice(event.target.value); });
  document.querySelectorAll('.tabs [role="tab"]').forEach(tab => tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tabs [role="tab"]')) {
      const on = other === tab;
      other.setAttribute('aria-selected', String(on));
      $(`tab-${other.dataset.tab}`).hidden = !on;
    }
    reportSize();
  }));
  $('roll').addEventListener('click', event => {
    if (!S.song) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const beat = S.viewStart + (event.clientX - rect.left) / rect.width * S.viewBeats;
    seekSeconds(secAtBeat(clamp(beat, 0, S.song.totalBeats)), 'roll');
  });
  $('overview').addEventListener('click', event => {
    if (!S.song) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const beat = (event.clientX - rect.left) / rect.width * S.song.totalBeats;
    followView(beat, true);
    seekSeconds(secAtBeat(clamp(beat, 0, S.song.totalBeats)), 'overview');
  });
  const app = $('app');
  app.addEventListener('dragover', event => { if (event.dataTransfer?.types?.includes('Files')) event.preventDefault(); });
  app.addEventListener('drop', event => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    event.preventDefault();
    loadSoundFontFile(file);
  });
  document.addEventListener('keydown', event => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLButtonElement) return;
    if (event.key === ' ' && S.song) {
      event.preventDefault();
      if (T.playing) stop(); else playFrom(positionSec(), 'key');
    }
  });
  window.addEventListener('resize', () => { overviewCache = null; drawAll(); });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { readColors(); renderRoles(); drawAll(); });
}

// A read-only handle for hosts without a bridge and for automated checks. It
// exposes nothing a page could not already see.
window.__mmlListen = Object.freeze({
  load: view => loadView(view),
  snapshot: () => ({
    loaded: Boolean(S.view),
    title: S.view?.title ?? null,
    version: S.version,
    roles: S.view ? [...S.view.roles] : [],
    note_count: S.song ? S.song.notes.length : 0,
    duration: S.song ? S.song.duration : 0,
    bar_count: S.bars ? S.bars.length : null,
    markers: S.markers.map(marker => ({ id: marker.id, kind: marker.kind, beat: marker.beat })),
    song_notes: S.songNotes.map(note => note.label),
    playing: T.playing,
    audible_roles: S.view ? S.view.roles.filter((_, role) => audible(role)) : [],
    cursor_seconds: S.cursorSec,
    last_start: T.lastStart,
    scheduled: T.log.slice(0, 64),
    voice: S.voice,
    voice_counts: { ...T.voiceCounts },
    sf2_presets: S.sf2 ? S.sf2.presets.map(preset => `${preset.bank}:${preset.program} ${preset.name}`) : [],
    feedback_count: S.feedback.length,
    feedback_text: S.view ? composeFeedback() : '',
    last_send: T.lastSend ?? null,
    bridge: { connected: Bridge.connected },
    audio_state: T.ctx ? T.ctx.state : 'not_started',
  }),
  events: () => (S.song ? S.song.parsed.tracks.map(track => ({ role: track.role, total: track.total, events: track.events })) : []),
  hereLink: () => hereLink(),
  preRollStartSeconds: beat => secAtBeat(preRollStartBeat(beat)),
});

wire();
readColors();
if (window.openai?.theme === 'dark' || window.openai?.theme === 'light') setTheme(window.openai.theme);
if (window.openai?.toolOutput) loadView(window.openai.toolOutput);
window.addEventListener('openai:set_globals', event => {
  const globals = event.detail?.globals;
  if (globals?.theme === 'dark' || globals?.theme === 'light') setTheme(globals.theme);
  if (globals?.toolOutput) loadView(globals.toolOutput);
}, { passive: true });
Bridge.connect();
