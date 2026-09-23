// Listening sessions, kept on this device.
//
// A separate IndexedDB database from projects (storage.mjs): opening a listen
// link must never create, open or overwrite a project, and a session is a
// listening aid rather than project evidence. Sessions are listed, reopened
// and deleted here; nothing is uploaded.
const DB = 'mml-studio-listening';
const STORE = 'sessions';
export const LISTENING_SESSION_SCHEMA = 'mml-studio-web/listening-session@1';
export const MAX_SESSIONS = 200;

function open(indexedDB = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    if (!indexedDB) return reject(Error('本機儲存不可用，試聽工作階段無法保存'));
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? Error('試聽工作階段儲存區無法開啟'));
    request.onblocked = () => reject(Error('試聽工作階段儲存區被其他分頁占用'));
  });
}
async function run(mode, work) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? Error('試聽工作階段儲存已中止'));
    });
  } finally { db.close(); }
}

const newestFirst = (a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''));
// List entries only; a session is loaded in full when opened.
export async function listSessions() {
  const all = await run('readonly', store => store.getAll());
  return (all ?? []).sort(newestFirst).map(s => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, createdAt: s.createdAt, origin: s.origin?.kind ?? 'link', mmlSha256: s.mmlSha256 }));
}
export async function getSession(id) {
  const session = await run('readonly', store => store.get(id));
  if (!session) throw Error('找不到這個試聽工作階段');
  return session;
}
export async function saveSession(session) {
  const record = { ...session, schema: LISTENING_SESSION_SCHEMA, updatedAt: new Date().toISOString() };
  await run('readwrite', store => store.put(record));
  return record;
}
export const deleteSession = id => run('readwrite', store => store.delete(id));
