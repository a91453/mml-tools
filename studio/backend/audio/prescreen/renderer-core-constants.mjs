// Constants the renderer, its calibration and the pure metric model share,
// kept apart so nothing outside the render worker imports the synthesizer.
// @2: a drum role sounds two kit notes, split at o4c (instruments.mjs).
import { drumNotesOf } from '../instruments.mjs';

export const RENDERER_ID = 'mml-studio/prescreen-renderer@2';
export const RENDER_ENGINE = 'spessasynth_core@4.3.16';
export const CALIBRATION_ID = 'mml-studio/prescreen-calibration@2';
export const ANCHOR_PITCHES = Object.freeze([24, 36, 48, 60, 72, 84, 96]);
export const PARTIALS = 8;
// A drum voice is keyed by both kit notes it sounds.
export const voiceKey = voice => { const drum = drumNotesOf(voice); return drum ? `d${drum.join('+')}` : `p${voice.program}`; };
