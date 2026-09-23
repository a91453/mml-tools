// Where a delivered Final still needs a human ear, read from what the Final
// itself files (Canonical 2026-09-23-v3, machine-delivery schema @2):
//
//   * provisional-release -- every release the delivered MML holds
//     provisionally: `provisional_release_rendering.renderings[]` (eventId,
//     role, onset, release, renderedRelease, intervalKeys), else the ledger's
//     microTiming `provisional_releases[]`. The position is the source release,
//     where the unproven interval starts, to the rendered release.
//   * lead-unverified -- the Melody notes delivered as arranged without primary
//     Lead evidence: the ledger's leadPromotion `unverified_lead_event_ids[]`.
//     The ledger names events, not beats, so each id is placed from the
//     Final's own rendering records or, failing that, the read-only baseline
//     projection, and kept only where the delivered Melody really has a note
//     at that onset. An id nothing can place stays a song-level count.
//   * every other listenable ledger entry: its position fields if a record
//     ever carries some (no current gate does), else a song-level note.
//
// A real song holds on the order of a thousand provisional releases, so runs of
// neighbouring items per role are grouped into ranges -- as few merges as
// keep each kind within its marker budget -- and the full counts are kept in
// song-level notes. Server-side only; pure apart from the injected lookup.
import { F } from '../../dist/core.js';
import { LISTEN_LIMITS } from '../../studio/web/listen-link.mjs';
import { LISTEN_ROLES, listenBeatNumber } from './mml-events.mjs';

export const PROVISIONAL_MARKER_BUDGET = 200;
export const LEAD_MARKER_BUDGET = 100;
const OTHER_MARKER_BUDGET = 100;
const MAX_NOTES = 50;
const MAX_LABEL = LISTEN_LIMITS.labelChars;
const MAX_LEAD_LOOKUP = 5000;
const GAP_STEPS = [0, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 1024, Infinity];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/**
 * A label or title the listen-link contract accepts: the control and line
 * separator characters it refuses become spaces, and the text is cut to `max`.
 */
export const clip = (text, max = MAX_LABEL) => {
  const value = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
const count = value => value.toLocaleString('en-US');

/** A beat as the repository prints a rational ("88", "177/2"), or null. */
export function beatOf(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    value = Number.isInteger(value) ? String(value) : value.toFixed(9).replace(/0+$/, '');
  }
  if (typeof value !== 'string' || !/^\d{1,9}(?:\/[1-9]\d{0,8}|\.\d{1,9})?$/.test(value)) return null;
  try {
    const beat = new F(value);
    return beat.cmp(0) < 0 ? null : beat.toString();
  } catch { return null; }
}

const GATE_LABELS = Object.freeze({
  originalAudio: '原曲音訊對照',
  mobileAdaptation: 'Mobile 適配審查',
  regression: '回歸審查',
  playerReadback: '播放器回讀',
  inGameAcceptance: '遊戲內驗收',
  core3Completeness: 'Core3 完整度審查',
  versionDrift: '版本差異審查',
  leadPromotion: 'Lead（主旋律）證據',
  microTiming: '微時值（release）',
});
export const gateLabel = gate => GATE_LABELS[gate] ?? gate;
const FLAG_LABELS = Object.freeze({
  RELEASES_RENDERED_PROVISIONALLY: 'release 暫定表示',
  LEAD_UNVERIFIED: '主旋律未驗證',
});
export const flagLabel = flag => FLAG_LABELS[flag] ?? flag;

const LISTENABLE = new Set(['NON_BLOCKING_PENDING', 'POST_DELIVERY']);

export function ledgerOf(artifact) {
  const delivery = isObject(artifact?.machine_delivery) ? artifact.machine_delivery : null;
  if (!delivery) return [];
  const ledger = Array.isArray(delivery.unresolved_evidence_ledger)
    ? delivery.unresolved_evidence_ledger
    : [...(Array.isArray(delivery.non_blocking_pending) ? delivery.non_blocking_pending : []), ...(Array.isArray(delivery.post_delivery) ? delivery.post_delivery : [])];
  return ledger.filter(entry => isObject(entry) && typeof entry.gate === 'string' && LISTENABLE.has(entry.classification));
}

export function deliveryFlagsOf(artifact) {
  const flags = Array.isArray(artifact?.delivery?.flags) ? artifact.delivery.flags
    : Array.isArray(artifact?.machine_delivery?.delivery_flags) ? artifact.machine_delivery.delivery_flags : [];
  return [...new Set(flags.filter(flag => typeof flag === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(flag)))];
}

// ─── grouping ───────────────────────────────────────────────────────────────

/**
 * Group items ({role, start, end, beat, endBeat}) per role into runs whose
 * neighbours are at most `gap` beats apart, using the smallest gap from a
 * fixed ladder that keeps the result within `budget`. Deterministic.
 */
