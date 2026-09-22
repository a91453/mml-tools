// Local, read-only reproduction of a production candidate review.
// Implementation notes, not Canonical policy.
//
// Rebuilds the Source-Faithful Baseline from the private source bytes, re-applies
// the exported accepted decision set, and re-runs the unchanged review engine in
// an ISOLATED throwaway store. Exported reviewer records (confirmations, Lead
// evidence reviews, audio history) may be seeded into that copy so the complete
// report can be compared by SHA-256 with the service's report_page hashes.
//
// This is a verification, not a migration: the throwaway store is never a native
// backup, its project id and owner are local, and nothing here talks to the
// network or writes to any service. Seeded records are data read back from the
// service; this script authors no confirmation, Lead evidence or gate result.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { createStore } from '../studio/backend/application/store.mjs';

const HELP = `Local candidate-review reproduction (no network, no service write)
  node scripts/studio-reproduce-review.mjs --work-dir NEW_DIR --source FILE --source-kind third_party_midi
       --decisions proposal.json [--records DIR] [--canonical canonical.json] [--expect-sha256 HEX] [--out receipt.json]

--decisions   studio_proposal_status output of the applied arrangement_decision proposal
              (or a JSON object with { action: { decisions }, resolution: { accepted_by } }).
--records     directory with review report_page values exported from the service:
              lead_evidence_reviews.json, audio.json, confirmations.json (all optional).
--canonical   the report's exported "canonical" value, to compare the full report hash.
The work directory must not exist. Source bytes and exports stay local; commit only receipts.
`;

const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const OWNER = 'local:reproduction';

export async function reproduceReview({ workDir, source, sourceKind, decisions, records = null, canonical = null }) {
  if (existsSync(workDir)) throw Error(`${workDir} already exists; use a new isolated directory.`);
  mkdirSync(workDir, { recursive: true });
  const dataDirectory = join(workDir, 'store');
  const app = createStudioApplication({ dataDirectory, durability: 'persistent' });
  const { project } = await app.createProject(OWNER, { title: 'isolated reproduction' });
  const bytes = readFileSync(source);
  const upload = await app.uploadAsset(OWNER, project.project_id, { kind: sourceKind, filename: 'source', bytes, mediaType: 'application/octet-stream' });
  const asset = upload.asset ?? upload;
  const intake = await app.analyzeSources(OWNER, project.project_id, { assetIds: [asset.asset_id], meterText: '' });
  await app.suggestArrangement(OWNER, project.project_id, {});
  const proposal = decisions.proposal ?? decisions;
  const applied = await app.applyDecisions(OWNER, project.project_id, {
    decisions: proposal.action.decisions, acceptedBy: proposal.resolution?.accepted_by ?? null,
  });
  const candidateId = applied.decisions?.candidate_id ?? null;
  if (!candidateId) throw Error(`Decision application did not produce a candidate: ${JSON.stringify(applied.decisions ?? applied).slice(0, 500)}`);

  const seeded = [];
  if (records) {
    const store = createStore({ directory: dataDirectory, durability: 'persistent' });
    const record = store.readProjectRecord(project.project_id);
    const baselineId = record.baseline.baseline_id;
    const file = name => (existsSync(join(records, name)) ? readJson(join(records, name)) : null);
    const lead = file('lead_evidence_reviews.json');
    if (lead) {
      store.putJson(`lead-evidence-reviews:${project.project_id}:${candidateId}`, lead.map(entry => ({
        event_id: entry.eventId, axis: entry.axis, lead_evidence: entry.leadEvidence, lead_context_digest: entry.leadContextDigest,
        reason: entry.reason, evidence: entry.evidence, origin_event_id: entry.originEventId,
        supersede_reason: entry.supersedeReason, at: entry.at, baseline_id: baselineId, candidate_id: candidateId,
      })));
      seeded.push(`lead_evidence_reviews:${lead.length}`);
    }
    const audio = file('audio.json');
    if (audio) { store.putJson(`audio:${project.project_id}:${candidateId}`, audio.history); seeded.push(`audio_history:${audio.history.entries.length}`); }
    const confirmations = file('confirmations.json');
    store.writeProjectRecord({ ...record, confirmations: confirmations ?? record.confirmations ?? {}, audio_evidence: audio?.evidence ?? record.audio_evidence ?? [] });
    if (confirmations) seeded.push(`confirmations:${Object.keys(confirmations).join(',')}`);
  }

  const result = await app.reviewCandidate(OWNER, project.project_id, { candidateId });
  const sections = Object.fromEntries(Object.entries(result.review).map(([key, value]) => {
    const text = JSON.stringify(value);
    return [key, { value_sha256: sha(text), utf16_units: text?.length ?? 0 }];
  }));
  const full = canonical ? JSON.stringify({ canonical, operation: result.operation, review: result.review }) : null;
  return {
    schema: 'mml-studio/local-review-reproduction@1',
    notice: 'Isolated local reproduction. Not a native store backup, not a gate result, not reviewer evidence.',
    source_sha256: createHash('sha256').update(bytes).digest('hex'),
    baseline_id: intake.baseline?.baseline_id ?? null,
    baseline_event_count: intake.baseline?.event_count ?? null,
    source_identity_digest: intake.baseline?.source_identity_digest ?? null,
    event_id_digest: intake.baseline?.event_id_digest ?? null,
    candidate_id: candidateId,
    decision_count: proposal.action.decisions.length,
    seeded_records: seeded,
    sections,
    full_report: full ? { report_sha256: sha(full), utf16_units: full.length } : null,
    blockers: result.review.blockers,
  };
}

async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    'work-dir': { type: 'string' }, source: { type: 'string' }, 'source-kind': { type: 'string', default: 'third_party_midi' },
    decisions: { type: 'string' }, records: { type: 'string' }, canonical: { type: 'string' },
    'expect-sha256': { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help || !values['work-dir'] || !values.source || !values.decisions) { process.stdout.write(HELP); return values.help ? 0 : 1; }
  const receipt = await reproduceReview({
    workDir: resolve(values['work-dir']), source: resolve(values.source), sourceKind: values['source-kind'],
    decisions: readJson(resolve(values.decisions)), records: values.records ? resolve(values.records) : null,
    canonical: values.canonical ? readJson(resolve(values.canonical)) : null,
  });
  if (values['expect-sha256']) receipt.full_report_matches_expected = receipt.full_report?.report_sha256 === values['expect-sha256'];
  const text = JSON.stringify(receipt, null, 2) + '\n';
  if (values.out) writeFileSync(resolve(values.out), text, { flag: 'wx' });
  process.stdout.write(text);
  return receipt.full_report_matches_expected === false ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try { process.exitCode = await main(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
