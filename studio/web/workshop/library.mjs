// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// Local song library in IndexedDB (metadata and data stores).
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { MAX_TRACKS, MIN_TRACKS, cleanMeters, cleanMarks, cleanZip, anyZip } from "./config.mjs";
import { safeFileName } from "./mml-out.mjs";

export const DB_NAME = "studio-workshop-library";
const DB_VERSION = 1;

const STORE_META = "files";
const STORE_DATA = "data";

export const SNAPSHOT_VERSION = 1;

export const MAX_BYTES = 20 * 1024 * 1024;

export const MAX_NAME = 100;

export function cleanName(input) {
  return String(input ?? "").trim().slice(0, MAX_NAME).trim();
}

export function zipEntryNames(names) {
  const used = new Set();
  return names.map(n => {
    const base = safeFileName(n);
    let name = `${base}.mml`;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}-${i}.mml`;
    used.add(name.toLowerCase());
    return name;
  });
}

function cleanTab(t) {
  return {
    text: typeof t?.text === "string" ? t.text : "",
    preset: typeof t?.preset === "string" ? t.preset : null,
    ghost: t?.ghost !== false,
  };
}

const int = (v, lo, hi, fallback) =>
  (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

export function cleanSnapshot(s) {
  if (!s || typeof s !== "object" || s.v !== SNAPSHOT_VERSION) return null;
  if (!Array.isArray(s.tabs)) return null;

  const tabs = s.tabs.slice(0, MAX_TRACKS).map(cleanTab);
  if (!tabs.length) return null;

  const count = int(s.count, MIN_TRACKS, MAX_TRACKS, MIN_TRACKS);
  return {
    v: SNAPSHOT_VERSION,
    tabs,
    count,
    active: int(s.active, 0, count - 1, 0),
    ...(s.meters === undefined ? {} : { meters: cleanMeters(s.meters) }),
    ...(s.marks === undefined ? {} : { marks: cleanMarks(s.marks) }),
    ...(s.zip === undefined ? {} : { zip: cleanZip(s.zip) }),
  };
}

export function cleanFile(f) {
  const name = cleanName(f?.name);
  if (!name) return null;
  const num = v => (Number.isFinite(v) && v >= 0 ? v : 0);
  const created = num(f?.createdMs);
  return {
    name,
    createdMs: created,
    updatedMs: Math.max(created, num(f?.updatedMs)),
    tracks: num(f?.tracks),
    notes: num(f?.notes),
    bytes: num(f?.bytes),
  };
}

export function fromSnapshot(snap, ghosts, meters, marks) {
  return {
    v: SNAPSHOT_VERSION,
    count: snap.count,
    active: snap.active,
    ...(meters?.length ? { meters } : {}),
    ...(marks?.length ? { marks } : {}),
    ...(anyZip(snap.zip) ? { zip: [...snap.zip] } : {}),
    tabs: Array.from({ length: MAX_TRACKS }, (_, i) => ({
      text: snap.texts[i] ?? "",
      preset: snap.presets[i] ?? null,
      ghost: ghosts[i] !== false,
    })),
  };
}

export function toSnapshot(saved) {
  return {
    texts: saved.tabs.map(t => t.text),
    presets: saved.tabs.map(t => t.preset),
    ghosts: saved.tabs.map(t => t.ghost),
    zip: cleanZip(saved.zip),
    count: saved.count,
    active: saved.active,
  };
}

export const metersOf = saved => cleanMeters(saved?.meters);

export const marksOf = saved => cleanMarks(saved?.marks);

const utf8 = new TextEncoder();

export const snapshotBytes = snap => utf8.encode(JSON.stringify(snap)).length;

export function fits(used, bytes, replacing = 0) {
  const after = used - replacing + bytes;
  return {
    ok: after <= MAX_BYTES,
    used,
    need: bytes,
    free: Math.max(0, MAX_BYTES - used + replacing),
  };
}

let dbPromise = null;
let broken = false;

export const isBroken = () => broken;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("no indexedDB")); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META))
        db.createObjectStore(STORE_META, { keyPath: "name" });
      if (!db.objectStoreNames.contains(STORE_DATA))
        db.createObjectStore(STORE_DATA, { keyPath: "name" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("open failed"));
    req.onblocked = () => reject(new Error("blocked"));
  }).catch(err => {
    broken = true;
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

const wrap = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error ?? new Error("request failed"));
});

const done = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error("tx failed"));
  tx.onabort = () => reject(tx.error ?? new Error("tx aborted"));
});

export async function list() {
  const db = await open();
  const rows = await wrap(db.transaction(STORE_META, "readonly").objectStore(STORE_META).getAll());
  return rows.map(cleanFile).filter(Boolean).sort((a, b) => b.updatedMs - a.updatedMs);
}

export const usedBytes = files => files.reduce((n, f) => n + f.bytes, 0);

export async function read(name) {
  const db = await open();
  const rec = await wrap(db.transaction(STORE_DATA, "readonly").objectStore(STORE_DATA).get(name));
  return rec ? cleanSnapshot(rec.snapshot) : null;
}

export async function write(meta, snapshot) {
  const db = await open();
  const tx = db.transaction([STORE_META, STORE_DATA], "readwrite");
  tx.objectStore(STORE_META).put(meta);
  tx.objectStore(STORE_DATA).put({ name: meta.name, snapshot });
  await done(tx);
}

export async function remove(names) {
  if (!names.length) return;
  const db = await open();
  const tx = db.transaction([STORE_META, STORE_DATA], "readwrite");
  const meta = tx.objectStore(STORE_META), data = tx.objectStore(STORE_DATA);
  for (const n of names) { meta.delete(n); data.delete(n); }
  await done(tx);
}
