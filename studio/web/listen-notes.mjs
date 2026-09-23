// Listening notes and markers. Pure: no DOM, no storage.
//
// A note is what the owner heard at a position ("這裡太吵", "主旋律不對"):
// plain text for whoever revises the MML next. It is not a review, not
// evidence and not an acceptance, and nothing here turns one into a gate.
// "Copy for AI" is a compact plain-text list meant to be pasted into a chat.
import { cmpBeat, parseBeat } from './roll-geometry.mjs';
import { LISTEN_ROLES, MARKER_KINDS } from './listen-link.mjs';
import { formatClock, positionAt } from './listen-timeline.mjs';

export const NOTE_KINDS = Object.freeze([
  Object.freeze({ id: 'too-loud', label: '太吵／太大聲' }),
  Object.freeze({ id: 'wrong-note', label: '音不對' }),
  Object.freeze({ id: 'timing', label: '節奏／時值' }),
  Object.freeze({ id: 'balance', label: '聲部平衡' }),
  Object.freeze({ id: 'other', label: '其他' }),
]);
export const MARKER_KIND_LABELS = Object.freeze({
  'provisional-release': '暫定收尾',
  'lead-unverified': '主旋律未確認',
  pending: '待審',
  changed: '已變更',
  note: '備註',
});
export const MAX_NOTE_TEXT = 500;
export const MAX_NOTES = 2000;
const RATIONAL = /^(0|[1-9]\d{0,8})(?:\/([1-9]\d{0,8}))?$/;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const noteKind = id => NOTE_KINDS.find(kind => kind.id === id);

/**
 * A clean note, or a thrown reason. Text keeps its words but loses control
 * characters; the position is an exact quarter-beat string.
 */
export function normalizeNote(input, { now = () => new Date().toISOString(), id = () => crypto.randomUUID() } = {}) {
  if (!input || typeof input !== 'object') throw Error('備註格式錯誤');
  const beat = String(input.beat ?? '');
  if (!RATIONAL.test(beat)) throw Error('備註位置需為精確拍數');
  const role = input.role === null || input.role === undefined || input.role === '' ? null : input.role;
  if (role !== null && !LISTEN_ROLES.includes(role)) throw Error('角色不正確');
  if (!noteKind(input.kind)) throw Error('請選擇備註種類');
  const text = String(input.text ?? '').replace(CONTROL, '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw Error('請輸入備註內容');
  if (text.length > MAX_NOTE_TEXT) throw Error(`備註最多 ${MAX_NOTE_TEXT} 字`);
  const created = typeof input.createdAt === 'string' && input.createdAt.length <= 40 ? input.createdAt : now();
  const out = { id: typeof input.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(input.id) ? input.id : id(), beat, role, kind: input.kind, text, createdAt: created, updatedAt: now() };
  if (typeof input.mmlSha256 === 'string' && /^[0-9a-f]{64}$/.test(input.mmlSha256)) out.mmlSha256 = input.mmlSha256;
  return out;
}

// Notes kept on a project travel through backups as plain data. Anything that
// does not read as a note is dropped rather than repaired.
export function sanitizeStoredNotes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list.slice(0, MAX_NOTES)) {
    try {
      const clean = normalizeNote(item, { now: () => (typeof item?.updatedAt === 'string' && item.updatedAt.length <= 40 ? item.updatedAt : new Date(0).toISOString()), id: () => { throw Error('id'); } });
      if (clean.mmlSha256) out.push(clean);
    } catch { /* not a note */ }
  }
  return out;
}

export const sortNotes = notes => [...notes].sort((a, b) => cmpBeat(parseBeat(a.beat), parseBeat(b.beat)) || String(a.createdAt).localeCompare(String(b.createdAt)));

// Notes shown as markers when a session is reopened.
export function notesAsMarkers(notes) {
  return sortNotes(notes).map(note => ({ beat: note.beat, ...(note.role ? { role: note.role } : {}), kind: 'note', label: `${noteKind(note.kind)?.label ?? note.kind}：${note.text.replace(/\s+/g, ' ')}`.slice(0, 200), noteId: note.id }));
}

