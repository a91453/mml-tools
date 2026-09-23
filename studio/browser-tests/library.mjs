import assert from 'node:assert/strict';

// Local library v2: the save-state indicator, the whole-library ZIP backup
// round trip, and the v1 -> v2 IndexedDB migration.
export async function runLibraryChecks({ page, idle }) {
  const pill = page.locator('#save-state');
  await pill.filter({ hasText: '已儲存' }).waitFor();
  assert.match(await pill.getAttribute('class'), /\bok\b/, 'a saved project reads as saved');

  const count = () => page.evaluate(async () => (await (await import('./studio/web/storage.mjs')).listProjectSummaries()).length);
  const before = await count();
  assert.ok(before >= 2, 'the fixture flow has saved several projects by now');
  await page.evaluate(() => {
    window.libraryZip = null;
    const original = URL.createObjectURL;
    URL.createObjectURL = blob => { if (blob.type === 'application/zip') window.libraryZip = blob; return original(blob); };
  });
  await page.locator('#export-all').click();
  await page.waitForFunction(() => window.libraryZip !== null); await idle();
  const listing = await page.evaluate(async () => {
    const { unzipFiles } = await import('./studio/web/backup-zip.mjs');
    const entries = await unzipFiles(await window.libraryZip.arrayBuffer());
    return entries.map(entry => { const project = JSON.parse(new TextDecoder().decode(entry.data)); return { name: entry.name, id: project.id, schema: project.schema }; });
  });
  assert.equal(listing.length, before, 'every stored project is in the backup');
  assert.ok(listing.every(entry => entry.name.startsWith('projects/') && entry.name.endsWith('.json') && entry.id && entry.schema));
  assert.equal(new Set(listing.map(entry => entry.id)).size, before);

  await page.evaluate(() => {
    const input = document.querySelector('#restore-project');
    const transfer = new DataTransfer();
    transfer.items.add(new File([window.libraryZip], 'library.zip', { type: 'application/zip' }));
    input.files = transfer.files; input.dispatchEvent(new Event('change'));
  });
  await page.locator('#message').filter({ hasText: `已從 ZIP 匯入 ${before} 個專案` }).waitFor(); await idle();
  assert.equal(await count(), before * 2, 'restore adds every project as a new project, overwriting none');
  assert.equal(await page.locator('.review-log').count(), 0, 'restored reviews become history; none is current');
}

// A database written by the v1 schema (projects only) must open under v2 with
// its list records derived from what is stored. Runs in a fresh context whose
// page never boots the app, so the v1 database is really the one upgraded.
export async function runLibraryMigrationCheck({ browser, base }) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${base}/build.json`);
    const result = await page.evaluate(async () => {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('mml-studio-web-v1', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('projects', { keyPath: 'id' });
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('projects', 'readwrite');
          tx.objectStore('projects').put({ id: 'v1-old', title: 'Stored by v1 (older)', savedAt: '2026-01-01T00:00:00.000Z', revision: 3, saveToken: 'a', payload: 'x'.repeat(4096) });
          tx.objectStore('projects').put({ id: 'v1-new', title: 'Stored by v1 (newer)', savedAt: '2026-02-01T00:00:00.000Z', revision: 1, saveToken: 'b' });
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      });
      const storage = await import('./studio/web/storage.mjs');
      const summaries = await storage.listProjectSummaries();
      const full = await storage.loadProject('v1-old');
      const saved = await storage.saveProject({ ...full, title: 'Renamed after migration' });
      return { summaries, fullPayload: full.payload.length, afterSave: await storage.listProjectSummaries(), savedToken: saved.saveToken !== 'a' };
    });
    assert.deepEqual(result.summaries, [
      { id: 'v1-new', title: 'Stored by v1 (newer)', savedAt: '2026-02-01T00:00:00.000Z', revision: 1 },
      { id: 'v1-old', title: 'Stored by v1 (older)', savedAt: '2026-01-01T00:00:00.000Z', revision: 3 },
    ], 'v1 projects are listed after the upgrade, newest first, without their payloads');
    assert.equal(result.fullPayload, 4096, 'the full workspace is untouched by the migration');
    assert.equal(result.afterSave[0].title, 'Renamed after migration', 'a save updates the list record in the same transaction');
    assert.equal(result.savedToken, true);
  } finally { await context.close(); }
}
