// Listening sessions (試聽工作階段): the page where the owner hears exactly the
// places that need a human ear, marks what they heard, and copies it for the
// next revision.
//
//   L1  play from a bar, a time or a marker (with a bar of lead-in), see the
//       current bar / beat / time, stop and replay from the same point, mute
//       or solo roles;
//   L2  changed bars against a previous version, "play changed bars only",
//       and an A/B switch to hear the same bars in the old version;
//   L3  notes at a position, bar and role, kept with the session (and with the
//       project it came from), with a plain-text "copy for AI".
//
// Boundaries. A session is separate from projects: opening a listen link never
// creates, opens or overwrites a project, never plays by itself (audio needs a
// user gesture) and removes the payload from the address bar once imported.
// Every string from a link is untrusted and is escaped wherever it is shown.
// Playback reuses the Final preview's engine and scheduler through `audio`
// (app.mjs); listening passes no gate and records no review or readback.
import { decodeListenLink, encodeListenLink, listenPayloadFromUrl, listenUrl, withoutListenPayload, LISTEN_LINK_SCHEMA, LISTEN_LIMITS } from './listen-link.mjs';
import {
  LISTEN_ROLE_NAMES, barStart, changedBars, changedPlaybackPlan, changedRegions, diffSongs, formatClock, listenBars,
  parseClock, positionAt, positionAtNumber, rollProjection, seekPlan, snapToMeterBeat, songClock, songsEnd,
} from './listen-timeline.mjs';
import { MARKER_KIND_LABELS, NOTE_KINDS, normalizeNote, notesAsMarkers, notesExportText, sortNotes } from './listen-notes.mjs';
import { MAX_SESSIONS, deleteSession, getSession, listSessions, saveSession } from './listen-store.mjs';
import { mountReviewRoll } from './review-roll.mjs';
import { beatNumber, cmpBeat, parseBeat } from './roll-geometry.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ROLES = LISTEN_ROLE_NAMES;
const PRE_ROLL_CHOICES = [0, 1, 2, 4];
const hex = buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
export const mmlSha256 = async text => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const noteKindLabel = id => NOTE_KINDS.find(kind => kind.id === id)?.label ?? id;
const when = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(); };

/**
 * @param {object} host
 * @param {HTMLElement} host.root            the #listening section
 * @param {Function} host.call               Worker call (parseListening)
 * @param {Function} host.message            status toast
 * @param {Function} host.copyText           clipboard with visible fallback
 * @param {object} host.audio                shared preview engine (app.mjs)
 * @param {Function} [host.saveProjectNote]  mirror a note change to its project
 */
