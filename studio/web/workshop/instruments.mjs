// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Instrument tables: Mabinogi Mobile instruments over GM, bank preset lists, .def parsing.
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import * as i18n from "./i18n.mjs";

// The eleven Mabinogi Mobile instruments, previewed on whatever General MIDI
// bank is active. Programs are 0-based GM numbers. BassDrum and Cymbals have
// no GM program: they play the bank's percussion kit, and every written note
// becomes one of two kit keys (below o4c the first, from o4c up the second).
// A listening approximation only — never the game's timbre.
export const MOBILE_INSTRUMENTS = Object.freeze([
  { id: "lute", name: "Lute", program: 24 },
  { id: "mandolin", name: "Mandolin", program: 25 },
  { id: "chalumeau", name: "Chalumeau", program: 71 },
  { id: "xylophone", name: "Xylophone", program: 13 },
  { id: "flute", name: "Flute", program: 73 },
  { id: "violin", name: "Violin", program: 40 },
  { id: "piano", name: "Piano", program: 0 },
  { id: "harp", name: "Harp", program: 46 },
  { id: "musicbox", name: "Music Box", program: 10 },
  { id: "bassdrum", name: "BassDrum", program: 0, kit: Object.freeze([35, 36]) },
  { id: "cymbals", name: "Cymbals", program: 0, kit: Object.freeze([49, 57]) },
].map(Object.freeze));

export const DRUM_SPLIT = 60;
const MOBILE_BY_ID = new Map(MOBILE_INSTRUMENTS.map(m => [m.id, m]));

export const mobileInstrument = id => MOBILE_BY_ID.get(id) ?? null;

// A track's instrument is stored as JSON "[msb, lsb, program]" for a bank
// preset, or "[msb, lsb, program, id]" for a Mobile instrument.
export const mobilePresetValue = m => JSON.stringify([0, 0, m.program, m.id]);
export const DEFAULT_PRESET_VALUE = mobilePresetValue(MOBILE_INSTRUMENTS[0]);

export const kitOf = preset => mobileInstrument(preset?.[3])?.kit ?? null;
export const isKit = preset => kitOf(preset) !== null;

// The kit key a written pitch sounds on a percussion instrument, or the
// pitch itself for a melodic one.
export function soundingKey(preset, midi) {
  const kit = kitOf(preset);
  return kit ? (midi < DRUM_SPLIT ? kit[0] : kit[1]) : midi;
}

// Shown by their game names in every language.
export const mobileName = m => m.name;

// The Mobile instrument an imported program number (`@n`, MIDI program change,
// 3MLE/MMI program field) stands for, if any.
export const mobileForProgram = program =>
  MOBILE_INSTRUMENTS.find(m => !m.kit && m.program === program) ?? null;

export function parseDef(buf) {
  const bytes = new Uint8Array(buf);
  let text;
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    text = new TextDecoder("utf-8").decode(buf);
  } else {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch { text = new TextDecoder("shift_jis", { fatal: false }).decode(buf); }
  }
  text = text.replace(/^\uFEFF/, "");

  const lines = text.split(/\r?\n/);
  const map = new Map();
  const locales = new Map();
  let section = "";

  for (const raw of lines) {
    const l = raw.trim();
    if (!l || l.startsWith(";") || l.startsWith("#")) continue;

    const sec = l.match(/^\[(.+)\]$/);
    if (sec) { section = sec[1].trim().toLowerCase(); continue; }

    if (section === "instrument presets") {
      const m = l.match(/^(.+?)\s*=\s*(\d{1,3})\s*(?:,\s*(\d{1,3})\s*)?(?:,\s*(\d{1,3})\s*)?/);
      if (!m) continue;
      const name = m[1].trim(), defNo = +m[2], prog = defNo - 1;
      if (!name || prog < 0 || prog > 127 || map.has(prog)) continue;
      map.set(prog, { name, defNo, msb: +(m[3] ?? 0), lsb: +(m[4] ?? 0) });
      continue;
    }

    const lcid = /^\d+$/.test(section) ? +section : null;
    if (lcid === null) continue;
    const m = l.match(/^(.+?)\s*=\s*(.+)$/);
    if (!m) continue;
    if (!locales.has(lcid)) locales.set(lcid, new Map());
    locales.get(lcid).set(m[1].trim().toLowerCase(), m[2].trim());
  }
  return { map, locales, lines: lines.length };
}

const LOCALE_ORDER = {
  "zh-Hant": [1028, 3076, 1043],
  "ja": [1041],
  "ko": [1042],
  "en": [],
};

export function pickLocale(locales, lang = i18n.getLocale()) {
  for (const id of LOCALE_ORDER[lang] ?? LOCALE_ORDER["zh-Hant"]) {
    if (locales.has(id)) return locales.get(id);
  }
  return new Map();
}

const UNUSED = /^[([{\s]*(not\s*used|unused|empty|reserved|n\/a|none|-+)[)\]}\s]*\d*[)\]}\s]*$/i;

export const isUsable = p => { const n = (p?.name ?? "").trim(); return n !== "" && !UNUSED.test(n); };

export function selectPresets(all, defMap) {
  if (defMap.size) {
    const byDef = [];
    for (const [prog, d] of defMap) {
      const hit = all.find(p => p.program === prog && p.bankMSB === d.msb && p.bankLSB === d.lsb)
               ?? all.find(p => p.program === prog);
      if (hit) byDef.push(hit);
    }
    if (byDef.length) return { kept: byDef, note: i18n.t("instruments.filteredByDef", { n: byDef.length }) };
  }

  const named = all.filter(isUsable);
  const kept = named.length ? named : all;
  const dropped = all.length - kept.length;
  return { kept, note: dropped ? i18n.t("instruments.droppedUnused", { n: dropped }) : "" };
}

export function presetName(p, defMap, defNames) {
  const def = defMap.get(p.program);
  if (!def) return p.name;
  return defNames.get(def.name.toLowerCase()) ?? def.name;
}

export function presetLabel(p, defMap, defNames) {
  const no = defMap.get(p.program)?.defNo ?? p.program;
  return `${String(no).padStart(3, "0")}  ${presetName(p, defMap, defNames)}`;
}

export function presetsForPrograms(programs, all, defMap) {
  const { kept } = selectPresets(all, defMap);
  return programs.map(prog => {
    if (prog === null || prog === undefined) return null;
    const hit = kept.find(p => p.program === prog);
    return hit ? [hit.bankMSB, hit.bankLSB, hit.program] : null;
  });
}
