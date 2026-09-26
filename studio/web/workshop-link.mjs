// The small adapter between Studio Web and the Workshop (studio/web/workshop/).
//
// Both pages are the same origin and the same browser, so nothing here makes
// a request. Studio → Workshop: a link carries the project id and which MML
// to open; the Workshop reads that project from Studio's own IndexedDB and
// opens a COPY. Workshop → Studio: the Workshop leaves one record in
// localStorage and navigates to Studio, which imports it through its usual
// source intake (putSource → intake → invalidate) as a derived candidate.
//
// A Workshop edit is outside the Canonical/verified pipeline. Crossing back
// never marks anything VALIDATED or accepted; Studio re-runs its own
// technical validation and every review starts over.
import { assetMml } from './asset-mml.mjs';

export const UNVERIFIED_LABEL = '工作坊編輯（未經 Studio 驗證）';
export const RETURN_KEY = 'studio-workshop/return';
export const RETURN_TTL_MS = 24 * 60 * 60 * 1000;
export const RETURN_SCHEMA = 'mml-studio/workshop-return@1';
export const MAX_RETURN_CHARS = 200000;
export const WORKSHOP_PATH = 'studio/web/workshop/index.html';

const SLOT_LABELS = {
  delivery: 'Final／交付 MML',
  candidate: '目前候選',
  baseline: 'Source-Faithful Baseline',
  previous: '已接受的前一版',
};

// Every MML string a stored Studio workspace holds, in a fixed order.
export function projectSources(workspace) {
  const out = [];
  if (!workspace || typeof workspace !== 'object') return out;
  if (typeof workspace.deliveryMml === 'string' && workspace.deliveryMml.trim()) {
    out.push({ slot: 'delivery', label: SLOT_LABELS.delivery, name: 'final.mml', mml: workspace.deliveryMml.trim() });
  }
  for (const slot of ['candidate', 'baseline', 'previous']) {
    const asset = workspace.assets?.[slot];
    const mml = assetMml(asset);
    if (typeof mml === 'string' && /MML@/i.test(mml)) {
      out.push({ slot, label: SLOT_LABELS[slot], name: String(asset.name ?? `${slot}.mml`), mml: mml.trim() });
    }
  }
  return out;
}

// Studio-relative link that opens one project MML in the Workshop.
export function workshopUrl(projectId, slot, base = './') {
  const params = new URLSearchParams({ 'studio-project': String(projectId), asset: String(slot) });
  return `${base}${WORKSHOP_PATH}#${params}`;
}

export function parseWorkshopHash(hash) {
  const params = new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
  const projectId = params.get('studio-project');
  const slot = params.get('asset');
  return projectId && slot ? { projectId, slot } : null;
}

export function parseReturnHash(hash) {
  const params = new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
  return params.get('workshop-return');
}

// Workshop side: leave the six-role MML for Studio. Returns the record id.
export function putReturn({ mml, name = '', origin = null, warnings = [] }, storage = globalThis.localStorage, now = Date.now()) {
  if (typeof mml !== 'string' || !/^MML@/i.test(mml) || mml.length > MAX_RETURN_CHARS) throw Error('WORKSHOP_RETURN_INVALID');
  const id = globalThis.crypto.randomUUID();
  const record = { schema: RETURN_SCHEMA, id, at: now, mml, name: String(name).slice(0, 100), origin, warnings: warnings.map(String).slice(0, 20), label: UNVERIFIED_LABEL, verified: false };
  storage.setItem(RETURN_KEY, JSON.stringify(record));
  return id;
}

// Studio side: read the record once. Anything malformed, stale or for another
// id is dropped rather than imported.
export function takeReturn(id, storage = globalThis.localStorage, now = Date.now()) {
  let raw = null;
  try { raw = storage.getItem(RETURN_KEY); } catch { return null; }
  if (!raw) return null;
  let record = null;
  try { record = JSON.parse(raw); } catch { record = null; }
  const valid = record && record.schema === RETURN_SCHEMA && record.id === id && typeof record.mml === 'string'
    && /^MML@/i.test(record.mml) && record.mml.length <= MAX_RETURN_CHARS && Number.isFinite(record.at) && now - record.at <= RETURN_TTL_MS;
  if (!valid) { if (!record || record.id === id || now - (record.at ?? 0) > RETURN_TTL_MS) storage.removeItem(RETURN_KEY); return null; }
  storage.removeItem(RETURN_KEY);
  // Only these fields cross; the record can never carry a verification claim.
  return { id: record.id, at: record.at, mml: record.mml, name: String(record.name ?? ''), origin: record.origin ?? null, warnings: Array.isArray(record.warnings) ? record.warnings.map(String) : [], label: UNVERIFIED_LABEL, verified: false };
}

// File name for the derived candidate Studio imports.
export function returnFileName(record, date = new Date()) {
  const stamp = date.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const base = String(record?.name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 60);
  return `${base ? `${base}-` : ''}workshop-edit-${stamp}.mml`;
}
