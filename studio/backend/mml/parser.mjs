import {
  F,
  f,
  ROLES,
  parseMeter,
  buildBars,
  normalizeProfile,
  reviewSong,
} from '../../../dist/core.js';
import { EFFECTIVE_RULESET } from '../rules/index.mjs';

export const STUDIO_MML_PROFILE = EFFECTIVE_RULESET.id;
const syntax = EFFECTIVE_RULESET.mobileSyntax;
const allowedLengths = new Set(syntax.allowedLengthDenominators);
const dottedTripletShorthand = new Set(syntax.rejectDottedTripletShorthand);
const noteBase = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

const eq = (a, b) => f(a).cmp(b) === 0;

function controlsPush(list, event) {
  const last = list.at(-1);
  if (last && eq(last.beat, event.beat)) list[list.length - 1] = event;
  else if (!last || last.value !== event.value) list.push(event);
}

export function splitMML(raw) {
  if (typeof raw !== 'string' || raw.length > 40000) throw Error('請提供40,000字以內的MML');
  const text = raw.trim();
  if (!/^MML@/i.test(text) || !text.endsWith(';')) throw Error('請貼上從 MML@ 到 ; 的完整六軌字串');
  const tracks = text.slice(4, -1).split(',');
  if (tracks.length !== 6) throw Error(`需要六個固定軌位，目前為${tracks.length}軌`);
  return tracks;
}

export function parseTrack(raw, role) {
  const errors = [];
  const events = [];
  const tempo = [];
  const controls = [{ beat: '0', controller: 7, value: 8 }];
  const fail = (message, pos) => errors.push({ role, position: pos + 1, message });

  if (raw.length > syntax.perTrackCharacterLimit) fail(`字數${raw.length}，超過${syntax.perTrackCharacterLimit}上限`, 0);
  if (/\s/.test(raw)) fail('軌內含空白或換行，請保留純MML字串', raw.search(/\s/));

  let i = 0;
  let time = f(0);
  let octave = 4;
  let explicitOctave = false;
  let length = 4;
  let volume = 8;
  let pending = false;
  let lastWasNote = false;
  const text = raw.toLowerCase();

  while (i < text.length) {
    const start = i;
    const ch = text[i++];
    if (/\s/.test(ch)) continue;

    if ('tolv'.includes(ch)) {
      const match = /^\d+/.exec(text.slice(i));
      if (!match) {
        fail(`${ch.toUpperCase()}缺少數值`, start);
        continue;
      }
      i += match[0].length;
      const value = Number(match[0]);

      if (ch === 't') {
        if (value < syntax.tempoMin || value > syntax.tempoMax) fail(`T${value}超出${syntax.tempoMin}–${syntax.tempoMax}`, start);
        if (tempo.length && f(tempo.at(-1).beat).cmp(time) >= 0) fail('同一拍重複或倒序Tempo', start);
        tempo.push({ beat: String(time), bpm: value });
      }
      if (ch === 'o') {
        octave = value;
        explicitOctave = true;
        if (value < syntax.octaveMin || value > syntax.octaveMax) fail(`O${value}超出${syntax.octaveMin}–${syntax.octaveMax}`, start);
      }
      if (ch === 'l') {
        length = value;
        if (!allowedLengths.has(value)) fail(`Strict Mobile不接受L${value}；最短安全邊界為1/${syntax.shortestSafeDenominator}`, start);
      }
      if (ch === 'v') {
        if (value < syntax.volumeMin || value > syntax.volumeMax) fail(`V${value}超出${syntax.volumeMin}–${syntax.volumeMax}`, start);
        else {
          volume = value;
          controlsPush(controls, { beat: String(time), controller: 7, value });
        }
      }
      continue;
    }

    if (ch === '<' || ch === '>') {
      octave += ch === '>' ? 1 : -1;
      if (octave < syntax.octaveMin || octave > syntax.octaveMax) fail(`八度超出O${syntax.octaveMin}–O${syntax.octaveMax}`, start);
      continue;
    }

    if (ch === '&') {
      if (pending || !lastWasNote || !events.length || !eq(events.at(-1).end, time)) fail('延音必須接續同音音符，不能接休止或重複 &', start);
      pending = true;
      continue;
    }

    if (ch === 'n') {
      const match = /^\d+/.exec(text.slice(i));
      if (match) i += match[0].length;
      fail('Final Canonical 不使用Nxx；請改用音名與明確八度', start);
      pending = false;
      continue;
    }

    if (ch in noteBase || ch === 'r') {
      let accidental = 0;
      if (ch !== 'r' && ['+', '#', '-'].includes(text[i])) {
        accidental = text[i] === '-' ? -1 : 1;
        i++;
      }

      const match = /^\d+/.exec(text.slice(i));
      let denominator = match ? Number(match[0]) : length;
      if (match) i += match[0].length;

      let dots = 0;
      while (text[i] === '.') {
        dots++;
        i++;
      }

      if (!Number.isSafeInteger(denominator) || denominator <= 0) {
        fail('時值分母必須為正整數', start);
        denominator = 4;
      } else if (!allowedLengths.has(denominator)) {
        fail(`Strict Mobile不接受${ch}${denominator}；允許分母為${[...allowedLengths].join('/')}，最短安全邊界為1/${syntax.shortestSafeDenominator}`, start);
      }

      if (syntax.rejectMultipleDots && dots > 1) fail('不接受雙附點／多附點', start);
      if (dots && dottedTripletShorthand.has(denominator)) fail(`不接受附點三連音式時值${denominator}.，需等值正規化`, start);

      const dotFactor = dots
        ? new F(2n ** BigInt(Math.min(dots, 8) + 1) - 1n, 2n ** BigInt(Math.min(dots, 8)))
        : new F(1);
      const duration = new F(4, denominator).mul(dotFactor);
      const end = time.add(duration);

      if (ch === 'r') {
        if (pending) fail('延音不能接到休止', start);
        pending = false;
        lastWasNote = false;
      } else {
        if (!explicitOctave) fail('首音前必須明確設定O八度', start);
        const pitch = 12 * (octave + 1) + noteBase[ch] + accidental;
        if (pitch < 0 || pitch > 127) fail('音高超出MIDI 0–127', start);

        if (pending && events.length && events.at(-1).pitch === pitch && eq(events.at(-1).end, time)) {
          events.at(-1).end = String(end);
        } else {
          if (pending) fail('延音音高不同或跨越空隙', start);
          events.push({ pitch, start: String(time), end: String(end), volume });
        }
        pending = false;
        lastWasNote = true;
      }

      time = end;
      continue;
    }

    fail(`無法辨識字元「${ch}」`, start);
    pending = false;
  }

  if (pending) fail('軌尾有未完成延音', Math.max(0, text.length - 1));
  if (raw && (!tempo.length || !eq(tempo[0].beat, 0))) fail('非空軌必須在第0拍設定Tempo', 0);

  return {
    role,
    raw,
    characters: raw.length,
    total: String(time),
    events,
    controls,
    tempo,
    errors,
    empty: raw.length === 0,
  };
}

