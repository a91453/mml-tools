import { validateAudioAlignmentReport } from '../backend/audio/index.mjs';

export const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
export async function requestAudioAlignment({ requested, file, project, endpoint, token, signal, fetcher = globalThis.fetch }) {
  if (requested !== true) throw Error('AUDIO_UPLOAD_NOT_REQUESTED');
  if (!file || !/\.(m4a|flac|wav)$/i.test(file.name) || file.size <= 0 || file.size > MAX_AUDIO_BYTES) throw Error('僅支援 64 MiB 以內的 M4A／FLAC／WAV');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('需要沒有帳密或 query 的 HTTPS Audio Worker endpoint');
  if (!token?.trim()) throw Error('需要本次工作階段的 Audio Worker access token');
  // Only explicit alignment sends audio plus derived timing/pitch features.
  // Original MusicXML/MML bytes, reviews, other sources and credentials never
  // enter the payload. Credentials are memory-only and never stored in projects.
  const symbolic = { schema: project.schema, id: project.id, events: project.events.map(({ kind, start, end, pitch, sourceIds }) => ({ kind, start, end, pitch, sourceIds })), tempoEvents: project.tempoEvents.map(({ beat, bpm }) => ({ beat, bpm })) };
  const projectText = JSON.stringify(symbolic);
  if (new TextEncoder().encode(projectText).length > 4 * 1024 * 1024) throw Error('UNSUPPORTED: alignment project exceeds 4 MiB');
  const audioHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(n => n.toString(16).padStart(2, '0')).join('');
  const response = await fetcher(url.href, { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/octet-stream', 'Authorization': `Bearer ${token}`, 'X-Audio-Format': file.name.split('.').at(-1).toLowerCase(), 'X-Project-Bytes': String(new TextEncoder().encode(projectText).length) },
    body: new Blob([projectText, file], { type: 'application/octet-stream' }) });
  if (!response.ok) throw Error(`Audio Worker: HTTP ${response.status}`);
  const report = await response.json();
  validateAudioAlignmentReport(report, project);
  if (report.audio.sha256.toLowerCase() !== audioHash) throw Error('AUDIO_IDENTITY_MISMATCH');
  return report;
}
