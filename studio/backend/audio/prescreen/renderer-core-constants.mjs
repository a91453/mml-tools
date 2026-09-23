// Constants the renderer, its calibration and the pure metric model share,
// kept apart so nothing outside the render worker imports the synthesizer.
export const RENDERER_ID = 'mml-studio/prescreen-renderer@1';
export const RENDER_ENGINE = 'spessasynth_core@4.3.16';
export const CALIBRATION_ID = 'mml-studio/prescreen-calibration@1';
export const ANCHOR_PITCHES = Object.freeze([24, 36, 48, 60, 72, 84, 96]);
export const PARTIALS = 8;
export const voiceKey = voice => (voice.drumNote !== null && voice.drumNote !== undefined ? `d${voice.drumNote}` : `p${voice.program}`);
