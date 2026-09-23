// Preview instruments. Pure: no DOM, no audio.
//
// With the free default bank (default-bank.mjs: a MIT-licensed General MIDI
// subset each browser derives from the upstream file it downloads) each
// Mabinogi Mobile instrument name maps to the GM program, or GM drum-kit note,
// that stands in for it. The mapping is an approximation for listening only:
// a generic GM sound is not the game's timbre and says nothing about how the
// game sounds. With a bank the user picked, the picker lists that bank's own
// presets instead.
export const DEFAULT_BANK_NAME = 'FluidR3Mono GM（Studio 子集）';
export const DEFAULT_BANK_LABEL = '免費通用音色（近似），不是遊戲音色';

// 0-based GM programs. A drum instrument plays its first note on the Standard
// kit (GM percussion, program 0); the other listed note is kept in the bank.
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
export const DEFAULT_INSTRUMENT = 'lute';
export const DEFAULT_BANK_PROGRAMS = Object.freeze([...new Set(GAME_INSTRUMENTS.filter(item => !item.drumNotes).map(item => item.program))].sort((a, b) => a - b));
export const DEFAULT_BANK_DRUM_NOTES = Object.freeze([...new Set(GAME_INSTRUMENTS.flatMap(item => item.drumNotes ?? []))].sort((a, b) => a - b));

const byId = new Map(GAME_INSTRUMENTS.map(item => [item.id, item]));

/**
 * The voice one role plays: a GM program, and a drum-kit note when the role
 * is a drum instrument (every note of the role then sounds as that note).
 * A choice is a game instrument id (default bank) or `p:<program>` (a preset
 * of the user's own bank). Anything else falls back to the default.
 */
export function voiceFor(choice) {
  const text = String(choice ?? '');
  const preset = /^p:(\d{1,3})$/.exec(text);
  if (preset && Number(preset[1]) <= 127) return { program: Number(preset[1]), drumNote: null, label: `${String(Number(preset[1]) + 1).padStart(3, '0')}` };
  const instrument = byId.get(text) ?? byId.get(DEFAULT_INSTRUMENT);
  return { program: instrument.program, drumNote: instrument.drumNotes?.[0] ?? null, label: instrument.label, id: instrument.id };
}
export const resolveRoleVoices = choices => Array.from({ length: 6 }, (_, role) => voiceFor(choices?.[role]));

// Picker options: the 11 named instruments for the default bank, the bank's
// own presets for a user bank (`presets` from the engine, once loaded).
export function instrumentOptions({ defaultBank, presets = [] }) {
  if (defaultBank) return GAME_INSTRUMENTS.map(item => ({ value: item.id, label: `${item.label}（${item.name}）` }));
  return presets.map(preset => ({ value: `p:${preset.program}`, label: `${String(preset.program + 1).padStart(3, '0')} ${preset.name}` }));
}
// A whole set of voices is uniform when every role plays the same melodic
// program; only then can a playback be a Gate 6 readback of one program.
export const uniformProgram = voices => (voices.every(voice => voice.drumNote === null && voice.program === voices[0].program) ? voices[0].program : null);