export function createListening({ root, call, message, copyText, audio, saveProjectNote = async () => {} }) {
  const state = {
    sessions: [], session: null, parsed: null, compare: null, bars: [], meters: [], assumed: true, meterError: null,
    clocks: { current: null, compare: null }, changes: null, markers: [], cue: { beat: '0' }, lastPlan: null,
    playing: false, position: { seconds: 0, beat: 0 }, queue: null, version: 'current', highlight: null,
    muted: [false, false, false, false, false, false], solo: [false, false, false, false, false, false],
    selectedEvent: null, editingNoteId: null, confirmDelete: false, loading: false, error: null, stopNote: null,
  };
  let roll = null;

  // ─── sessions ─────────────────────────────────────────────────────────
  async function refreshSessions() {
    try { state.sessions = await listSessions(); } catch (error) { state.sessions = []; state.error = error.message; }
  }
  async function createSession(fields) {
    await refreshSessions();
    if (state.sessions.length >= MAX_SESSIONS) throw Error(`試聽工作階段已達 ${MAX_SESSIONS} 個上限，請先刪除舊的工作階段`);
    const now = new Date().toISOString();
    const session = {
      id: crypto.randomUUID(), createdAt: now, preRollBars: 1, notes: [], markers: [], start: null, compareMml: null, compareLabel: null, alternatives: [],
      ...fields, mmlSha256: await mmlSha256(fields.mml),
    };
    return saveSession(session);
  }
  async function persist() {
    if (!state.session) return;
    state.session = await saveSession(state.session);
    await refreshSessions();
  }

  // ─── import ───────────────────────────────────────────────────────────
  /**
   * Import a listen link from the page address, if there is one. The payload
   * is removed from the address bar whatever the outcome, so a reload never
   * imports it twice and it does not linger in history.
   */
  async function importFromLocation(location = globalThis.location, history = globalThis.history) {
    let found;
    try { found = listenPayloadFromUrl(location.href); } catch { found = null; }
    if (!found) return null;
    try { history.replaceState(history.state, '', withoutListenPayload(location.href)); } catch { /* the import still proceeds */ }
    return importPayload(found.payload);
  }
  async function importPayload(payload) {
    show();
    state.loading = true; render();
    try {
      const link = await decodeListenLink(payload);
      const session = await createSession({
        title: link.title ?? '試聽連結', origin: { kind: 'link', ...(link.source ? { source: link.source } : {}) },
        mml: link.mml, meterText: link.meter_text ?? null, start: link.start ?? null, markers: link.markers ?? [],
        compareMml: link.compare_mml ?? null, compareLabel: link.compare_mml ? '連結提供的前一版' : null,
      });
      await open(session.id);
      message('已從試聽連結建立新的試聽工作階段；按「播放」才會發出聲音。沒有建立或覆寫任何專案。');
      return session;
    } catch (error) {
      state.loading = false; state.error = `試聽連結無法開啟：${error.message}`;
      render(); message(state.error, true);
      return null;
    }
  }
  /** Open a new session for an MML shown in a project (Final, candidate, …). */
  async function openFromProject({ projectId, projectTitle, label, mml, meterText, markers = [], notes = [], alternatives = [] }) {
    if (typeof mml !== 'string' || !mml.trim()) throw Error('沒有可送到試聽的 MML');
    if (mml.trim().length > LISTEN_LIMITS.mmlChars) throw Error(`MML 超過 ${LISTEN_LIMITS.mmlChars} 字，無法建立試聽工作階段`);
    show();
    const text = mml.trim();
    const sha = await mmlSha256(text);
    const session = await createSession({
      title: `${projectTitle || '未命名專案'} · ${label}`.slice(0, LISTEN_LIMITS.titleChars),
      origin: { kind: 'project', projectId, projectTitle: String(projectTitle ?? '').slice(0, 200), label },
      mml: text, meterText: meterText?.trim() ? meterText : null, markers: markers.slice(0, LISTEN_LIMITS.markers),
      notes: notes.filter(note => note.mmlSha256 === sha),
      alternatives: alternatives.filter(item => typeof item?.mml === 'string' && item.mml.trim() && item.mml.trim() !== text).slice(0, 4).map(item => ({ label: String(item.label).slice(0, 80), mml: item.mml.trim().slice(0, LISTEN_LIMITS.mmlChars) })),
    });
    await open(session.id);
    root.scrollIntoView?.({ block: 'start' });
    message('已建立試聽工作階段；按「播放」開始聆聽。');
    return session;
  }

  // ─── opening a session ────────────────────────────────────────────────
  async function open(id) {
    stop({ quiet: true });
    state.loading = true; state.error = null; render();
    try {
      const session = await getSession(id);
      const parsed = await call('parseListening', session.mml);
      const compare = session.compareMml ? { label: session.compareLabel ?? '比較版本', mml: session.compareMml, parsed: await call('parseListening', session.compareMml) } : null;
      Object.assign(state, { session, parsed, compare, version: 'current', queue: null, highlight: null, selectedEvent: null, editingNoteId: null, confirmDelete: false, lastPlan: null, stopNote: null });
      layout();
      state.cue = { beat: startBeat(session.start) };
      state.position = { seconds: clock().secondsAt(state.cue.beat), beat: beatNumber(state.cue.beat) };
    } catch (error) {
      state.session = null; state.error = error.message;
    }
    state.loading = false;
    await refreshSessions();
    render();
  }
  // Bars, clocks, markers and changes for what is loaded.
  function layout() {
    const songs = [state.parsed?.song, state.compare?.parsed?.song].filter(Boolean);
    const end = songsEnd(...songs);
    state.meterError = null;
    let grid;
    try { grid = listenBars(state.session.meterText, end); }
    catch (error) { state.meterError = error.message; grid = listenBars(null, end); }
    state.bars = grid.bars; state.meters = grid.meters; state.assumed = grid.assumed;
    state.clocks = { current: state.parsed?.song ? songClock(state.parsed.song) : null, compare: state.compare?.parsed?.song ? songClock(state.compare.parsed.song) : null };
    state.markers = [...(state.session.markers ?? []), ...notesAsMarkers(state.session.notes ?? [])]
      .sort((a, b) => cmpBeat(parseBeat(a.beat), parseBeat(b.beat)));
    state.changes = null;
    if (state.compare?.parsed?.ok && state.parsed?.ok) {
      const list = diffSongs(state.compare.parsed.song, state.parsed.song);
      const bars = changedBars(list, state.bars);
      state.changes = { count: list.length, bars, regions: changedRegions(bars) };
    }
  }
  function startBeat(start) {
    try {
      if (start?.bar) return barStart(state.bars, Math.min(start.bar, state.bars.length));
      if (start?.beat) return start.beat;
    } catch { /* fall through to the beginning */ }
    return '0';
  }
  const clock = (version = state.version) => state.clocks[version] ?? state.clocks.current ?? songClock(null);
  const playable = version => (version === 'compare' ? state.compare?.parsed?.ok : state.parsed?.ok) === true;
  const effectiveMuted = () => state.muted.map((muted, i) => muted || (state.solo.some(Boolean) && !state.solo[i]));

  // ─── playback ─────────────────────────────────────────────────────────
  // Every playback goes through here, inside the click that asked for it.
  function play(plan, { queue = null, version = state.version } = {}) {
    if (!state.session) return;
    if (!playable(version)) { status(version === 'compare' ? '比較版本無法解析，不能播放。' : '這份 MML 有無法解析的內容，不能播放。'); return; }
    const song = version === 'compare' ? state.compare.parsed.song : state.parsed.song;
    state.lastPlan = { ...plan, version };
    state.stopNote = null;
    state.queue = queue;
    state.version = version;
    state.playing = true;
    state.position = { seconds: plan.fromSeconds, beat: clock(version).beatAt(plan.fromSeconds) };
    renderPosition();
    renderTransport();
    const request = audio.play({
      key: `listen:${state.session.id}:${version}`, song, from: plan.fromSeconds, until: plan.untilSeconds ?? null, muted: effectiveMuted(),
      handlers,
    });
    Promise.resolve(request).then(() => renderTransport(), error => {
      state.playing = false; state.queue = null;
      renderPosition(); renderTransport();
      status(`無法播放：${error.message}`);
      message(error.message, true);
    });
  }
  // One handlers object for every playback of this page, so replacing one
  // listening playback with the next is not mistaken for another player
  // taking the engine.
  const handlers = Object.freeze({ onPosition: (...args) => onPosition(...args), onEnd: (...args) => onEnd(...args), onPreempt: reason => onPreempt(reason) });
  function onPosition(seconds) {
    if (!state.playing) return;
    const beat = clock().beatAt(seconds);
    state.position = { seconds, beat };
    renderPosition();
    roll?.setPlayhead(beat, { follow: true });
  }
  function onEnd() {
    if (!state.playing) return;
    const queue = state.queue;
    if (queue && queue.index + 1 < queue.plans.length) {
      queue.index += 1;
      const next = queue.plans[queue.index];
      focus({ start: next.region.start, end: next.region.end });
      status(`變更小節 ${queue.index + 1}／${queue.plans.length}：第 ${next.region.fromBar}${next.region.toBar !== next.region.fromBar ? `–${next.region.toBar}` : ''} 小節`);
      play(next, { queue, version: state.version });
      return;
    }
    state.playing = false; state.queue = null;
    returnToCue();
    status(queue ? '變更小節已全部播放完畢。' : '播放結束。');
  }
  // Another player (the Final preview) took the engine, or a bank change
  // stopped it. The page redraws the player on a bank change, so the reason
  // is kept to be drawn again.
  function onPreempt(reason) {
    if (!state.playing) return;
    state.playing = false; state.queue = null;
    returnToCue();
    status(reason === 'bank' ? '試聽已停止：音色庫已變更。' : '試聽已停止：音色試聽被其他播放器使用。', { keep: true });
  }
  function returnToCue() {
    const seconds = state.cue.seconds ?? clock().secondsAt(state.cue.beat);
    state.position = { seconds, beat: clock().beatAt(seconds) };
    roll?.setPlayhead(state.position.beat);
    renderPosition(); renderTransport();
  }
  function stop({ quiet = false } = {}) {
    const was = state.playing;
    state.playing = false; state.queue = null;
    if (was) audio.stop();
    if (!quiet && state.session) { returnToCue(); status('已停止，回到起點。'); }
  }
  function setCue(plan) {
    state.cue = plan.fromBeat !== null && plan.fromBeat !== undefined ? { beat: plan.fromBeat } : { seconds: plan.fromSeconds };
  }
  function planFromBeat(beat, { preRoll = 0, until = null } = {}) {
    return seekPlan({ bars: state.bars, clock: clock(), beat, preRollBars: preRoll, untilBeat: until });
  }
  function focus(region) {
    state.highlight = region;
    roll?.focusRegion(region);
  }
  function applyMutes() {
    if (!state.playing) return;
    effectiveMuted().forEach((value, role) => audio.setMuted(role, value));
  }

  // ─── rendering ────────────────────────────────────────────────────────
  function show() { root.hidden = false; }
  function hide() { stop({ quiet: true }); root.hidden = true; }
  function status(text, { keep = false } = {}) { state.stopNote = keep ? text : null; const el = root.querySelector('#listen-status'); if (el) el.textContent = text; }

  function render() {
    const keepScroll = root.querySelector('#listen-roll .roll-stage')?.scrollLeft ?? null;
    root.innerHTML = `<div class="section-heading"><h2 id="listening-title">試聽工作階段</h2><button type="button" class="quiet" id="listen-close">關閉試聽</button></div>
      ${sessionsCard()}
      ${state.loading ? '<div class="card"><p class="meta" role="status">正在讀取試聽內容…</p></div>' : state.session ? sessionBody() : `<div class="card"><div class="empty">${state.error ? esc(state.error) : '尚未開啟試聽工作階段。<br>在第 06 節或第 07 節按「送到試聽」，或開啟一個試聽連結。'}</div></div>`}`;
    bind();
    if (state.session && !state.loading) mountRoll(keepScroll);
  }
  function sessionsCard() {
    const options = state.sessions.map(item => `<option value="${esc(item.id)}" ${item.id === state.session?.id ? 'selected' : ''}>${esc(item.title)} · ${esc(when(item.updatedAt))}</option>`).join('');
    return `<div class="card listen-sessions">
      <p class="note">試聽是<strong>聆聽輔助</strong>：用這台裝置的音色庫播放，不是遊戲音色，也不是實機驗收。播放、標記與備註不會通過任何 Gate，也不會改寫專案的來源或審核。</p>
      ${state.error && state.session ? `<p class="note">${esc(state.error)}</p>` : ''}
      <div class="listen-row"><label class="listen-grow">已保存的試聽工作階段<select id="listen-session-select" ${state.sessions.length ? '' : 'disabled'}>${options || '<option>尚無試聽工作階段</option>'}</select></label>
        <button type="button" class="secondary" id="listen-session-open" ${state.sessions.length ? '' : 'disabled'}>開啟</button>
        <button type="button" class="quiet" id="listen-session-delete" ${state.session ? '' : 'disabled'} aria-live="polite">${state.confirmDelete ? '再按一次確認刪除' : '刪除目前工作階段'}</button></div>
      <details class="listen-paste"><summary>貼上試聽連結</summary><form id="listen-link-form"><label>試聽連結（含 #listen=）<input name="link" autocomplete="off" spellcheck="false" required></label><div class="actions"><button>開啟連結</button></div></form></details>
    </div>`;
  }
  function sessionBody() {
    const s = state.session;
    const origin = s.origin?.kind === 'project'
      ? `來自專案「${esc(s.origin.projectTitle || '未命名專案')}」· ${esc(s.origin.label ?? '')}`
      : '來自試聽連結';
    const provenance = s.origin?.source ? `<p class="meta">連結附帶的來源（僅供顯示，未驗證）：${s.origin.source.project_id ? `project <code>${esc(s.origin.source.project_id)}</code>` : ''} ${s.origin.source.artifact_id ? `artifact <code>${esc(s.origin.source.artifact_id)}</code>` : ''}</p>` : '';
    const meter = state.assumed
      ? `<p class="note" id="listen-meter-assumed">未提供拍號圖：小節以 <strong>4/4 假設</strong>（assumed）計算，小節號可能與原曲不同。${state.meterError ? `（拍號圖無法使用：${esc(state.meterError)}）` : ''}</p>`
      : `<p class="meta">拍號圖：<code>${esc(String(s.meterText).split('\n').join('; '))}</code></p>`;
    const problems = findings(state.parsed, '目前版本');
    return `<div class="card" id="listen-head"><div class="attempt-head"><h3>${esc(s.title)}</h3><span class="badge na">試聽</span></div>
        <p class="meta">${origin} · 建立於 ${esc(when(s.createdAt))} · ${state.bars.length} 小節<br>MML sha256 <code class="digest" id="listen-sha">${esc(s.mmlSha256)}</code></p>
        ${provenance}${meter}${problems}</div>
      ${playerCard()}
      ${markersCard()}
      ${changesCard()}
      ${rollCard()}
      ${notesCard()}`;
  }
  function findings(parsed, label) {
    if (!parsed) return '';
    const errors = parsed.errors ?? [], warnings = parsed.warnings ?? [];
    const list = items => `<ul class="codes">${items.slice(0, 12).map(item => `<li>${item.role ? `${esc(item.role)} · ` : ''}${item.position ? `第 ${esc(item.position)} 字 · ` : ''}${esc(item.message)}</li>`).join('')}</ul>`;
    return `${errors.length ? `<p class="note"><strong>${esc(label)}無法試聽</strong>：解析器回報 ${parsed.errorCount ?? errors.length} 個錯誤。</p>${list(errors)}` : ''}${warnings.length ? `<details><summary>${esc(label)}：${parsed.warningCount ?? warnings.length} 個解析提醒（不影響試聽）</summary>${list(warnings)}</details>` : ''}`;
  }
  function bankLine() {
    const info = audio.status();
    if (info.bank === undefined) return '讀取音色庫中…';
    if (info.bank) return `音色庫：${esc(info.bank.name)}（你選擇的音色庫，只保存在這台裝置）`;
    // The free default bank: whether it is on this device, or what the first
    // playback will download, and that download's progress (app.mjs).
    return info.fallback ? `音色庫：<strong>${esc(info.fallback)}</strong>${info.fallbackNote ? `<br><span data-default-bank-note>${esc(info.fallbackNote)}</span>` : ''}` : '尚未選擇音色庫。選擇後才能試聽；音色庫只保存在這台裝置，不會上傳。';
  }
  const instruments = () => audio.instruments?.() ?? { options: [], choices: [], defaultBank: false };
  function playerCard() {
    const info = audio.status();
    const ready = Boolean(info.bank || info.fallback) && playable(state.version);
    const inst = instruments();
    const instrument = i => `<select data-listen-instrument="${i}" aria-label="${ROLES[i]} 音色" ${inst.options.length ? '' : 'disabled'}>${inst.options.length ? inst.options.map(o => `<option value="${esc(o.value)}" ${o.value === inst.choices[i] ? 'selected' : ''}>${esc(o.label)}</option>`).join('') : '<option>按播放後載入音色清單</option>'}</select>`;
    const roles = ROLES.map((role, i) => `<div class="listen-role"><span class="listen-role-name">${role}</span>${instrument(i)}<button type="button" class="quiet" data-listen-mute="${i}" aria-pressed="${state.muted[i]}" aria-label="${role} 靜音">靜音</button><button type="button" class="quiet" data-listen-solo="${i}" aria-pressed="${state.solo[i]}" aria-label="${role} 獨奏">獨奏</button></div>`).join('');
    return `<div class="card" id="listen-player" data-ready="${Boolean(info.bank || info.fallback)}" data-default-cached="${Boolean(info.defaultCached)}" data-instruments="${esc(inst.options.map(o => o.value).join(','))}"><h3>播放</h3>
      <div class="listen-row"><span class="meta" id="listen-bank">${bankLine()}</span><label class="file-button quiet">${info.bank ? '更換音色庫' : '選擇自己的音色庫'}<input type="file" id="listen-bank-file" accept=".dls,.sf2,.sf3" aria-label="選擇音色庫檔案"></label>${info.defaultCached ? '<button type="button" class="quiet" id="listen-default-bank-clear">刪除這台裝置上的免費音色</button>' : ''}</div>
      <p class="listen-position" id="listen-position" aria-live="off"></p>
      <div class="actions listen-transport" id="listen-transport"></div>
      <p class="meta" id="listen-cue"></p>
      <div class="listen-forms">
        <form id="listen-from-bar" class="listen-inline"><label>從小節<input name="bar" type="number" min="1" max="${state.bars.length}" step="1" inputmode="numeric" required></label><button ${ready ? '' : 'disabled'}>▶ 從此小節播放</button></form>
        <form id="listen-from-time" class="listen-inline"><label>從時間（分:秒）<input name="time" inputmode="decimal" placeholder="1:23" autocomplete="off" required></label><button ${ready ? '' : 'disabled'}>▶ 從此時間播放</button></form>
        <label class="listen-inline-label">標記與變更的前導<select id="listen-preroll">${PRE_ROLL_CHOICES.map(n => `<option value="${n}" ${n === (state.session.preRollBars ?? 1) ? 'selected' : ''}>${n ? `${n} 小節` : '不加前導'}</option>`).join('')}</select></label>
      </div>
      <div class="listen-roles" role="group" aria-label="角色音色、靜音與獨奏">${roles}</div>
      ${inst.defaultBank ? `<p class="meta">音色為${esc(info.fallback ?? '')}：以 GM 音色近似遊戲樂器名稱，只供聆聽。</p>` : ''}
      <p class="meta" id="listen-status" role="status" aria-live="polite">${esc(state.stopNote ?? '')}</p></div>`;
  }
  function transportButtons() {
    const info = audio.status();
    const ready = Boolean(info.bank || info.fallback) && playable(state.version);
    return `<button type="button" id="listen-play" ${ready ? '' : 'disabled'}>▶ 從起點播放</button>
      <button type="button" class="secondary" id="listen-stop" ${state.playing ? '' : 'disabled'}>■ 停止</button>
      <button type="button" class="secondary" id="listen-replay" ${ready && state.lastPlan ? '' : 'disabled'}>⟲ 重播同一段</button>`;
  }
  function renderTransport() {
    const box = root.querySelector('#listen-transport');
    if (!box) return;
    box.innerHTML = transportButtons();
    root.querySelector('#listen-play').onclick = () => { const plan = state.cue.seconds !== undefined ? { fromBeat: null, fromSeconds: state.cue.seconds, untilSeconds: null } : planFromBeat(state.cue.beat); play(plan); };
    root.querySelector('#listen-stop').onclick = () => stop();
    root.querySelector('#listen-replay').onclick = () => { if (state.lastPlan) { const { version, ...plan } = state.lastPlan; play(plan, { version }); } };
    const cue = root.querySelector('#listen-cue');
    if (cue) {
      const seconds = state.cue.seconds ?? clock().secondsAt(state.cue.beat);
      const at = state.cue.beat !== undefined ? positionAt(state.bars, state.cue.beat) : positionAtNumber(state.bars, clock().beatAt(seconds));
      cue.textContent = `起點：第 ${at.bar} 小節 · 第 ${at.beat} 拍 · ${formatClock(seconds)}${state.lastPlan?.untilSeconds ? `　上次播放範圍 ${formatClock(state.lastPlan.fromSeconds)}–${formatClock(state.lastPlan.untilSeconds)}` : ''}`;
    }
  }
  function renderPosition() {
    const el = root.querySelector('#listen-position');
    if (!el) return;
    const c = clock();
    const at = positionAtNumber(state.bars, state.position.beat);
    el.textContent = `第 ${at.bar} 小節 · 第 ${at.beat} 拍 · ${formatClock(state.position.seconds)} / ${formatClock(c.duration)}${state.version === 'compare' ? ' · B 比較版本' : ''}`;
    el.dataset.state = state.playing ? 'playing' : 'stopped';
    el.dataset.seconds = String(Math.round(state.position.seconds * 1000) / 1000);
    el.dataset.bar = String(at.bar);
    el.dataset.version = state.version;
    const plan = state.lastPlan;
    el.dataset.fromSeconds = plan ? String(Math.round(plan.fromSeconds * 1000) / 1000) : '';
    el.dataset.untilSeconds = plan?.untilSeconds ? String(Math.round(plan.untilSeconds * 1000) / 1000) : '';
    el.dataset.fromBeat = plan?.fromBeat ?? '';
  }
  // Plain text; escaped where it is inserted as HTML.
  function markerLine(marker) {
    const at = positionAt(state.bars, marker.beat);
    return `第 ${at.bar} 小節${marker.scope === 'song' ? '（整首）' : ` · 第 ${at.beat} 拍`}${marker.role ? ` · ${marker.role}` : ''} · ${MARKER_KIND_LABELS[marker.kind] ?? marker.kind}`;
  }
  function markersCard() {
    const preRoll = state.session.preRollBars ?? 1;
    return `<div class="card" id="listen-markers"><h3>標記（${state.markers.length}）</h3>
      <p class="meta">點選標記會從標記所在小節${preRoll ? `前 ${preRoll} 小節` : ''}開始播放，並在捲軸上標示範圍。試聽備註也會在這裡列為標記。</p>
      ${state.markers.length ? `<ol class="listen-list">${state.markers.map((marker, i) => `<li class="listen-kind-${esc(marker.kind)}"><button type="button" class="quiet" data-listen-marker="${i}">▶ ${esc(markerLine(marker))}</button>${marker.label ? `<span class="listen-label">${esc(marker.label)}</span>` : ''}</li>`).join('')}</ol>` : '<p class="empty">這個工作階段沒有標記。</p>'}</div>`;
  }
  function compareOptions() {
    const items = [];
    for (const [i, alt] of (state.session.alternatives ?? []).entries()) items.push([`alt:${i}`, `專案：${alt.label}`]);
    for (const item of state.sessions) if (item.id !== state.session.id) items.push([`session:${item.id}`, `工作階段：${item.title}`]);
    return items;
  }
  function changesCard() {
    const options = compareOptions();
    const picker = options.length ? `<form id="listen-compare-form" class="listen-inline"><label class="listen-grow">選擇要比較的前一版<select name="compare">${options.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('')}</select></label><button class="secondary">比較</button></form>` : '';
    if (!state.compare) {
      return `<div class="card" id="listen-changes"><h3>變更小節</h3><p class="meta">需要一份前一版 MML 才能比較：試聽連結可以附帶，或從專案送來的其他 MML／其他試聽工作階段中選一份。</p>${picker || '<p class="empty">目前沒有可比較的前一版。</p>'}</div>`;
    }
    const compareProblems = findings(state.compare.parsed, '比較版本');
    const changes = state.changes;
    const preRoll = state.session.preRollBars ?? 1;
    const ab = `<div class="listen-ab" role="group" aria-label="A/B 版本"><button type="button" data-listen-version="current" class="${state.version === 'current' ? 'secondary' : 'quiet'}" aria-pressed="${state.version === 'current'}">A 目前版本</button><button type="button" data-listen-version="compare" class="${state.version === 'compare' ? 'secondary' : 'quiet'}" aria-pressed="${state.version === 'compare'}" ${playable('compare') ? '' : 'disabled'}>B ${esc(state.compare.label)}</button></div>`;
    const rows = changes?.bars.map((bar, i) => {
      const counts = Object.entries(bar.counts).filter(([, n]) => n).map(([kind, n]) => `${{ added: '新增', removed: '移除', modified: '修改', tempo: 'Tempo' }[kind]} ${n}`).join('、');
      return `<li><button type="button" class="quiet" data-listen-change="${i}">▶ 第 ${bar.number} 小節</button><span class="listen-label">${esc(bar.roles.join('、') || 'Tempo')} · ${esc(counts)}</span></li>`;
    }).join('') ?? '';
    return `<div class="card" id="listen-changes"><h3>變更小節${changes ? `（${changes.bars.length}）` : ''}</h3>
      <p class="meta">比較：${esc(state.compare.label)} → 目前版本。逐角色比較每個音的音高、起點、時值與音量（精確拍數）${state.assumed ? '；小節以 4/4 假設計算' : ''}。</p>
      ${compareProblems}
      ${changes ? `${ab}<div class="actions"><button type="button" id="listen-play-changed" ${changes.regions.length ? '' : 'disabled'}>▶ 只播放變更小節（${changes.regions.length} 段，各含 ${preRoll} 小節前導）</button></div>
        ${changes.bars.length ? `<ol class="listen-list" id="listen-changed-bars">${rows}</ol>` : '<p class="empty">兩個版本的音符與 Tempo 完全相同。</p>'}` : '<p class="meta">其中一個版本無法解析，無法列出變更。</p>'}
      ${picker ? `<details><summary>改用其他前一版</summary>${picker}</details>` : ''}</div>`;
  }
  function rollCard() {
    return `<div class="card listen-roll" id="listen-roll-card"><div class="row"><h3>試聽捲軸</h3><span class="roll-zoom"><span class="meta">時間</span><button type="button" class="quiet" data-listen-zoom="w:-1" aria-label="時間縮小">−</button><button type="button" class="quiet" data-listen-zoom="w:1" aria-label="時間放大">＋</button></span></div>
      <p class="meta">${state.version === 'compare' ? '目前顯示 B：比較版本。' : '目前顯示 A：目前版本。'}標示的範圍是標記、備註或變更小節；直線是播放位置。點選音符可從該處播放或在該處加入備註。</p>
      <div id="listen-roll" class="roll-root"></div>
      <p id="listen-roll-info" class="meta roll-info" aria-live="polite">點選音符查看位置。</p></div>`;
  }
  function notesCard() {
    const s = state.session;
    const notes = sortNotes(s.notes ?? []);
    const editing = notes.find(note => note.id === state.editingNoteId) ?? null;
    const selected = state.selectedEvent;
    const here = positionAtNumber(state.bars, state.position.beat);
    const where = editing ? 'keep' : selected ? 'event' : 'current';
    const lines = notes.map(note => {
      const at = positionAt(state.bars, note.beat);
      return `<li><span class="listen-note-text"><strong>第 ${at.bar} 小節 · 第 ${esc(at.beat)} 拍 · ${formatClock(clock('current').secondsAt(note.beat))}</strong> · ${esc(note.role ?? '全部角色')} · ${esc(noteKindLabel(note.kind))}<br>${esc(note.text)}</span>
        <span class="listen-note-actions"><button type="button" class="quiet" data-listen-note-play="${esc(note.id)}" aria-label="從這則備註播放">▶</button><button type="button" class="quiet" data-listen-note-edit="${esc(note.id)}">編輯</button><button type="button" class="quiet" data-listen-note-delete="${esc(note.id)}">刪除</button></span></li>`;
    }).join('');
    return `<div class="card" id="listen-notes"><h3>試聽備註（${notes.length}）</h3>
      <form id="listen-note-form"><fieldset class="listen-where"><legend>位置</legend>
        ${editing ? `<label><input type="radio" name="where" value="keep" checked> 保持原位置（第 ${positionAt(state.bars, editing.beat).bar} 小節）</label>` : ''}
        <label><input type="radio" name="where" value="current" ${where === 'current' ? 'checked' : ''}> 目前播放位置（第 ${here.bar} 小節 · 第 ${here.beat} 拍）</label>
        <label class="listen-where-bar"><input type="radio" name="where" value="bar"> 指定小節 <input name="bar" type="number" min="1" max="${state.bars.length}" step="1" inputmode="numeric" aria-label="指定小節"></label>
        ${selected ? `<label><input type="radio" name="where" value="event" ${where === 'event' ? 'checked' : ''}> 捲軸選取的音符（${esc(selected.role)} · 第 ${positionAt(state.bars, selected.start).bar} 小節）</label>` : ''}
      </fieldset>
      <div class="field-grid"><label>角色<select name="role"><option value="">全部角色</option>${ROLES.map(role => `<option value="${role}" ${(editing?.role ?? selected?.role) === role ? 'selected' : ''}>${role}</option>`).join('')}</select></label>
        <label>種類<select name="kind">${NOTE_KINDS.map(kind => `<option value="${kind.id}" ${editing?.kind === kind.id ? 'selected' : ''}>${esc(kind.label)}</option>`).join('')}</select></label></div>
      <label>內容<input name="text" maxlength="500" required autocomplete="off" placeholder="例如：這裡太吵、主旋律不對" value="${esc(editing?.text ?? '')}"></label>
      <div class="actions"><button>${editing ? '更新備註' : '加入備註'}</button>${editing ? '<button type="button" class="quiet" id="listen-note-cancel">取消編輯</button>' : ''}</div></form>
      ${notes.length ? `<ol class="listen-list listen-notes-list" id="listen-note-list">${lines}</ol>` : '<p class="empty">還沒有備註。聽到問題時，在這裡記下位置與內容。</p>'}
      <div class="actions"><button type="button" id="listen-copy-ai" ${notes.length ? '' : 'disabled'}>複製給 AI</button><button type="button" class="secondary" id="listen-copy-link">複製試聽連結</button></div>
      <p class="meta">備註保存在這個試聽工作階段${s.origin?.kind === 'project' ? `，並同步到專案「${esc(s.origin.projectTitle || '未命名專案')}」` : ''}。它是給下一次修改的文字，不是審核或實機紀錄，不會改變任何 Gate。「複製給 AI」會複製標題、MML 的 sha256，以及每則備註的小節、拍、時間、角色、種類與內容。</p></div>`;
  }

  // ─── roll ─────────────────────────────────────────────────────────────
  // Song-wide ledger markers would shade the whole roll, so only positional
  // markers, notes and changed bars become regions.
  const barEnd = beat => state.bars[positionAt(state.bars, beat).bar - 1].end;
  function regions() {
    const out = state.markers.filter(marker => marker.scope !== 'song').map(marker => ({ start: marker.beat, end: marker.end_beat ?? barEnd(marker.beat), kind: marker.kind }));
    for (const bar of state.changes?.bars ?? []) out.push({ start: bar.start, end: bar.end, kind: 'changed' });
    return out;
  }
  function mountRoll(keepScroll) {
    roll?.destroy?.();
    roll = null;
    const host = root.querySelector('#listen-roll');
    const song = state.version === 'compare' && playable('compare') ? state.compare.parsed.song : state.parsed?.song;
    if (!host || !song) return;
    const info = root.querySelector('#listen-roll-info');
    roll = mountReviewRoll(host, rollProjection(song, state.meters), {
      regions: regions(),
      label: '試聽捲軸（唯讀）。Ctrl＋滾輪縮放時間，Alt＋滾輪縮放音高。',
      onSelect: event => {
        if (!event) { state.selectedEvent = null; info.textContent = '未選取音符。'; refreshNotes(); return; }
        const at = positionAt(state.bars, event.start);
        state.selectedEvent = { start: event.start, role: event.role };
        info.innerHTML = `<strong>${esc(event.role)}</strong> · ${esc(event.pitchName)} · 第 ${at.bar} 小節 · 第 ${esc(at.beat)} 拍 · 拍 <code>${esc(event.start)}</code><br><button type="button" class="quiet" id="listen-roll-play">▶ 從這裡播放（含前導）</button>`;
        info.querySelector('#listen-roll-play').onclick = () => { const plan = planFromBeat(event.start, { preRoll: state.session.preRollBars ?? 1 }); setCue(plan); focus({ start: event.start, end: event.end }); play(plan); };
        refreshNotes();
      },
    });
    if (keepScroll !== null) { const stage = host.querySelector('.roll-stage'); if (stage) stage.scrollLeft = keepScroll; }
    if (state.highlight) roll.focusRegion(state.highlight);
    roll.setPlayhead(state.position.beat);
  }
  // Redraw the notes card; text being typed survives unless it was just saved.
  function refreshNotes({ keepTyped = true } = {}) {
    const card = root.querySelector('#listen-notes');
    if (!card) return;
    const typed = keepTyped ? card.querySelector('[name="text"]')?.value : '';
    card.outerHTML = notesCard();
    if (typed && !state.editingNoteId) root.querySelector('#listen-note-form [name="text"]').value = typed;
    bindNotes();
  }
  function refreshMarkers() {
    const card = root.querySelector('#listen-markers');
    if (card) { card.outerHTML = markersCard(); bindMarkers(); }
    roll?.setRegions(regions());
  }

  // ─── bindings ─────────────────────────────────────────────────────────
  function bind() {
    root.querySelector('#listen-close').onclick = hide;
    const select = root.querySelector('#listen-session-select');
    root.querySelector('#listen-session-open').onclick = () => { if (select.value) open(select.value); };
    const del = root.querySelector('#listen-session-delete');
    del.onclick = async () => {
      if (!state.session) return;
      if (!state.confirmDelete) { state.confirmDelete = true; del.textContent = '再按一次確認刪除'; return; }
      const id = state.session.id;
      stop({ quiet: true });
      try { await deleteSession(id); } catch (error) { message(error.message, true); return; }
      state.session = null; state.confirmDelete = false; state.parsed = null; state.compare = null;
      await refreshSessions();
      render();
      message('已刪除試聽工作階段；專案不受影響。');
    };
    root.querySelector('#listen-link-form').onsubmit = event => {
      event.preventDefault();
      const raw = new FormData(event.target).get('link');
      let found = null;
      try { found = listenPayloadFromUrl(String(raw).trim()); } catch { /* not a URL: maybe a bare payload */ }
      const payload = found?.payload ?? String(raw).trim().replace(/^#?listen=/, '');
      importPayload(payload);
    };
    if (!state.session || state.loading) return;
    renderPosition(); renderTransport();
    const bankFile = root.querySelector('#listen-bank-file');
    if (bankFile) bankFile.onchange = () => { const file = bankFile.files?.[0]; bankFile.value = ''; if (file) Promise.resolve(audio.pickBank(file)).then(() => render(), error => message(error.message, true)); };
    const clearDefault = root.querySelector('#listen-default-bank-clear');
    if (clearDefault) clearDefault.onclick = () => { stop({ quiet: true }); Promise.resolve(audio.clearDefaultBank?.()).then(() => render(), error => message(error.message, true)); };
    root.querySelector('#listen-from-bar').onsubmit = event => {
      event.preventDefault();
      try {
        const bar = Number(new FormData(event.target).get('bar'));
        const plan = planFromBeat(barStart(state.bars, bar));
        setCue(plan); focus(null); play(plan);
        status(`從第 ${bar} 小節播放。`);
      } catch (error) { status(error.message); }
    };
    root.querySelector('#listen-from-time').onsubmit = event => {
      event.preventDefault();
      try {
        const seconds = parseClock(new FormData(event.target).get('time'));
        const c = clock();
        if (seconds > c.duration) throw Error(`時間超過曲長 ${formatClock(c.duration)}`);
        const plan = { fromBeat: null, fromSeconds: seconds, untilSeconds: null };
        setCue(plan); focus(null); play(plan);
        status(`從 ${formatClock(seconds)} 播放。`);
      } catch (error) { status(error.message); }
    };
    root.querySelector('#listen-preroll').onchange = event => {
      state.session.preRollBars = Number(event.target.value);
      persist().catch(error => message(error.message, true));
      const card = root.querySelector('#listen-changes');
      if (card) { card.outerHTML = changesCard(); bindChanges(); }
      refreshMarkers();
    };
    root.querySelectorAll('[data-listen-instrument]').forEach(select => select.onchange = () => audio.setInstrument?.(Number(select.dataset.listenInstrument), select.value));
    root.querySelectorAll('[data-listen-mute]').forEach(button => button.onclick = () => {
      const i = Number(button.dataset.listenMute);
      state.muted[i] = !state.muted[i];
      button.setAttribute('aria-pressed', String(state.muted[i]));
      applyMutes();
    });
    root.querySelectorAll('[data-listen-solo]').forEach(button => button.onclick = () => {
      const i = Number(button.dataset.listenSolo);
      state.solo[i] = !state.solo[i];
      button.setAttribute('aria-pressed', String(state.solo[i]));
      applyMutes();
    });
    root.querySelectorAll('[data-listen-zoom]').forEach(button => button.onclick = () => { const [axis, dir] = button.dataset.listenZoom.split(':'); roll?.zoom(axis, Number(dir)); });
    bindMarkers(); bindChanges(); bindNotes();
  }
  function bindMarkers() {
    root.querySelectorAll('[data-listen-marker]').forEach(button => button.onclick = () => {
      const marker = state.markers[Number(button.dataset.listenMarker)];
      if (!marker) return;
      const preRoll = marker.scope === 'song' ? 0 : state.session.preRollBars ?? 1;
      const plan = planFromBeat(marker.beat, { preRoll });
      setCue(plan);
      focus(marker.scope === 'song' ? null : { start: marker.beat, end: marker.end_beat ?? barEnd(marker.beat) });
      play(plan);
      status(`標記：${markerLine(marker)}${marker.label ? ` · ${marker.label}` : ''}`);
    });
  }
  function bindChanges() {
    const form = root.querySelector('#listen-compare-form');
    if (form) form.onsubmit = async event => {
      event.preventDefault();
      const value = String(new FormData(form).get('compare'));
      try {
        let mml, label;
        if (value.startsWith('alt:')) { const alt = state.session.alternatives[Number(value.slice(4))]; mml = alt.mml; label = `專案：${alt.label}`; }
        else { const other = await getSession(value.slice(8)); mml = other.mml; label = `工作階段：${other.title}`; }
        state.session.compareMml = mml; state.session.compareLabel = label.slice(0, 120);
        await persist();
        await open(state.session.id);
        message(state.changes ? `已比較：${state.changes.bars.length} 個小節有變更。` : '已載入比較版本。');
      } catch (error) { message(error.message, true); }
    };
    root.querySelectorAll('[data-listen-version]').forEach(button => button.onclick = () => {
      const version = button.dataset.listenVersion;
      if (version === state.version || !playable(version)) return;
      const replay = state.playing && state.lastPlan;
      const plan = replay ? state.lastPlan : null;
      state.version = version;
      const card = root.querySelector('#listen-changes');
      if (card) { card.outerHTML = changesCard(); bindChanges(); }
      const rollCardEl = root.querySelector('#listen-roll-card');
      if (rollCardEl) { const keep = rollCardEl.querySelector('.roll-stage')?.scrollLeft ?? null; rollCardEl.outerHTML = rollCard(); root.querySelectorAll('[data-listen-zoom]').forEach(b => b.onclick = () => { const [axis, dir] = b.dataset.listenZoom.split(':'); roll?.zoom(axis, Number(dir)); }); mountRoll(keep); }
      // The same bars in the other version: re-derive seconds from its own tempo map.
      if (plan) {
        const again = plan.fromBeat !== null && plan.fromBeat !== undefined
          ? seekPlan({ bars: state.bars, clock: clock(version), beat: plan.fromBeat, untilBeat: plan.untilBeat ?? null })
          : { fromBeat: null, fromSeconds: plan.fromSeconds, untilSeconds: plan.untilSeconds ?? null };
        const queue = state.queue;
        if (queue) queue.plans = changedPlaybackPlan({ regions: state.changes.regions, bars: state.bars, clock: clock(version), preRollBars: state.session.preRollBars ?? 1 });
        play(queue ? queue.plans[queue.index] : again, { queue, version });
      } else { renderPosition(); renderTransport(); }
      status(version === 'compare' ? `B：${state.compare.label}` : 'A：目前版本');
    });
    const all = root.querySelector('#listen-play-changed');
    if (all) all.onclick = () => {
      const plans = changedPlaybackPlan({ regions: state.changes.regions, bars: state.bars, clock: clock(), preRollBars: state.session.preRollBars ?? 1 });
      if (!plans.length) return;
      focus({ start: plans[0].region.start, end: plans[0].region.end });
      status(`變更小節 1／${plans.length}：第 ${plans[0].region.fromBar}${plans[0].region.toBar !== plans[0].region.fromBar ? `–${plans[0].region.toBar}` : ''} 小節`);
      play(plans[0], { queue: { plans, index: 0 } });
    };
    root.querySelectorAll('[data-listen-change]').forEach(button => button.onclick = () => {
      const bar = state.changes.bars[Number(button.dataset.listenChange)];
      const plan = planFromBeat(bar.start, { preRoll: state.session.preRollBars ?? 1, until: bar.end });
      setCue(plan);
      focus({ start: bar.start, end: bar.end });
      play(plan);
      status(`第 ${bar.number} 小節（${state.version === 'compare' ? 'B' : 'A'}）`);
    });
  }
  function bindNotes() {
    const form = root.querySelector('#listen-note-form');
    if (!form) return;
    form.onsubmit = async event => {
      event.preventDefault();
      const data = new FormData(form);
      const editing = (state.session.notes ?? []).find(note => note.id === state.editingNoteId) ?? null;
      try {
        const where = data.get('where');
        let beat;
        if (where === 'keep' && editing) beat = editing.beat;
        else if (where === 'bar') beat = barStart(state.bars, Number(data.get('bar')));
        else if (where === 'event' && state.selectedEvent) beat = state.selectedEvent.start;
        else beat = snapToMeterBeat(state.bars, state.position.beat);
        const note = normalizeNote({ ...(editing ?? {}), beat, role: data.get('role') || null, kind: data.get('kind'), text: data.get('text'), mmlSha256: state.session.mmlSha256 });
        state.session.notes = [...(state.session.notes ?? []).filter(item => item.id !== note.id), note];
        state.editingNoteId = null;
        await persist();
        if (state.session.origin?.kind === 'project') await saveProjectNote(state.session.origin.projectId, { type: 'upsert', note }).catch(error => message(`備註已存入試聽工作階段，但同步到專案失敗：${error.message}`, true));
        layout();
        refreshNotes({ keepTyped: false }); refreshMarkers();
        const at = positionAt(state.bars, note.beat);
        status(`已${editing ? '更新' : '加入'}備註：第 ${at.bar} 小節 · 第 ${at.beat} 拍。`);
      } catch (error) { status(error.message); message(error.message, true); }
    };
    const cancel = root.querySelector('#listen-note-cancel');
    if (cancel) cancel.onclick = () => { state.editingNoteId = null; refreshNotes(); };
    root.querySelectorAll('[data-listen-note-edit]').forEach(button => button.onclick = () => {
      state.editingNoteId = button.dataset.listenNoteEdit; refreshNotes();
      root.querySelector('#listen-note-form [name="text"]')?.focus();
    });
    root.querySelectorAll('[data-listen-note-delete]').forEach(button => button.onclick = async () => {
      const id = button.dataset.listenNoteDelete;
      state.session.notes = (state.session.notes ?? []).filter(note => note.id !== id);
      if (state.editingNoteId === id) state.editingNoteId = null;
      try {
        await persist();
        if (state.session.origin?.kind === 'project') await saveProjectNote(state.session.origin.projectId, { type: 'delete', id }).catch(error => message(`同步到專案失敗：${error.message}`, true));
      } catch (error) { message(error.message, true); }
      layout(); refreshNotes(); refreshMarkers();
      status('已刪除備註。');
    });
    root.querySelectorAll('[data-listen-note-play]').forEach(button => button.onclick = () => {
      const note = (state.session.notes ?? []).find(item => item.id === button.dataset.listenNotePlay);
      if (!note) return;
      const plan = planFromBeat(note.beat, { preRoll: state.session.preRollBars ?? 1 });
      setCue(plan);
      focus({ start: note.beat, end: barEnd(note.beat) });
      play(plan);
    });
    const copyAi = root.querySelector('#listen-copy-ai');
    if (copyAi) copyAi.onclick = () => copyText(exportText());
    root.querySelector('#listen-copy-link').onclick = async () => {
      try { copyText(await shareUrl()); }
      catch (error) { message(`無法建立試聽連結：${error.message}`, true); }
    };
  }

  function exportText() {
    return notesExportText({ title: state.session.title, mmlSha256: state.session.mmlSha256, meterText: state.session.meterText, meterAssumed: state.assumed, notes: state.session.notes ?? [], bars: state.bars, clock: clock('current') });
  }
  // A listen link for this session: the MML, its meter, the cue, markers
  // (notes included) and the compared version. Same contract as the MCP side.
  async function shareUrl() {
    const s = state.session;
    const markers = [...(s.markers ?? []).map(({ beat, end_beat, role, kind, label }) => ({ beat, ...(end_beat ? { end_beat } : {}), ...(role ? { role } : {}), kind, ...(label ? { label } : {}) })),
      ...notesAsMarkers(s.notes ?? []).map(({ noteId, ...marker }) => marker)].slice(0, LISTEN_LIMITS.markers);
    const link = { schema: LISTEN_LINK_SCHEMA, mml: s.mml, title: s.title.slice(0, LISTEN_LIMITS.titleChars) };
    if (!state.assumed && s.meterText) link.meter_text = s.meterText;
    if (state.cue.beat !== undefined && state.cue.beat !== '0') link.start = { beat: state.cue.beat };
    if (markers.length) link.markers = markers;
    if (s.compareMml) link.compare_mml = s.compareMml;
    if (s.origin?.source) link.source = s.origin.source;
    return listenUrl(globalThis.location.href, await encodeListenLink(link));
  }

  return Object.freeze({
    importFromLocation,
    importPayload,
    openFromProject,
    async showSessions() { show(); await refreshSessions(); if (!state.session && state.sessions.length) await open(state.sessions[0].id); else render(); root.scrollIntoView?.({ block: 'start' }); },
    hide,
    // The engine or bank changed under the page (Final preview card).
    // Only a change in whether anything can play redraws the player card, so
    // typed inputs and the status line survive a playback starting.
    refreshAudio() {
      if (root.hidden || !state.session || state.loading) return;
      const info = audio.status();
      const ready = Boolean(info.bank || info.fallback);
      const card = root.querySelector('#listen-player');
      const inst = instruments();
      if (card && (card.dataset.ready !== String(ready) || card.dataset.defaultCached !== String(Boolean(info.defaultCached)) || card.dataset.instruments !== inst.options.map(o => o.value).join(','))) { card.outerHTML = playerCard(); bind(); }
      else {
        const line = root.querySelector('#listen-bank'); if (line) line.innerHTML = bankLine();
        root.querySelectorAll('[data-listen-instrument]').forEach(select => { const value = inst.choices[Number(select.dataset.listenInstrument)]; if (value !== undefined && select.value !== value) select.value = value; });
        renderTransport();
      }
    },
    get state() { return state; },
    exportText,
  });
}
