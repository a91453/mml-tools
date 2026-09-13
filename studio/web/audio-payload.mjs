// A deterministic, minimal alignment projection; raw source files stay local.
export function alignmentProjectText(project) {
  return JSON.stringify({ schema: project.schema, id: project.id,
    events: project.events.map(({ kind, start, end, pitch, sourceIds }) => ({ kind, start, end, pitch, sourceIds })),
    tempoEvents: project.tempoEvents.map(({ beat, bpm }) => ({ beat, bpm })) });
}
export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}
