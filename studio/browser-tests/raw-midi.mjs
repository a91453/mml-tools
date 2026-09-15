import assert from 'node:assert/strict';
import * as fixtures from '../tests/fixtures/midi-fixtures.mjs';

// Raw MIDI in a real browser.
//
// The Node suites prove the pipeline and the markup. What only a browser can
// answer is whether a file chosen through a real <input type="file"> arrives as
// bytes, survives a real IndexedDB round trip and a real reload, and whether a
// second choice made while the first is still decoding can ever become the
// source on screen.

const midi = (page, slot, name, bytes) => page.locator(`[data-intake="${slot}"]`)
  .setInputFiles({ name, mimeType: 'audio/midi', buffer: Buffer.from(bytes) });

const sectionText = page => page.locator('#raw-midi').textContent();
const revision = async page => Number((await page.locator('.hero .meta').textContent()).match(/Revision (\d+)/)[1]);

export async function runRawMidiChecks({ page, idle, base, requests, screenshot }) {
  const before = requests.length;

  // ── a real file picker, real bytes ──
  await midi(page, 'candidate', 'six-voices.mid', fixtures.sixSourceVoices());
  await page.locator('#raw-midi').waitFor();
  await idle();

  const text = await sectionText(page);
  assert.ok(text.includes('six-voices.mid'), 'the chosen file is named in the Raw MIDI section');
  assert.ok(text.includes('SMF format'), 'source facts are rendered');
  assert.ok(text.includes('PPQ 360'), 'the division the file actually declares');
  assert.ok(text.includes('G11-B'), 'the decomposition is shown');
  assert.ok(text.includes('Core3 候選'), 'the Core3 candidate is shown');
  assert.ok(text.includes('Full6 加值角色'), 'enrichment is shown separately from Core3');
  assert.ok(text.includes('不是已接受的編排'), 'the candidate is labelled a candidate');
  assert.ok(text.includes('ARRANGEMENT_CANDIDATE'));
  // All six source voices survive to the decomposition.
  for (let index = 1; index <= 6; index++) assert.ok(text.includes(`track:${index}/channel:${index - 1}`), `source voice ${index} must be listed`);

  // The digest on screen is the digest of the bytes the Worker parsed.
  const digest = await page.evaluate(async () => {
    const { listProjects } = await import('./studio/web/storage.mjs');
    const stored = (await listProjects()).find(record => record.assets?.candidate?.format === 'MIDI');
    return stored?.assets.candidate.source.sha256 ?? null;
  });
  assert.ok(/^[a-f0-9]{64}$/.test(digest ?? ''), 'a Raw MIDI source is persisted with its digest');
  assert.ok(text.includes(digest), 'the persisted digest is what is displayed');

  await screenshot('raw-midi');

  // ── byte-exact persistence across a real reload ──
  await page.reload();
  await page.locator('#app h1').waitFor();
  await idle();
  const restored = await page.evaluate(async () => {
    const { listProjects } = await import('./studio/web/storage.mjs');
    const record = (await listProjects()).find(item => item.assets?.candidate?.format === 'MIDI').assets.candidate;
    const binary = atob(record.source.bytesBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    return { bytes: [...bytes], sha256: record.source.sha256, recomputed: hash, byteLength: record.source.byteLength };
  });
  assert.deepEqual(restored.bytes, [...fixtures.sixSourceVoices()], 'the stored bytes are the exact bytes that were chosen');
  assert.equal(restored.recomputed, restored.sha256, 'and the browser recomputes the same digest from them');
  assert.equal(restored.byteLength, fixtures.sixSourceVoices().length);
  assert.ok((await sectionText(page)).includes(restored.sha256), 'the reloaded page re-derives from the same source');

  // ── percussion stays percussion ──
  await midi(page, 'candidate', 'drums.mid', fixtures.percussion());
  await idle();
  const drums = await sectionText(page);
  assert.ok(drums.includes('打擊材料'), 'percussion has its own card');
  assert.ok(drums.includes('36, 38, 42'), 'the drum note numbers are shown as drum selectors');
  assert.ok(drums.includes('不是音高'));
  assert.ok((await page.locator('#gates').textContent()).includes('UNSUPPORTED'), 'unsupported material fails the source gate closed');

  // ── a source replacement is a new revision ──
  const drumRevision = await revision(page);
  await midi(page, 'candidate', 'format1.mid', fixtures.format1());
  await idle();
  assert.ok(await revision(page) > drumRevision, 'replacing the source is a new source revision');
  assert.ok((await sectionText(page)).includes('format1.mid'));

  // ── a late result for a superseded choice never becomes the source ──
  await page.evaluate(() => { window.holdNextAction = 'intakeMidi'; });
  // The Worker request for A is held, so setInputFiles resolves while A is
  // still undecided and no render has replaced the input.
  await midi(page, 'candidate', 'held-a.mid', fixtures.format0());
  await page.waitForFunction(() => typeof window.releaseWorker === 'function');
  // B is chosen while A is still decoding inside the Worker.
  await page.evaluate(bytes => {
    const input = document.querySelector('[data-intake="candidate"]');
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'winner-b.mid', { type: 'audio/midi' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
    window.releaseWorker();
  }, [...fixtures.rationalTiming()]);
  await idle();
  assert.equal(await page.evaluate(() => window.releaseWorker), null, 'the held request was released exactly once');

  const raced = await sectionText(page);
  assert.ok(raced.includes('winner-b.mid'), 'the newest choice is the one on screen');
  assert.ok(!raced.includes('held-a.mid'), 'the superseded choice never became the source');
  assert.ok((await page.locator('#message').textContent()).includes('STALE_SOURCE_REQUEST'), 'the discarded result is marked stale, not dropped silently');
  assert.equal(await page.evaluate(async () => {
    const { listProjects } = await import('./studio/web/storage.mjs');
    return (await listProjects()).find(item => item.assets?.candidate?.format === 'MIDI').assets.candidate.name;
  }), 'winner-b.mid', 'and it was never persisted either');

  // Exact rational timing survived the Worker, IndexedDB and the render.
  assert.deepEqual(await page.evaluate(async () => {
    const { listProjects } = await import('./studio/web/storage.mjs');
    return (await listProjects()).find(item => item.assets?.candidate?.format === 'MIDI').assets.candidate.project.events.map(event => event.start);
  }), ['0', '1/3', '2/3', '1', '13/12', '29/24']);

  // ── malformed MIDI fails visibly and keeps the current source ──
  await midi(page, 'candidate', 'not-really.mid', new TextEncoder().encode('this is not a Standard MIDI File'));
  await idle();
  assert.ok((await page.locator('#message').textContent()).includes('MThd'), 'the parse failure is reported');
  assert.ok((await sectionText(page)).includes('winner-b.mid'), 'a failed intake must not erase the current source');

  // ── the same file can be chosen again after a failure ──
  const beforeRetry = await revision(page);
  await midi(page, 'candidate', 'winner-b.mid', fixtures.rationalTiming());
  await idle();
  assert.ok(await revision(page) > beforeRetry, 'reselecting the same file after a failure is accepted');

  // ── nothing left the browser ──
  const during = requests.slice(before);
  assert.ok(during.every(request => request.method === 'GET' && request.url.startsWith(base)),
    `Raw MIDI processing must issue no upload and no external request; saw ${JSON.stringify(during.filter(r => r.method !== 'GET' || !r.url.startsWith(base)))}`);

  // Leave the workspace on a symbolic candidate so the surrounding flow, which
  // is about MML delivery, continues from where it was.
  return during.length;
}
