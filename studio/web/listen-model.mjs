// Worker side of listening sessions: read an MML string with the repository's
// own parser (exact rational timing) into a song the preview scheduler plays.
//
// Listening reads in the parser's `ingest` mode: caution lengths and
// non-canonical forms a candidate may still carry are warnings here, because a
// listening session is for hearing a string, not for grading it. Anything the
// parser cannot read at all is an error, and a song with errors is not played.
// Nothing here touches a workspace, a gate or a review.
import { splitMML, parseTrack } from '../backend/mml/parser.mjs';
import { LISTEN_ROLE_NAMES } from './listen-timeline.mjs';

const MAX_FINDINGS = 60;
const finding = item => ({ role: item.role ?? null, position: item.position ?? null, code: item.code ?? null, message: String(item.message ?? '') });
const cmp = (a, b) => { const [an, ad = '1'] = String(a).split('/'), [bn, bd = '1'] = String(b).split('/'); const x = BigInt(an) * BigInt(bd) - BigInt(bn) * BigInt(ad); return x < 0n ? -1 : x > 0n ? 1 : 0; };

export function parseListening(mml) {
  let strings;
  try { strings = splitMML(typeof mml === 'string' ? mml : ''); }
  catch (error) { return { ok: false, errors: [{ role: null, position: null, code: 'MML_SHAPE', message: error.message }], warnings: [], song: null }; }
  const tracks = strings.map((raw, index) => parseTrack(raw, LISTEN_ROLE_NAMES[index], { mode: 'ingest' }));
  const errors = tracks.flatMap(track => track.errors).map(finding);
  const warnings = tracks.flatMap(track => track.warnings).map(finding);
  const active = tracks.filter(track => !track.empty);
  if (!active.length) errors.push({ role: null, position: null, code: 'ALL_ROLES_EMPTY', message: '六軌皆空，沒有可試聽的內容' });
  // The preview plays one tempo map, the first sounding role's, exactly as the
  // Final preview does. A role whose map differs is reported, not merged.
  const tempo = active[0]?.tempo ?? [];
  let total = '0';
  for (const track of active) {
    if (cmp(track.total, total) > 0) total = track.total;
    if (JSON.stringify(track.tempo) !== JSON.stringify(tempo)) warnings.push({ role: track.role, position: null, code: 'TEMPO_MAP_MISMATCH', message: '此角色的 Tempo Map 與第一個非空角色不同；試聽使用第一個非空角色的 Tempo Map' });
  }
  const song = {
    tracks: tracks.map(track => ({ role: track.role, empty: track.empty, total: track.total, events: track.events.map(event => ({ pitch: event.pitch, start: event.start, end: event.end, volume: event.volume })) })),
    tempo: tempo.map(point => ({ beat: point.beat, bpm: point.bpm })),
    total,
  };
  return { ok: errors.length === 0, errors: errors.slice(0, MAX_FINDINGS), errorCount: errors.length, warnings: warnings.slice(0, MAX_FINDINGS), warningCount: warnings.length, song };
}
