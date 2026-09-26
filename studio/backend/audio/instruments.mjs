// Mabinogi Mobile instrument names → General MIDI stand-ins. Pure: no I/O.
//
// Status: IMPLEMENTATION NOTES. The one table of the eleven instruments, for
// every renderer: the server-side audio prescreen here, and in Studio Web the
// preview and listening players (studio/web/preview/instruments.mjs) and the
// Workshop (studio/web/workshop/instruments.mjs), which import it. It lives in
// the backend because backend modules do not depend on the web plane, while
// the web plane already imports backend modules.
//
// A GM program is an approximation for listening only. A generic bank is not
// the game's timbre and says nothing about how the game sounds, and no result
// computed with it is Gate 6 player readback, Gate 7 original-audio evidence
// or in-game acceptance.

// 0-based GM programs. A drum instrument plays the GM Standard kit
// (percussion, program 0) with two kit notes: a written pitch below o4c
// (DRUM_SPLIT) sounds the first, o4c and above the second (soundingPitch).
// The split is the owner's earlier frontend's; like the GM programs it is a
// listening approximation, not a Mobile drum-face mapping (MASTER_RULES §8).
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
// Written pitches from here up sound a drum instrument's second kit note.
export const DRUM_SPLIT = 60;
// A voice's two kit notes, or null for a melodic voice. A voice that names
// only `drumNote` sounds that one note for every pitch.
export const drumNotesOf = voice => (Array.isArray(voice?.drumNotes) ? voice.drumNotes
  : Number.isInteger(voice?.drumNote) ? [voice.drumNote, voice.drumNote] : null);
// The kit note a written pitch sounds on a drum voice, or the pitch itself.
export const soundingPitch = (voice, pitch) => { const notes = drumNotesOf(voice); return notes ? notes[pitch < DRUM_SPLIT ? 0 : 1] : pitch; };
export const GM_PROGRAMS = Object.freeze([...new Set(GAME_INSTRUMENTS.filter(item => !item.drumNotes).map(item => item.program))].sort((a, b) => a - b));
export const GM_DRUM_NOTES = Object.freeze([...new Set(GAME_INSTRUMENTS.flatMap(item => item.drumNotes ?? []))].sort((a, b) => a - b));

const byId = new Map(GAME_INSTRUMENTS.map(item => [item.id, item]));

export const isGameInstrument = id => typeof id === 'string' && byId.has(id);
// Ids the Workshop stored before it shared this table.
export const INSTRUMENT_ALIASES = Object.freeze({ musicbox: 'music-box', bassdrum: 'bass-drum' });
// One of the eleven by its id or a Workshop alias, else null.
export const gameInstrument = id => byId.get(INSTRUMENT_ALIASES[id] ?? id) ?? null;
// The melodic instrument an imported GM program stands for, if any.
export const gameInstrumentForProgram = program => GAME_INSTRUMENTS.find(item => !item.drumNotes && item.program === program) ?? null;

/**
 * The voice one role plays with a GM bank: a program, and for a drum its two
 * kit notes (`drumNotes`; `drumNote`, the first, marks a drum). Unknown ids are refused rather than mapped to
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
    drumNotes: instrument.drumNotes ? Object.freeze([...instrument.drumNotes]) : null,
    label: instrument.label,
  });
}

// v0–v15 → MIDI velocity 1–127, the curve of the Studio Web preview
// (studio/web/preview/schedule.mjs `velocityFor`): v0 is still a struck note.
// It describes this rendering, not the game engine. The preview's Gate 6
// readback (studio/web/preview/readback.mjs) uses this definition, not the
// scheduler's copy, as the velocity it expects.
export const velocityForVolume = volume => Math.max(1, Math.round((Number(volume) * 127) / 15));