export function validateMML(raw, settings = {}) {
  const errors = [];
  const warnings = [];
  let strings;

  try {
    strings = splitMML(raw);
  } catch (error) {
    return { ok: false, errors: [{ message: error.message }], warnings };
  }

  const tracks = strings.map((track, index) => parseTrack(track, ROLES[index]));
  errors.push(...tracks.flatMap(track => track.errors));
  const active = tracks.filter(track => !track.empty);
  let tempo = [];
  let total = '0';
  let meter = [];
  let bars = [];
  let drums = null;

  if (!active.length) errors.push({ message: '六軌皆空，無法建立預覽' });
  if (active.length) {
    tempo = active[0].tempo;
    total = active[0].total;
    for (const track of active) {
      if (!eq(track.total, total)) errors.push({ role: track.role, message: `總拍長${track.total}不等於${total}` });
      if (JSON.stringify(track.tempo) !== JSON.stringify(tempo)) errors.push({ role: track.role, message: 'Tempo Map與其他非空軌不同' });
    }
  }

  if (!settings.meterText?.trim()) {
    errors.push({ message: 'Studio Final 驗證需要來源確認的拍號圖，不可自動假設4/4' });
  } else {
    try {
      meter = parseMeter(settings.meterText);
      bars = buildBars(total, meter, settings.pickup, settings.finalPartial);
    } catch (error) {
      errors.push({ message: error.message });
    }
  }

  try {
    drums = normalizeProfile(settings.drumText);
    if (drums) {
      const track = tracks[ROLES.indexOf(drums.role)];
      for (const event of track.events) {
        if (!(String(event.pitch) in drums.mapping)) throw Error(`${drums.role}缺少Mobile音位${event.pitch}的鼓面對應`);
      }
    }
  } catch (error) {
    errors.push({ message: error.message });
  }

  const programs = ROLES.map((role, index) => Number(settings.programs?.[index] ?? 0));
  if (programs.some(program => !Number.isInteger(program) || program < 0 || program > 127)) errors.push({ message: 'MIDI Program需為0–127整數' });

  const song = {
    version: 'studio-v1',
    profile: STUDIO_MML_PROFILE,
    title: settings.title || '未命名樂譜',
    tracks,
    tempo,
    total,
    meter,
    bars,
    drums,
    programs,
  };

  if (!errors.length) {
    const review = reviewSong(song);
    warnings.push(...review.summary);
    song.review = review;
    return { ok: true, errors, warnings, song };
  }

  return { ok: false, errors, warnings, song };
}
