const DATABASE = 'mml-studio-web-v1';
export function openStore(indexedDB = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    if (!indexedDB) return reject(Error('本機儲存不可用，請匯出專案備份'));
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects', { keyPath: 'id' });
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error('請關閉其他舊版 Studio 分頁後重試'));
    request.onsuccess = () => resolve(request.result);
  });
}
export async function listProjects() {
  const db = await openStore();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction('projects', 'readonly');
    const request = tx.objectStore('projects').getAll();
    tx.oncomplete = () => resolve(request.result.sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? Error('本機讀取中斷'));
  }); } finally { db.close(); }
}
export async function saveProject(workspace) {
  const db = await openStore();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction('projects', 'readwrite');
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
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(error ?? tx.error ?? Error('本機儲存中斷，請匯出備份'));
  }); } finally { db.close(); }
}
