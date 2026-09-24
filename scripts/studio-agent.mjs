// Local external-agent adapter. Implementation notes, not Canonical policy.
// Musical operations and input schemas stay in the existing MCP/Application Service.
import { mkdirSync, openSync, closeSync, unlinkSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { mcpCheckSchema } from '../server/mcp.mjs';
import { STUDIO_MCP_TOOLS, runStudioTool } from '../server/mcp-studio.mjs';
import { createRemoteAgentClient } from './studio-agent-remote.mjs';

export const LOCAL_AGENT_OWNER = 'local:external-agent';
const ALLOWED = new Set([
  'studio_capabilities', 'studio_project_create', 'studio_project_get',
  'studio_baseline_events', 'studio_arrangement_suggest',
  'studio_run_plan', 'studio_run_start', 'studio_run_status', 'studio_run_resume',
  'studio_proposal_targets', 'studio_proposal_submit', 'studio_proposal_status', 'studio_proposal_resolve',
  'studio_final_reduction_plan', 'studio_mobile_adaptation_plan',
  'studio_candidate_review', 'studio_finalize', 'studio_artifact_get',
]);
const HELP = `Local Studio external-agent adapter (no network listener or model call)
  node scripts/studio-agent.mjs --data-dir DIR [--actor agent:codex] tools
  node scripts/studio-agent.mjs --data-dir DIR [--actor agent:codex] call TOOL [--input request.json] [--output response.json]
  node scripts/studio-agent.mjs --data-dir DIR upload --project-id ID --file song.mid --kind third_party_midi
  node scripts/studio-agent.mjs --data-dir DIR report --project-id ID --kind suggestion --out suggestion.json
  node scripts/studio-agent.mjs --data-dir DIR report --project-id ID --candidate-id ID --kind reduction|review --out report.json
  node scripts/studio-agent.mjs --data-dir DIR export --project-id ID --run-id ID --out song.mml

Use an isolated local directory. Commands serialize with an exclusive directory lock.
Add --service-url https://SERVICE_ORIGIN to use existing remote HTTP/MCP instead of a local store.
The OAuth access token is read from --token-env NAME (default MML_STUDIO_ACCESS_TOKEN), never a CLI token argument.
Remote data-dir holds local receipts only; the remote service owns the project/run and authenticates its owner.
Agent mutations use proposals; this adapter refuses reviewer confirmations, Lead/Core3
approvals, direct decision application and interrupted-step reconciliation. It does
not authenticate an actor or infer user authorization. Supply only authorized actions.
Dispatched results, including refusals, are saved in DIR/receipts. Run state lives in DIR/store.
An operation returning successfully is not song acceptance. Inspect run.state and gates.
`;

function refuse(message, details = null) {
  const error = new Error(message);
  error.code = 'AGENT_INPUT_REFUSED';
  error.details = details;
  throw error;
}

export function checkAgentCall(name, args, actor) {
  if (!ALLOWED.has(name)) refuse(`Tool ${name} is outside this agent adapter. Use the existing reviewer interface for human evidence.`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) refuse('Tool input must be a JSON object.');
  if (Object.hasOwn(args, 'confirmations')) refuse('Confirmations require reviewer evidence; an agent may not supply them through another path.');
  if (name.startsWith('studio_run_')) {
    for (const key of ['decisions', 'accepted_by', 'final_reduction', 'mobile_adaptation', 'reconcile', 'adopt_artifact_id', 'adopt_candidate_id']) {
      if (Object.hasOwn(args, key)) refuse(`Run field ${key} requires a proposal or reviewer inspection; it is not an agent resume shortcut.`);
    }
  }
  if (name === 'studio_proposal_submit' && args.proposed_by !== actor) refuse(`proposed_by must explicitly name ${actor}.`);
  if (name === 'studio_proposal_resolve' && args.resolution === 'accept' && args.accepted_by !== actor) refuse(`accepted_by must explicitly name ${actor}; never impersonate a human reviewer.`);
  if (Object.hasOwn(args, 'accepted_by') && args.accepted_by !== actor) refuse(`accepted_by must name ${actor}.`);
}

// Same MCP input checker and dispatcher, without the network transport's views:
// no 512 KiB response cap and no long-list compaction (`compact: false`). A real
// 1,545-note MIDI exceeded that cap even on suggestion/finalize. A local result,
// its `--output` file and its receipt therefore hold the full Application
// Service result, without widening MCP. A remote `call` is the MCP response
// itself, long lists summarized (`response_compaction`); remote `report` and
// `export` reassemble full reads through report_page (studio-agent-remote.mjs).
export async function callAgentTool(application, name, args, actor, remote = null) {
  checkAgentCall(name, args, actor);
  const tool = STUDIO_MCP_TOOLS.find(tool => tool.name === name);
  if (!tool) return { error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } };
  try { mcpCheckSchema(tool.inputSchema, args); }
  catch (error) { return { error: { code: -32602, message: error.message } }; }
  try { return remote ? await remote.call(name, args) : await runStudioTool(name, args, { application, owner: LOCAL_AGENT_OWNER, compact: false }); }
  catch (error) {
    return { error: error?.name === 'StudioApplicationError'
      ? { code: error.code, message: error.message, details: error.details }
      : remote && String(error.code ?? '').startsWith('REMOTE_')
        ? { code: error.code, message: error.message, details: error.details ?? null }
        : { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' },
    canonical: application ? await application.canonical.provenance().catch(() => null) : null };
  }
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.length > 0;

// Write the delivered Final MML of one completed, unchanged run. `read` returns
// the whole result of a read-only tool: uncompacted in-process locally,
// reassembled through report_page remotely.
//
// Fails closed. Every field the decision reads must have exactly the shape a
// whole read gives it, and anything else refuses. A read carrying
// `response_compaction` is a bounded MCP view, not the result itself; in such
// a view a long list is a {compacted: true, ...} summary object whose `.length`
// is undefined, so a truthiness test on it let the Final of a run bound to
// changed inputs be written. `staleness` must therefore be an actual, empty
// array, and the artifact must be the one the run names, for its candidate.
async function exportRunFinal(read, { project_id, run_id, out }) {
  const status = await read('studio_run_status', { project_id, run_id });
  const { run, staleness, staleness_notice, canonical } = isRecord(status) ? status : {};
  const evidence = { run_id, staleness, staleness_notice, canonical };
  if (!isRecord(status) || status.response_compaction !== undefined || !isRecord(run) || run.run_id !== run_id || !Array.isArray(staleness)) {
    refuse(`Run ${run_id} status was not read whole (its run or staleness list is missing or compacted). A Final is never exported from a partial read; re-read the run status in full.`,
      { ...evidence, ...(status?.response_compaction !== undefined ? { response_compaction: status.response_compaction } : {}) });
  }
  if (run.state !== 'completed' || !isText(run.final_artifact_id)) refuse(`Run ${run_id} is ${run.state}; no completed Final artifact to export.`);
  if (staleness.length !== 0) refuse(
    `Run ${run_id} is bound to changed inputs (${staleness.map(entry => entry?.code).join(', ')}). Re-read the run and resolve its bindings before exporting.`,
    evidence,
  );
  const final = await read('studio_artifact_get', { artifact_id: run.final_artifact_id });
  const artifact = isRecord(final) && final.response_compaction === undefined ? final.artifact : null;
  if (!isRecord(artifact) || artifact.artifact_id !== run.final_artifact_id || artifact.type !== 'final_mml'
    || !isText(run.candidate_id) || artifact.candidate_id !== run.candidate_id || !isText(artifact.mml)) {
    refuse('Final artifact was not read whole, is not the Final this run names for its candidate, or contains no delivered MML.');
  }
  writeFileSync(out, artifact.mml, { encoding: 'utf8', flag: 'wx' });
  return { output: out, run_id, artifact, staleness, staleness_notice, canonical };
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    'data-dir': { type: 'string' }, actor: { type: 'string', default: 'agent:external' },
    input: { type: 'string' }, output: { type: 'string' }, file: { type: 'string' },
    kind: { type: 'string' }, 'project-id': { type: 'string' }, 'run-id': { type: 'string' }, 'candidate-id': { type: 'string' },
    out: { type: 'string' }, help: { type: 'boolean' },
    'service-url': { type: 'string' }, 'token-env': { type: 'string', default: 'MML_STUDIO_ACCESS_TOKEN' },
  } });
  if (values.help || !positionals.length) { process.stdout.write(HELP); return 0; }
  if (!values['data-dir']) refuse('--data-dir is required; choose an isolated local test directory.');
  if (!/^agent:[\w.:-]{1,100}$/.test(values.actor)) refuse('--actor must be an agent identity, for example agent:codex.');
  const directory = resolve(values['data-dir']);
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, '.agent.lock');
  let descriptor;
  try { descriptor = openSync(lock, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    refuse(`Another command or an interrupted process owns ${lock}. Inspect the process and stored run before manually removing this lock.`);
  }
  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, actor: values.actor, at: new Date().toISOString() }));
    const remote = values['service-url'] ? createRemoteAgentClient({ origin: values['service-url'], token: process.env[values['token-env']] }) : null;
    const application = remote ? null : createStudioApplication({ dataDirectory: join(directory, 'store'), durability: 'persistent' });
    const call = (tool, args) => callAgentTool(application, tool, args, values.actor, remote);
    const read = async (tool, args) => {
      if (remote) return remote.read(tool, args, call);
      const result = await call(tool, args);
      if (result.error) throw Object.assign(new Error(result.error.message), { remoteResult: result });
      return result;
    };
    const [command, name] = positionals;
    let input = null;
    let result;
    try {
      if (command === 'tools') {
        const tools = remote ? await remote.list() : STUDIO_MCP_TOOLS;
        result = { owner: remote ? null : LOCAL_AGENT_OWNER, actor: values.actor, notice: HELP, tools: tools.filter(tool => ALLOWED.has(tool.name)) };
      } else if (command === 'call') {
        input = values.input ? JSON.parse(readFileSync(values.input, 'utf8').replace(/^\uFEFF/, '')) : {};
        result = await call(name, input);
      } else if (command === 'upload') {
        if (!values.file || !values.kind || !values['project-id']) refuse('upload requires --file, --kind and --project-id. Source authority must be stated explicitly.');
        input = { project_id: values['project-id'], filename: basename(values.file), kind: values.kind };
        const upload = {
          kind: input.kind, filename: input.filename, bytes: readFileSync(values.file),
          mediaType: /\.midi?$/i.test(values.file) ? 'audio/midi' : 'application/octet-stream',
        };
        result = remote ? await remote.upload(input.project_id, upload) : await application.uploadAsset(LOCAL_AGENT_OWNER, input.project_id, upload);
      } else if (command === 'report') {
        // Full-song suggestions can exceed MCP's response bound. File output
        // uses the existing service and leaves the network limit unchanged.
        if (!['suggestion', 'reduction', 'review'].includes(values.kind) || !values['project-id'] || !values.out) refuse('report requires --kind suggestion|reduction|review, --project-id and --out.');
        if (values.kind !== 'suggestion' && !values['candidate-id']) refuse('A reduction/review report requires --candidate-id.');
        input = { project_id: values['project-id'], candidate_id: values['candidate-id'] ?? null, kind: values.kind, out: resolve(values.out) };
        const report = remote ? await read({ suggestion: 'studio_arrangement_suggest', reduction: 'studio_final_reduction_plan', review: 'studio_candidate_review' }[values.kind], {
          project_id: input.project_id, ...(input.candidate_id ? { candidate_id: input.candidate_id } : {}),
        }) : values.kind === 'suggestion'
          ? await application.suggestArrangement(LOCAL_AGENT_OWNER, input.project_id)
          : values.kind === 'reduction'
            ? await application.planFinalReduction(LOCAL_AGENT_OWNER, input.project_id, { candidateId: input.candidate_id })
            : await application.reviewCandidate(LOCAL_AGENT_OWNER, input.project_id, { candidateId: input.candidate_id });
        writeFileSync(input.out, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
        const notice = {
          suggestion: 'Suggestion reports contain proposals, not accepted decisions.',
          reduction: 'Reduction reports preview the plan without applying its decisions.',
          review: 'Review recomputes the report, writes no store artifact and records no confirmation. Preserve the local report file and receipt for the audit trail.',
        }[values.kind];
        result = { output: input.out, kind: values.kind, operation: report.operation, baseline_id: report.suggestion?.baseline_id,
          lane_count: report.suggestion?.lane_count, pending_lane_count: report.suggestion?.pending.count,
          notice: `Full Application Service report saved locally. No report rows were discarded; read the file in bounded sections. No run is advanced. ${notice}` };
      } else if (command === 'export') {
        if (!values['project-id'] || !values['run-id'] || !values.out) refuse('export requires --project-id, --run-id and --out.');
        input = { project_id: values['project-id'], run_id: values['run-id'], out: resolve(values.out) };
        result = await exportRunFinal(read, input);
      } else refuse(`Unknown command: ${command}`);
    } catch (error) {
      result = error.remoteResult ?? { error: { code: error.code ?? 'LOCAL_ERROR', message: error.message, details: error.details ?? null } };
    }
    const receipt = { at: new Date().toISOString(), actor: values.actor, owner: remote ? null : LOCAL_AGENT_OWNER,
      ...(remote ? { service_origin: remote.origin, owner_notice: 'Authenticated by the remote service; actor is caller-supplied audit text, not the authenticated owner.' } : {}),
      command, tool: name ?? null, input, result };
    mkdirSync(join(directory, 'receipts'), { recursive: true });
    writeFileSync(join(directory, 'receipts', `${Date.now()}-${randomUUID()}.json`), JSON.stringify(receipt, null, 2) + '\n');
    const output = JSON.stringify(result, null, 2) + '\n';
    if (values.output) writeFileSync(values.output, output, 'utf8');
    process.stdout.write(output);
    return result.error ? 1 : 0;
  } finally {
    closeSync(descriptor);
    unlinkSync(lock);
  }
}

// The entry module is compared by real path on both sides: Node takes
// import.meta.url from the entry's real path (or from the link itself under
// --preserve-symlinks-main), while argv[1] is the path the caller typed, so a
// script started through a symlink would otherwise do nothing and exit 0.
const invokedAsScript = (() => {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invokedAsScript) {
  try { process.exitCode = await main(); }
  catch (error) { process.stderr.write(JSON.stringify({ error: { code: error.code ?? 'LOCAL_ERROR', message: error.message } }) + '\n'); process.exitCode = 1; }
}