const oneLine = value => String(value).replace(/\s+/g, ' ').trim();

/**
 * The "Copy for AI" text: title, the MML's identity, then one line per note
 * with bar, beat, time, role, kind and text. Bars and beats use the session's
 * meter; when that meter was assumed the header says so.
 */
export function notesExportText({ title, mmlSha256, meterText, meterAssumed, notes, bars, clock }) {
  const lines = [
    'MML Studio 試聽備註（listening notes）',
    `title: ${oneLine(title || '未命名')}`,
    `mml_sha256: ${mmlSha256}`,
    `meter: ${meterAssumed ? '0 4/4（未提供拍號，假設 4/4）' : String(meterText ?? '').split(/\r?\n/).map(oneLine).filter(Boolean).join('; ')}`,
    `notes: ${notes.length}`,
    'format: bar | beat-in-bar | quarter-beat position | time | role | kind | text',
  ];
  for (const note of sortNotes(notes)) {
    const at = positionAt(bars, note.beat);
    lines.push([`bar ${at.bar}`, `beat ${at.beat}`, `q=${at.exact}`, formatClock(clock.secondsAt(note.beat), 2), note.role ?? 'all roles', note.kind, oneLine(note.text)].join(' | '));
  }
  return lines.join('\n');
}

// ─── markers from a local project report ────────────────────────────────────
// What a local project already knows needs a person's ear, as listening
// markers: the unresolved-evidence ledger of the machine-delivery projection
// (gate-level, so it spans the whole song), unverified Lead evidence at the
// events it names, and unresolved cross-source harmony conflicts. Read-only:
// markers point at places to listen, they never resolve anything.
const LEAD_GATES = new Set(['lead', 'leadDemotion', 'leadPromotion']);
export function markersFromReport(report, { limit = 500 } = {}) {
  if (!report || typeof report !== 'object') return [];
  const end = typeof report.roll?.end === 'string' && RATIONAL.test(report.roll.end) ? report.roll.end : null;
  const events = new Map();
  for (const lane of report.roll?.lanes ?? []) for (const event of lane.events ?? []) events.set(event.id, { ...event, role: lane.role });
  const markers = [];
  const push = marker => { if (markers.length < limit && RATIONAL.test(marker.beat) && (!marker.end_beat || RATIONAL.test(marker.end_beat))) markers.push(marker); };
  for (const entry of report.readiness?.machineDelivery?.unresolved_evidence_ledger ?? []) {
    const blockers = Array.isArray(entry.blockers) && entry.blockers.length ? ` · ${entry.blockers.slice(0, 3).join(', ')}` : '';
    push({ beat: '0', ...(end ? { end_beat: end } : {}), kind: LEAD_GATES.has(entry.gate) ? 'lead-unverified' : 'pending', label: oneLine(`整首待審：${entry.gate} ${entry.status}${blockers}`).slice(0, 200), scope: 'song' });
  }
  for (const item of [...(report.leadPromotionReports ?? []), ...(report.leadReports ?? [])]) {
    if (item?.pass || item?.status === 'PASS') continue;
    const event = events.get(item?.eventId);
    if (!event) continue;
    push({ beat: event.start, end_beat: event.end, role: event.role && LISTEN_ROLES.includes(event.role) ? event.role : 'Melody', kind: 'lead-unverified', label: oneLine(`Lead 證據待審 · ${(item.blockers ?? []).slice(0, 2).join(', ')}`).slice(0, 200) });
  }
  for (const conflict of report.harmony?.conflicts ?? []) {
    if (conflict?.resolved || typeof conflict?.start !== 'string') continue;
    push({ beat: conflict.start, ...(typeof conflict.end === 'string' ? { end_beat: conflict.end } : {}), ...(LISTEN_ROLES.includes(conflict.leftRole) ? { role: conflict.leftRole } : {}), kind: 'pending', label: oneLine(`跨來源和聲待審 · ${conflict.intervalName ?? ''} · ${conflict.leftRole ?? ''} / ${conflict.rightRole ?? ''}`).slice(0, 200) });
  }
  return markers.filter(marker => MARKER_KINDS.includes(marker.kind));
}
