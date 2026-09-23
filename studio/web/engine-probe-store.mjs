// In-game probe observations, kept on this device (engine-probe.mjs).
// A separate IndexedDB database from projects: an observation is about the
// game client, not about a song, so it never travels with a project backup.
// The user exports it explicitly as evidence JSON.
const DB = 'mml-studio-engine-evidence';
const STORE = 'observations';

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? Error('實機紀錄儲存區無法開啟'));
    request.onblocked = () => reject(Error('實機紀錄儲存區被其他分頁占用'));
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
      tx.onabort = () => reject(tx.error ?? Error('實機紀錄儲存已中止'));
    });
  } finally { db.close(); }
}

export const addObservation = observation => run('readwrite', store => store.add({ ...observation }));
export const listObservations = () => run('readonly', store => store.getAll());
export const deleteObservation = id => run('readwrite', store => store.delete(id));
