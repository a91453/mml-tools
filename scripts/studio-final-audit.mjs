// Audit an existing song using a private snapshot. No confirmations, profile,
// role decisions, source repair or audio evidence are fabricated by this tool.
import { cp, mkdir, open, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { ingestMIDI } from '../studio/backend/source/index.mjs';
import { LOCAL_AGENT_OWNER } from './studio-agent.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (parent, child) => { const path = relative(parent, child); return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)); };
async function inventory(directory, prefix = '') {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw Error('Song audit refuses linked store entries.');
    const path = join(directory, entry.name), name = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await inventory(path, name + '/'));
    else result.push({ path: name, sha256: hash(await readFile(path)) });
  }
  return result;
}

export async function auditStoredRun({ dataDirectory, projectId, runId, outputDirectory, owner = LOCAL_AGENT_OWNER }) {
  const source = await realpath(dataDirectory), output = resolve(outputDirectory);
  // Resolve the output parent too: a junction must not turn the snapshot into
  // a write to the source store. The audit never overwrites an existing output.
  const parent = await realpath(dirname(output));
  const destination = join(parent, basename(output));
  if (within(source, destination) || within(destination, source)) throw Error('Output must be separate from the source data directory.');
  const lockPath = join(source, '.agent.lock');
  const lock = await open(lockPath, 'wx');
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, purpose: 'read-only song audit snapshot' }));
    const original = await inventory(join(source, 'store'));
    await mkdir(destination); // exclusive destination: no stale PASS or MML
    await cp(join(source, 'store'), join(destination, 'store'), { recursive: true, errorOnExist: true, force: false });
    const copied = await inventory(join(destination, 'store'));
    if (JSON.stringify(original) !== JSON.stringify(copied)) throw Error('Snapshot does not match the source store.');
    const app = createStudioApplication({ dataDirectory: join(destination, 'store'), durability: 'persistent' });
    const save = (name, value) => writeFile(join(destination, name), JSON.stringify(value, null, 2) + '\n');
    const initial = await app.getRun(owner, projectId, runId);
    if (!initial.run?.candidate_id) throw Error('Run has no candidate to audit.');
    if (initial.staleness?.length) throw Error('Run inputs are stale; refresh the run before auditing its Final candidate.');
    const project = (await app.getProject(owner, projectId)).project;
    const candidateId = initial.run.candidate_id;
    const sourceReports = [];
    for (const asset of project.assets) {
      const { bytes } = app.readAssetBytes(owner, projectId, asset.asset_id); // verifies stored identity
      const report = { asset_id: asset.asset_id, filename: asset.filename, kind: asset.kind, sha256: hash(bytes), bytes: bytes.length };
      if (['official_midi', 'third_party_midi'].includes(asset.kind)) {
        const fragment = ingestMIDI(bytes, { sourceId: `midi:sha256:${asset.sha256}`, sha256: asset.sha256,
          kind: asset.kind === 'official_midi' ? 'official-midi' : 'third-party-midi', authority: asset.kind === 'official_midi' ? 'primary-symbolic' : 'supporting' });
        Object.assign(report, { parsed_notes: fragment.events.length, complete: fragment.complete, unsupported: fragment.unsupported,
          tempo: fragment.tempoEvents, meter: fragment.meterEvents,
          orphan_diagnostics: fragment.unsupported.filter(entry => entry.code === 'ORPHAN_NOTE_OFF').map(entry => ({
            ...entry,
            positive_note_ons_on_channel: fragment.raw.tracks.flatMap(track => track.events).filter(event => event.channel === entry.channel && event.messageType === 'noteOn' && event.velocity > 0).length,
            nearby_events: fragment.raw.tracks[entry.trackIndex].events.filter(event => Math.abs(event.tick - entry.tick) <= 480),
          })) });
      }
      sourceReports.push(report);
    }
    await save('source-diagnostics.json', sourceReports);
    const events = [];
    for (let offset = 0;; offset += 100) {
      const page = await app.listBaselineEvents(owner, projectId, { offset, limit: 100 });
      events.push(...page.events); if (page.events.length < 100) break;
    }
    await save('baseline-events.json', events);
    const reduction = await app.planFinalReduction(owner, projectId, { candidateId });
    const reviewed = await app.reviewCandidate(owner, projectId, { candidateId });
    const finalized = await app.finalize(owner, projectId, { candidateId });
    await save('run-before.json', initial); await save('reduction.json', reduction);
    await save('review.json', reviewed); await save('finalize.json', finalized);
    let technical = null, artifact = null;
    if (finalized.artifact_id) {
      artifact = (await app.getArtifact(owner, finalized.artifact_id)).artifact;
      if (artifact.type !== 'final_mml' || artifact.candidate_id !== candidateId || !artifact.mml) throw Error('Final artifact binding is invalid.');
      technical = await app.validateTechnicalMml({ mml: artifact.mml, meter_text: artifact.final_bar.meter_text });
      await save('artifact.json', artifact); await save('technical-readback.json', technical);
      if (technical.technical_ok && artifact.round_trip?.status === 'PASS') await writeFile(join(destination, 'candidate-final.mml'), artifact.mml);
    }
    const unchanged = JSON.stringify(original) === JSON.stringify(await inventory(join(source, 'store')));
    if (!unchanged) throw Error('Source store changed during the audit; do not use this snapshot as current evidence.');
    const summary = {
      schema: 'mml-studio/stored-final-audit@1', audited_at: new Date().toISOString(), canonical: reviewed.canonical,
      status: finalized.operation === 'succeeded' && technical?.technical_ok && artifact?.round_trip?.status === 'PASS' ? 'FINAL_ARTIFACT_VERIFIED' : 'FINAL_NOT_VERIFIED',
      scope: 'Existing evidence only, copied store; no review decisions added. A Final artifact is not listening or in-game acceptance.',
      project_id: projectId, run_id: runId, revision: initial.run.revision, state: initial.run.state, halt: initial.run.halt,
      candidate_id: candidateId, run_staleness: initial.staleness, source_store_unchanged: unchanged,
      source_store_file_count: original.length, source_store_inventory_sha256: hash(JSON.stringify(original)),
      assets: sourceReports.map(({ tempo, meter, orphan_diagnostics, ...entry }) => entry),
      baseline_event_count: events.length, unassigned_baseline_events: events.filter(event => event.role == null).length,
      gates: reviewed.review.gates, readiness_blockers: finalized.blockers, finalization_operation: finalized.operation,
      finalization_code: finalized.code ?? null, final_artifact_id: finalized.artifact_id, mml_written: Boolean(technical?.technical_ok && artifact?.round_trip?.status === 'PASS'),
      report_sha256: Object.fromEntries(await Promise.all(['source-diagnostics.json', 'baseline-events.json', 'reduction.json', 'review.json', 'finalize.json'].map(async name => [name, hash(await readFile(join(destination, name)))]))),
    };
    await save('verification.json', summary);
    return summary;
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, 'project-id': { type: 'string' }, 'run-id': { type: 'string' }, out: { type: 'string' }, owner: { type: 'string' } } });
  for (const key of ['data-dir', 'project-id', 'run-id', 'out']) if (!values[key]) throw Error(`--${key} is required`);
  const result = await auditStoredRun({ dataDirectory: values['data-dir'], projectId: values['project-id'], runId: values['run-id'], outputDirectory: values.out, owner: values.owner });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'FINAL_ARTIFACT_VERIFIED' ? 0 : 2;
}
