import assert from 'node:assert/strict';

// Fault injection controls only the Worker boundary. Every unheld request still
// reaches the real packaged module Worker and its Canonical verification.
export async function installWorkerControls(page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.workerStarts = 0;
    window.workerStops = 0;
    window.holdNextAction = sessionStorage.getItem('auditHoldBoot') === 'yes' ? 'analyzeWorkspace' : null;
    sessionStorage.removeItem('auditHoldBoot');
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args); window.workerStarts++;
        const post = this.postMessage.bind(this);
        // Only Studio's action-shaped requests are held or failed; any other
        // worker (the Workshop's render worker) passes through untouched,
        // transfer list included.
        this.postMessage = (request, transfer) => {
          if (request?.action === undefined) return post(request, transfer);
          if (window.holdNextAction === request.action) {
            window.holdNextAction = null;
            window.releaseWorker = () => { window.releaseWorker = null; post(request); };
          } else if (window.failNextAction === request.action) {
            window.failNextAction = null;
            queueMicrotask(() => this.onerror?.(new Event('error')));
          } else post(request);
        };
      }
      terminate() { window.workerStops++; super.terminate(); }
    };
  });
}

export async function runAuditChecks({ page, idle, file, mml }) {
  // The reload path must drain its waiters without another user action.
  await page.evaluate(() => sessionStorage.setItem('auditHoldBoot', 'yes'));
  await page.reload();
  await page.waitForFunction(() => typeof window.releaseWorker === 'function');
  await page.evaluate(content => {
    for (const [slot, name] of [['baseline', 'boot-baseline.mml'], ['previous', 'boot-previous.mml']]) {
      const input = document.querySelector(`[data-intake="${slot}"]`);
      const transfer = new DataTransfer(); transfer.items.add(new File([content], name, { type: 'text/plain' }));
      input.files = transfer.files; input.dispatchEvent(new Event('change'));
    }
    const form = document.querySelector('#review-form');
    form.elements.note.value = 'stale boot review'; form.elements.evidence.value = 'old revision';
    form.requestSubmit();
    window.releaseWorker();
  }, mml);
  await idle();
  const intakeText = await page.locator('#intake').textContent();
  assert.ok(intakeText.includes('boot-baseline.mml') && intakeText.includes('boot-previous.mml'));
  assert.equal(await page.locator('.review-log').count(), 0, 'boot intake invalidates the queued old-revision review');

  // Two genuine saved projects can have the same revision counter. Seed the
  // second project through the real storage API, then use the project picker.
  const ids = await page.evaluate(async () => {
    const { listProjects, saveProject } = await import('./studio/web/storage.mjs');
    const a = (await listProjects())[0];
    const b = await saveProject({ ...a, id: crypto.randomUUID(), title: 'Project B', saveToken: undefined, reviews: {}, acceptance: null });
    return { a: a.id, b: b.id, revision: a.revision };
  });
  await page.reload(); await idle();
  await page.locator('#projects').selectOption(ids.a); await idle();
  await page.evaluate(() => {
    window.holdNextAction = 'recordReview';
    const form = document.querySelector('#review-form');
    form.elements.name.value = 'source'; form.elements.note.value = 'A source'; form.elements.evidence.value = 'A'; form.requestSubmit();
  });
  await page.waitForFunction(() => typeof window.releaseWorker === 'function');
  await page.evaluate(({ b, content }) => {
    const picker = document.querySelector('#projects'); picker.value = b; picker.dispatchEvent(new Event('change'));
    const form = document.querySelector('#review-form');
    form.elements.name.value = 'lead'; form.elements.note.value = 'A-only evidence'; form.elements.evidence.value = 'A only'; form.requestSubmit();
    const input = document.querySelector('[data-intake="baseline"]');
    const transfer = new DataTransfer(); transfer.items.add(new File([content], 'A-only.mml', { type: 'text/plain' }));
    input.files = transfer.files; input.dispatchEvent(new Event('change'));
    window.releaseWorker();
  }, { b: ids.b, content: mml });
  await idle();
  assert.equal(await page.locator('#app h1').textContent(), 'Project B', 'queued selection must survive A save rerender');
  assert.equal(await page.locator('.review-log').count(), 0, 'evidence for A must not attach to B');
  assert.ok(!(await page.locator('#intake').textContent()).includes('A-only.mml'), 'intake for A must not overwrite B');

  // Multiple Core3 rows chosen from the same visible report retain their IDs.
  await file('candidate', mml.replace('o4c1', 'o4d1').replace('o3e1', 'o3f1').replace('o2c1', 'o2d1'), 'three-changes.mml');
  assert.equal(await page.locator('[data-core3]').count(), 3);
  await page.evaluate(() => {
    window.holdNextAction = 'recordReview';
    const form = document.querySelector('#review-form');
    form.elements.note.value = 'hold source review'; form.elements.evidence.value = 'fixture'; form.requestSubmit();
  });
  await page.waitForFunction(() => typeof window.releaseWorker === 'function');
  const chosen = await page.evaluate(() => {
    const forms = [...document.querySelectorAll('[data-core3]')].slice(0, 2);
    const evidence = forms.map(form => form.querySelector('.meta').textContent);
    forms.forEach((form, i) => { form.elements.reason.value = `selected-row-${i}`; form.elements.evidence.value = evidence[i]; form.requestSubmit(); });
    window.releaseWorker(); return evidence;
  });
  await idle();
  const approvals = await page.evaluate(async b => (await (await import('./studio/web/storage.mjs')).listProjects()).find(w => w.id === b).core3Approvals, ids.b);
  assert.equal(approvals.length, 2);
  approvals.forEach((approval, i) => { assert.ok(chosen[i].includes(approval.eventId)); assert.equal(approval.reason, `selected-row-${i}`); });

  // A real replacement Worker answers after the injected failure. The failed
  // edited revision has neither a persisted timestamp nor a copyable result.
  const starts = await page.evaluate(() => window.workerStarts);
  await page.evaluate(() => { window.failNextAction = 'analyzeWorkspace'; });
  await file('candidate', mml, 'worker-failure.mml');
  assert.ok((await page.locator('#gates').textContent()).includes('ANALYSIS_FAILED'));
  assert.ok((await page.locator('.hero').textContent()).includes('尚未儲存'));
  assert.equal(await page.locator('#copy-mml').isEnabled(), false);
  assert.equal(await page.evaluate(() => window.workerStarts), starts + 1);
  assert.ok(await page.evaluate(() => window.workerStops > 0));
  await file('candidate', mml, 'worker-recovered.mml');
  assert.equal(await page.locator('#copy-mml').isEnabled(), true);

  // IndexedDB rejects a stale save token instead of overwriting the winner.
  assert.equal(await page.evaluate(async b => {
    const { listProjects, saveProject } = await import('./studio/web/storage.mjs');
    const original = (await listProjects()).find(w => w.id === b);
    const winner = await saveProject(original);
    let rejected = false;
    try { await saveProject({ ...original, title: 'stale overwrite' }); } catch { rejected = true; }
    const stored = (await listProjects()).find(w => w.id === b);
    return rejected && stored.saveToken === winner.saveToken && stored.title === original.title;
  }, ids.b), true);
  // Reload the winning token before continuing the normal user flow.
  await page.reload(); await idle();

  await file('candidate', mml.replace('o4c1', 'o8c1'), 'unverified-pitch.mml');
  assert.equal(await page.locator('#copy-mml').isEnabled(), false);
  assert.ok((await page.locator('#gates').textContent()).includes('FAIL'));
  await file('candidate', mml, 'range-recovered.mml');
}
