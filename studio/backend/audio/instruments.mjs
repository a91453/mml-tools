// Mabinogi Mobile instrument names → General MIDI stand-ins. Pure: no I/O.
//
// Status: IMPLEMENTATION NOTES. The backend's copy of the table the Studio Web
// preview picker uses (studio/web/preview/instruments.mjs), for the server-side
// audio prescreen and any other backend renderer. It is defined here rather
// than imported because backend modules do not depend on the web plane; a
// regression pins that both tables carry the same ids, names, labels,
// programs and drum notes.
//
// A GM program is an approximation for listening only. A generic bank is not
// the game's timbre and says nothing about how the game sounds, and no result
// computed with it is Gate 6 player readback, Gate 7 original-audio evidence
// or in-game acceptance.

// 0-based GM programs. A drum instrument plays its first listed note on the
// GM Standard kit (percussion, program 0); every note of that role sounds as
// that note. The other listed note is kept for banks trimmed to this table.
export const GAME_INSTRUMENTS = Object.freeze([
  Object.freeze({ id: 'lute', name: 'Lute', label: '魯特琴', program: 24 }),
  Object.freeze({ id: 'mandolin', name: 'Mandolin', label: '曼陀林', program: 25 }),
  Object.freeze({ id: 'chalumeau', name: 'Chalumeau', label: '夏盧莫管', program: 71 }),
  Object.freeze({ id: 'xylophone', name: 'Xylophone', label: '木琴', program: 13 }),
  Object.freeze({ id: 'flute', name: 'Flute', label: '長笛', program: 73 }),
  Object.freeze({ id: 'violin', name: 'Violin', label: '小提琴', program: 40 }),
  Object.freeze({ id: 'piano', name: 'Piano', label: '鋼琴', program: 0 }),
  Object.freeze({ id: 'harp', name: 'Harp', label: '豎琴', program: 46 }),
  Object.freeze({ id: 'music-box', name: 'Music Box', label: '音樂盒', program: 10 }),
  Object.freeze({ id: 'bass-drum', name: 'BassDrum', label: '大鼓', program: 0, drumNotes: Object.freeze([35, 36]) }),
  Object.freeze({ id: 'cymbals', name: 'Cymbals', label: '鈸', program: 0, drumNotes: Object.freeze([49, 57]) }),
]);

export const GAME_INSTRUMENT_IDS = Object.freeze(GAME_INSTRUMENTS.map(item => item.id));
export const DEFAULT_INSTRUMENT = 'lute';
export const GM_PROGRAMS = Object.freeze([...new Set(GAME_INSTRUMENTS.filter(item => !item.drumNotes).map(item => item.program))].sort((a, b) => a - b));
export const GM_DRUM_NOTES = Object.freeze([...new Set(GAME_INSTRUMENTS.flatMap(item => item.drumNotes ?? []))].sort((a, b) => a - b));

const byId = new Map(GAME_INSTRUMENTS.map(item => [item.id, item]));

export const isGameInstrument = id => typeof id === 'string' && byId.has(id);

/**
 * The voice one role plays with a GM bank: a program, and a drum-kit note
 * when the instrument is a drum. Unknown ids are refused rather than mapped to
 * a default, because a silently substituted instrument would make two
 * alternatives differ in something nobody chose.
 */
export function gmVoiceFor(id) {
  const instrument = byId.get(id);
  if (!instrument) throw Error(`unknown game instrument: ${String(id).slice(0, 40)}`);
  return Object.freeze({
    instrument: instrument.id,
    program: instrument.program,
    drumNote: instrument.drumNotes?.[0] ?? null,
    label: instrument.label,
  });
}

// v0–v15 → MIDI velocity 1–127, the curve of the Studio Web preview
// (studio/web/preview/schedule.mjs `velocityFor`): v0 is still a struck note.
// It describes this rendering, not the game engine. The preview's Gate 6
// readback (studio/web/preview/readback.mjs) uses this definition, not the
// scheduler's copy, as the velocity it expects.
export const velocityForVolume = volume => Math.max(1, Math.round((Number(volume) * 127) / 15));
