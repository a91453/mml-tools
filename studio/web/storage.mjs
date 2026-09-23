const DATABASE = 'mml-studio-web-v1';
// v2 adds `projectMeta`: one small record per project so the project list can
// be drawn without loading every workspace, some of which carry megabytes of
// Raw MIDI. (Lesson from the owner's earlier frontend song library, which keeps list
// metadata and song data in separate stores written in one transaction.)
// `projects` keeps the full workspaces exactly as v1 stored them.
const VERSION = 2;
const metaOf = workspace => ({
  id: workspace.id,
  title: workspace.title ?? '',
  savedAt: workspace.savedAt ?? '',
  revision: workspace.revision ?? 0,
});

export function openStore(indexedDB = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    if (!indexedDB) return reject(Error('本機儲存不可用，請匯出專案備份'));
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = event => {
      const db = request.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('projectMeta')) {
        const meta = db.createObjectStore('projectMeta', { keyPath: 'id' });
        // Migrating a v1 database: derive the list records from what is stored.
        if (event.oldVersion >= 1) {
          request.transaction.objectStore('projects').openCursor().onsuccess = cursor => {
            const at = cursor.target.result;
            if (!at) return;
            meta.put(metaOf(at.value));
            at.continue();
          };
        }
      }
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error('請關閉其他舊版 Studio 分頁後重試'));
    request.onsuccess = () => resolve(request.result);
  });
}
const newestFirst = (a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? '');
function read(storeName, work) {
  return openStore().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = work(tx.objectStore(storeName));
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error ?? Error('本機讀取中斷')); };
  }));
}

// Full workspaces, newest first (kept for callers that need every project).
export async function listProjects() {
  return (await read('projects', store => store.getAll())).sort(newestFirst);
}
// List records only: id, title, savedAt, revision.
export async function listProjectSummaries() {
  return (await read('projectMeta', store => store.getAll())).sort(newestFirst);
}
export async function loadProject(id) {
  const workspace = await read('projects', store => store.get(id));
  if (!workspace) throw Error('找不到選取的專案，請重新開啟');
  return workspace;
}
export async function saveProject(workspace) {
  const db = await openStore();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction(['projects', 'projectMeta'], 'readwrite');
    const store = tx.objectStore('projects');
    const get = store.get(workspace.id);
    let result, error;
    get.onsuccess = () => {
      if (get.result && get.result.saveToken !== workspace.saveToken) {
        error = Error('另一個分頁已更新此專案。請重新開啟專案，或匯出目前內容備份。');
        tx.abort(); return;
      }
      result = { ...workspace, saveToken: crypto.randomUUID(), savedAt: new Date().toISOString() };
      store.put(result);
      tx.objectStore('projectMeta').put(metaOf(result));
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(error ?? tx.error ?? Error('本機儲存中斷，請匯出備份'));
  }); } finally { db.close(); }
}

// Storage health for the save-state indicator. Both calls are optional in
// browsers; absence is reported, never guessed.
export async function storageHealth(navigatorLike = globalThis.navigator) {
  const storage = navigatorLike?.storage;
  const [estimate, persisted] = await Promise.all([
    storage?.estimate ? storage.estimate().catch(() => null) : null,
    storage?.persisted ? storage.persisted().catch(() => null) : null,
  ]);
  return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null, persisted: persisted ?? null };
}
// Only on the user's explicit request (Safari largely ignores it; harmless).
export async function requestPersistence(navigatorLike = globalThis.navigator) {
  if (!navigatorLike?.storage?.persist) return null;
  return navigatorLike.storage.persist();
}