export function groupRuns(items, budget) {
  const byRole = new Map();
  for (const item of items) {
    if (!byRole.has(item.role)) byRole.set(item.role, []);
    byRole.get(item.role).push(item);
  }
  const roles = [...byRole.keys()].sort((a, b) => roleOrder(a) - roleOrder(b));
  for (const list of byRole.values()) list.sort((a, b) => a.start - b.start || a.end - b.end);
  for (const gap of GAP_STEPS) {
    const groups = [];
    for (const role of roles) {
      let current = null;
      for (const item of byRole.get(role)) {
        if (current && item.start - current.end <= gap + 1e-9) {
          current.items.push(item);
          if (item.end > current.end) { current.end = item.end; current.endBeat = item.endBeat; }
        } else {
          current = { role, start: item.start, end: item.end, beat: item.beat, endBeat: item.endBeat, items: [item] };
          groups.push(current);
        }
      }
    }
    if (groups.length <= budget || gap === Infinity) return { gap, groups: groups.sort((a, b) => a.start - b.start || roleOrder(a.role) - roleOrder(b.role)) };
  }
  return { gap: Infinity, groups: [] };
}
const roleOrder = role => { const index = LISTEN_ROLES.indexOf(role); return index < 0 ? LISTEN_ROLES.length : index; };

// ─── provisional releases ───────────────────────────────────────────────────

function provisionalRecords(artifact) {
  const rendering = isObject(artifact?.provisional_release_rendering) ? artifact.provisional_release_rendering : null;
  if (rendering && Array.isArray(rendering.renderings) && rendering.renderings.length) {
    return {
      source: 'provisional_release_rendering',
      records: rendering.renderings.map(item => ({ eventId: item?.eventId, role: item?.role, onset: item?.onset, release: item?.release, rendered: item?.renderedRelease, intervals: Array.isArray(item?.intervalKeys) ? item.intervalKeys.length : 0 })),
      offsetSources: Array.isArray(rendering.releaseOffsetSources) ? rendering.releaseOffsetSources.map(item => ({
        sourceId: item?.sourceId, dominantOffset: item?.dominantOffset, share: item?.share, sharePercent: item?.sharePercent, minimumShare: item?.minimumShare,
        qualifies: item?.qualifies === true, releaseCount: item?.releaseCount, rendered: item?.provisionallyRendered, unresolved: item?.unresolved,
      })) : [],
      heldEventCount: Number.isInteger(rendering.heldEventCount) ? rendering.heldEventCount : rendering.renderings.length,
      closedIntervalCount: Number.isInteger(rendering.closedIntervalCount) ? rendering.closedIntervalCount : null,
    };
  }
  // A record that files no rendering (or an empty one) may still say, through
  // its ledger, which releases it holds.
  const entry = ledgerOf(artifact).find(item => item.gate === 'microTiming' && Array.isArray(item.provisional_releases) && item.provisional_releases.length);
  if (!entry) return null;
  return {
    source: 'machine-delivery-ledger',
    records: entry.provisional_releases.map(item => ({ eventId: item?.event_id, role: item?.role, onset: null, release: item?.release, rendered: item?.rendered_release, intervals: null })),
    offsetSources: (Array.isArray(entry.release_offset_sources) ? entry.release_offset_sources : []).map(item => ({
      sourceId: item?.source_id, dominantOffset: item?.dominant_offset, share: item?.share, sharePercent: item?.share_percent, minimumShare: item?.minimum_share,
      qualifies: item?.qualifies === true, releaseCount: item?.release_count, rendered: item?.provisionally_rendered, unresolved: item?.unresolved,
    })),
    heldEventCount: entry.provisional_releases.length,
    closedIntervalCount: null,
  };
}

