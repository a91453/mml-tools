// Synthetic six-role MML for prescreen tests: generated, not taken from any
// song. A I-vi-IV-V progression at T120 in 4/4 (one bar = 2 s), with a Melody
// of eighth notes, two chord roles, a bass and two sparse inner roles.
const CHORDS = [
  { root: 'c', third: 'e', fifth: 'g' },
  { root: 'a', third: 'c', fifth: 'e' },
  { root: 'f', third: 'a', fifth: '>c<' },
  { root: 'g', third: 'b', fifth: '>d<' },
];
const MELODY = ['e', 'g', 'a', 'g', 'e', 'd', 'c', 'd'];

/**
 * `variant`:
 *   'base'    the progression as written;
 *   'crunch'  Chord2 plays the bass a semitone up in every other bar, a low
 *             major seventh against Chord1's root (a machine-obvious defect);
 *   'thin'    Chord3-Chord5 rest (a different arrangement, not a defect).
 */
export function syntheticSongMml({ bars = 110, variant = 'base' } = {}) {
  const melody = ['t120o5v11l8'];
  const chord1 = ['t120o3v9l2'];
  const chord2 = ['t120o2v10l1'];
  const chord3 = ['t120o4v7l4'];
  const chord4 = ['t120o4v6l2'];
  const chord5 = ['t120o5v5l1'];
  for (let bar = 0; bar < bars; bar++) {
    const chord = CHORDS[bar % 4];
    melody.push(MELODY.map((note, i) => (bar % 8 === 7 && i > 5 ? 'r' : note)).join(''));
    chord1.push(`${chord.root}${chord.third}`);
    const bass = variant === 'crunch' && bar % 2 === 1 ? `${chord.root}+` : chord.root;
    chord2.push(`${bass}`);
    if (variant === 'thin') {
      chord3.push('r1'); chord4.push('r1'); chord5.push('r1');
    } else {
      chord3.push(`${chord.third}${chord.fifth}${chord.third}${chord.fifth}`.replace(/[<>]/g, ''));
      chord4.push(`${chord.fifth.replace(/[<>]/g, '')}r`);
      chord5.push(bar % 2 ? 'r' : chord.root);
    }
  }
  return `MML@${[melody, chord1, chord2, chord3, chord4, chord5].map(parts => parts.join('')).join(',')};`;
}

export const SYNTHETIC_METER = '0 4/4';
