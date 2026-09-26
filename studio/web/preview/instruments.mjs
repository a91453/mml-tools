// Preview instruments: the one table of the eleven Mabinogi Mobile instruments
// for every player in Studio Web -- the Studio preview and listening players
// and the Workshop (workshop/instruments.mjs builds on it). Pure: no DOM, no
// audio.
//
// With the free default bank (default-bank.mjs: a MIT-licensed General MIDI
// subset each browser derives from the upstream file it downloads) each
// Mabinogi Mobile instrument name maps to the GM program, or GM drum-kit note,
// that stands in for it. The mapping is an approximation for listening only:
// a generic GM sound is not the game's timbre and says nothing about how the
// game sounds. With a bank the user picked, the picker lists that bank's own
// presets instead.
//
// The table itself, the drum split and the Workshop's old ids are the
// backend's (studio/backend/audio/instruments.mjs), shared with the audio
// prescreen so both hear the same voices.
import { DEFAULT_INSTRUMENT, DRUM_SPLIT, GAME_INSTRUMENTS, GM_DRUM_NOTES, GM_PROGRAMS, INSTRUMENT_ALIASES, drumNotesOf, gameInstrument, gameInstrumentForProgram, soundingPitch } from '../../backend/audio/instruments.mjs';
export { DEFAULT_INSTRUMENT, DRUM_SPLIT, GAME_INSTRUMENTS, INSTRUMENT_ALIASES, drumNotesOf, gameInstrument, gameInstrumentForProgram, soundingPitch };

export const DEFAULT_BANK_NAME = 'FluidR3Mono GM（Studio 子集）';
export const DEFAULT_BANK_LABEL = '免費通用音色（近似），不是遊戲音色';

// The game-style bank (game-style-bank.mjs, the owner's own recordings) holds
// each of the 11 instruments as a melodic preset of its own, drums included,
// at these 0-based programs (its instrument list names them 1-based).
export const GAME_STYLE_BANK_NAME = '遊戲風格音色';
export const GAME_STYLE_BANK_LABEL = '遊戲風格音色（模擬），不是實機';
export const GAME_STYLE_PROGRAMS = Object.freeze({
  lute: 0, mandolin: 2, flute: 5, chalumeau: 6, piano: 21, violin: 22, harp: 24, 'music-box': 30, 'bass-drum': 66, cymbals: 68, xylophone: 77,
});
export const DEFAULT_BANK_PROGRAMS = GM_PROGRAMS;
export const DEFAULT_BANK_DRUM_NOTES = GM_DRUM_NOTES;

const byId = new Map(GAME_INSTRUMENTS.map(item => [item.id, item]));

/**
 * The voice one role plays: a GM program, and for a drum instrument its two
 * kit notes (`drumNotes`; `drumNote` is the first, and marks a drum voice).
 * soundingPitch picks the kit note for a written pitch.
 * A choice is a game instrument id (default bank) or `p:<program>` (a preset
 * of the user's own bank). Anything else falls back to the default.
 */
export function voiceFor(choice, { gameStyle = false } = {}) {
  const text = String(choice ?? '');
  const preset = /^p:(\d{1,3})$/.exec(text);
  if (preset && Number(preset[1]) <= 127) return { program: Number(preset[1]), drumNote: null, drumNotes: null, label: `${String(Number(preset[1]) + 1).padStart(3, '0')}` };
  const instrument = gameInstrument(text) ?? byId.get(DEFAULT_INSTRUMENT);
  if (gameStyle) return { program: GAME_STYLE_PROGRAMS[instrument.id], drumNote: null, drumNotes: null, label: instrument.label, id: instrument.id };
  return { program: instrument.program, drumNote: instrument.drumNotes?.[0] ?? null, drumNotes: instrument.drumNotes ?? null, label: instrument.label, id: instrument.id };
}
// The two halves of the six roles, set together from one picker: Melody with
// Chord1–2, and Chord3–5.
export const ROLE_GROUPS = Object.freeze({ front: Object.freeze([0, 1, 2]), back: Object.freeze([3, 4, 5]) });
export const ROLE_GROUP_LABELS = Object.freeze({ front: '前三角色（Melody–Chord2）', back: '後三角色（Chord3–5）' });
// The choice a group shares, or '' when its roles differ.
export const groupChoice = (choices, group) => { const values = ROLE_GROUPS[group].map(role => choices?.[role]); return values.every(value => value !== undefined && value === values[0]) ? values[0] : ''; };
export const resolveRoleVoices = (choices, options) => Array.from({ length: 6 }, (_, role) => voiceFor(choices?.[role], options));

// Picker options: the 11 named instruments for the default bank, the bank's
// own presets for a user bank (`presets` from the engine, once loaded).
export function instrumentOptions({ defaultBank, presets = [] }) {
  if (defaultBank) return GAME_INSTRUMENTS.map(item => ({ value: item.id, label: `${item.label}（${item.name}）` }));
  return presets.map(preset => ({ value: `p:${preset.program}`, label: `${String(preset.program + 1).padStart(3, '0')} ${preset.name}` }));
}
// Bank slots that hold no instrument: `(Not Used)N`, `(Not Used100` once the
// name field is full, `Unused`, `Empty`, `Reserved`, `N/A`, `None`, `---`.
const UNUSED = /^[([{\s]*(not\s*used|unused|empty|reserved|n\/a|none|-+)[)\]}\s]*\d*[)\]}\s]*$/i;
export const isUsablePreset = preset => { const name = String(preset?.name ?? '').trim(); return name !== '' && !UNUSED.test(name); };

// A whole set of voices is uniform when every role plays the same melodic
// program; only then can a playback be a Gate 6 readback of one program.
export const uniformProgram = voices => (voices.every(voice => voice.drumNote === null && voice.program === voices[0].program) ? voices[0].program : null);