function provisionalMarkers(artifact, totalBeats) {
  const found = provisionalRecords(artifact);
  if (!found) return { markers: [], notes: [], summary: null };
  const items = [];
  let unplaced = 0;
  for (const record of found.records) {
    const beat = beatOf(record.release);
    const rendered = beatOf(record.rendered) ?? beat;
    if (beat === null || !LISTEN_ROLES.includes(record.role) || listenBeatNumber(beat) > totalBeats) { unplaced++; continue; }
    const start = listenBeatNumber(beat);
    const end = Math.max(start, listenBeatNumber(rendered));
    items.push({ role: record.role, start, end, beat, endBeat: end > start ? rendered : null, eventId: typeof record.eventId === 'string' ? record.eventId : null });
  }
  const { groups } = groupRuns(items, PROVISIONAL_MARKER_BUDGET);
  const markers = groups.map(group => {
    const one = group.items.length === 1;
    return {
      beat: group.beat,
      end_beat: group.endBeat && listenBeatNumber(group.endBeat) > group.start ? group.endBeat : null,
      role: group.role,
      kind: 'provisional-release',
      gate: 'microTiming',
      source: found.source,
      count: group.items.length,
      label: clip(one
        ? `release 暫定表示：延到 beat ${group.items[0].endBeat ?? group.beat}（未證實的 release，暫時接到下一格）`
        : `release 暫定表示 ×${group.items.length}：beat ${group.beat}–${group.endBeat ?? group.beat}（未證實的 release，暫時接到下一格）`),
    };
  });
  const perRole = LISTEN_ROLES.map(role => [role, items.filter(item => item.role === role).length]).filter(([, n]) => n);
  const notes = [{
    gate: 'microTiming',
    classification: 'NON_BLOCKING_PENDING',
    status: 'PENDING',
    blockers: [],
    label: clip(`release 暫定表示：共 ${count(found.heldEventCount)} 個 release 暫時延到下一格（${perRole.map(([role, n]) => `${role} ${count(n)}`).join('、')}）${markers.length < items.length ? `，播放器合併成 ${markers.length} 個區段標記` : ''}${unplaced ? `；${count(unplaced)} 個無法定位` : ''}。仍未證實，請聽收尾。`),
  }];
  for (const source of found.offsetSources.slice(0, 6)) {
    if (typeof source.sourceId !== 'string') continue;
    notes.push({
      gate: 'microTiming', classification: 'NON_BLOCKING_PENDING', status: 'PENDING', blockers: [],
      label: clip(`來源 ${source.sourceId}：主要偏移 ${source.dominantOffset ?? '無（平手）'}，占 ${source.share ?? '—'}${source.sharePercent ? `（${source.sharePercent}%）` : ''}，門檻 ${source.minimumShare ?? '—'}${source.qualifies ? '，符合' : '，不符合'}；暫定 ${Number.isInteger(source.rendered) ? count(source.rendered) : '—'}、未解決 ${Number.isInteger(source.unresolved) ? count(source.unresolved) : '—'}`),
    });
  }
  return {
    markers,
    notes,
    summary: { held: found.heldEventCount, closed_intervals: found.closedIntervalCount, placed: items.length, unplaced, markers: markers.length, source: found.source },
  };
}

// ─── unverified Lead ────────────────────────────────────────────────────────

const melodyNotesOf = parsedTracks => {
  const melody = parsedTracks.find(track => track.role === 'Melody');
  return melody ? melody.events : [];
};

async function leadMarkers(artifact, { parsedTracks, lookupBaselineEvents }) {
  const entry = ledgerOf(artifact).find(item => item.gate === 'leadPromotion' && Array.isArray(item.unverified_lead_event_ids));
  if (!entry) return { markers: [], notes: [], summary: null, handled: false };
  const ids = [...new Set(entry.unverified_lead_event_ids.filter(id => typeof id === 'string' && id))];
  // Where each id sounds: the Final's own rendering records first (they carry
  // the onset of every held release), then the read-only baseline projection.
  const onsets = new Map();
  const rendering = artifact?.provisional_release_rendering;
  for (const item of Array.isArray(rendering?.renderings) ? rendering.renderings : []) {
    const onset = beatOf(item?.onset);
    if (typeof item?.eventId === 'string' && onset !== null) onsets.set(item.eventId, onset);
  }
  const missing = ids.filter(id => !onsets.has(id)).slice(0, MAX_LEAD_LOOKUP);
  if (missing.length && typeof lookupBaselineEvents === 'function') {
    try {
      for (const event of await lookupBaselineEvents(missing)) {
        const onset = beatOf(event?.start);
        if (typeof event?.event_id === 'string' && onset !== null && !onsets.has(event.event_id)) onsets.set(event.event_id, onset);
      }
    } catch { /* a failed lookup leaves those ids unplaced */ }
  }
  // Kept only where the delivered Melody has a note starting at that onset.
  const melody = melodyNotesOf(parsedTracks);
  const indexByStart = new Map(melody.map((note, index) => [note.start, index]));
  const placedIndexes = new Set();
  for (const id of ids) {
    const onset = onsets.get(id);
    if (onset !== undefined && indexByStart.has(onset)) placedIndexes.add(indexByStart.get(onset));
  }
  const placedIds = ids.filter(id => onsets.has(id) && indexByStart.has(onsets.get(id))).length;
  const items = [...placedIndexes].sort((a, b) => a - b).map(index => {
    const note = melody[index];
    return { role: 'Melody', start: listenBeatNumber(note.start), end: listenBeatNumber(note.end), beat: note.start, endBeat: note.end };
  });
  const { groups } = groupRuns(items, LEAD_MARKER_BUDGET);
  const markers = groups.map(group => ({
    beat: group.beat,
    end_beat: group.endBeat,
    role: 'Melody',
    kind: 'lead-unverified',
    gate: 'leadPromotion',
    source: 'machine-delivery-ledger',
    count: group.items.length,
    label: clip(`主旋律未驗證${group.items.length > 1 ? ` ×${group.items.length}` : ''}：beat ${group.beat}–${group.endBeat}（這段 Melody 缺主要 Lead 證據，照編排交付）`),
  }));
  const unplaced = ids.length - placedIds;
  const notes = [{
    gate: 'leadPromotion',
    classification: entry.classification,
    status: typeof entry.status === 'string' ? entry.status : 'PENDING',
    blockers: Array.isArray(entry.blockers) ? entry.blockers.filter(code => typeof code === 'string').slice(0, 12) : [],
    label: clip(`主旋律未驗證：${count(ids.length)} 個 Melody 音缺主要 Lead 證據，照編排交付${markers.length ? `，標成 ${markers.length} 個區段` : ''}${unplaced ? `；${count(unplaced)} 個無法在交付的 Melody 上定位` : ''}。聽起來是否像主旋律，請用回饋告訴 AI；這不是 Lead 證據。`),
  }];
  return { markers, notes, summary: { unverified: ids.length, placed: placedIds, unplaced, markers: markers.length }, handled: true };
}

// ─── everything else in the ledger ──────────────────────────────────────────

const POSITION_LISTS = ['locations', 'positions', 'events', 'items', 'entries', 'markers', 'spans'];

// No current gate files positions for these; read them if a record ever does.
function positionsOf(record, depth = 0, out = []) {
  if (!isObject(record) || depth > 2 || out.length >= OTHER_MARKER_BUDGET) return out;
  const beat = beatOf(record.beat ?? record.start_beat ?? record.at_beat ?? record.onset ?? record.start);
  const bar = [record.bar, record.bar_index, record.bar_number].find(value => Number.isSafeInteger(value) && value >= 1 && value <= 10000) ?? null;
  if (beat !== null || bar !== null) {
    const label = [record.label, record.finding, record.message, record.reason, record.code].find(value => typeof value === 'string' && value.trim());
    out.push({ beat, bar, end_beat: beatOf(record.end_beat ?? record.end), role: LISTEN_ROLES.includes(record.role) ? record.role : null, label: label ? clip(label) : null });
  }
  for (const key of POSITION_LISTS) {
    if (Array.isArray(record[key])) for (const item of record[key].slice(0, OTHER_MARKER_BUDGET)) positionsOf(item, depth + 1, out);
  }
  return out;
}

/**
 * Markers and song-level notes for a delivered Final. `parsedTracks` are the
 * Final MML's own listening events (mml-events.mjs); `lookupBaselineEvents`
 * is an optional read-only `(eventIds) => [{event_id, start}]`.
 */
export async function finalListeningMarkers(artifact, { parsedTracks = [], totalBeats = Infinity, lookupBaselineEvents = null } = {}) {
  const markers = [];
  const other = [];
  const provisional = provisionalMarkers(artifact, totalBeats);
  const lead = await leadMarkers(artifact, { parsedTracks, lookupBaselineEvents });
  markers.push(...provisional.markers, ...lead.markers);

  for (const entry of ledgerOf(artifact)) {
    const status = typeof entry.status === 'string' ? entry.status : 'PENDING';
    const blockers = Array.isArray(entry.blockers) ? entry.blockers.filter(code => typeof code === 'string').slice(0, 12) : [];
    if (entry.gate === 'microTiming' && provisional.summary) continue;
    if (entry.gate === 'leadPromotion' && lead.handled) continue;
    const where = positionsOf(entry);
    if (!where.length) {
      other.push({ gate: entry.gate, classification: entry.classification, status, blockers, label: `${gateLabel(entry.gate)}：${status}` });
      continue;
    }
    for (const position of where) {
      markers.push({
        ...position,
        kind: entry.gate === 'leadPromotion' ? 'lead-unverified' : 'pending',
        gate: entry.gate,
        source: 'machine-delivery-ledger',
        count: 1,
        label: clip(position.label ? `${gateLabel(entry.gate)}：${position.label}` : `${gateLabel(entry.gate)}：${status}`),
      });
    }
  }
  // The flagged items first: they are what the delivery says it carries.
  const notes = [...provisional.notes, ...lead.notes, ...other];

  const flags = deliveryFlagsOf(artifact);
  const restated = Array.isArray(artifact?.tempo_restatements?.collapsed) ? artifact.tempo_restatements.collapsed.length : 0;
  if (restated) notes.push({ gate: null, classification: null, status: null, blockers: [], label: `Tempo：${count(restated)} 個同值的 Tempo 重述沒有寫進 MML（速度不變）。` });
  return {
    markers,
    notes: notes.slice(0, MAX_NOTES),
    delivery_flags: flags,
    provisional_releases: provisional.summary,
    unverified_lead: lead.summary,
  };
}
