// Opt-in external-agent continuation. It drives the existing MCP protocol and
// never edits a song store, accepts a gate, or supplies reviewer evidence.
import { createHash } from 'node:crypto';
import { createStore } from '../studio/backend/application/store.mjs';
import { StudioApplicationError } from '../studio/backend/application/index.mjs';
import { STUDIO_MCP_TOOLS, runStudioTool } from './mcp-studio.mjs';
import { mcpCheckSchema } from './mcp.mjs';

export const AGENT_ACTOR = 'agent:codex-dispatch';
const names = new Set(['studio_project_get', 'studio_baseline_events', 'studio_arrangement_suggest', 'studio_proposal_targets',
  'studio_proposal_status', 'studio_proposal_submit', 'studio_proposal_resolve', 'studio_run_resume',
  'studio_final_reduction_plan', 'studio_mobile_adaptation_plan', 'studio_candidate_review']);
export const AGENT_TOOLS = STUDIO_MCP_TOOLS.filter(t => names.has(t.name));
const invalid = message => { throw new StudioApplicationError('INVALID_REQUEST', message); };
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function checkDispatchAction(action, context) {
  if (!action || typeof action !== 'object' || Array.isArray(action)
      || Object.keys(action).some(k => !['tool', 'arguments_json', 'reason'].includes(k))
      || typeof action.reason !== 'string' || !action.reason.trim() || action.reason.length > 2000) invalid('Invalid agent action');
  if (action.tool === null) return null;
  if (!names.has(action.tool)) invalid('Tool is not permitted for autonomous continuation');
  let args;
  try { args = JSON.parse(action.arguments_json); } catch { invalid('Agent arguments must be JSON'); }
  mcpCheckSchema(AGENT_TOOLS.find(t => t.name === action.tool).inputSchema, args);
  if (args.project_id !== context.project_id) invalid('Agent action escaped its project');
  if (args.run_id !== undefined && args.run_id !== context.run_id) invalid('Agent action escaped its run');
  if (args.candidate_id !== undefined && args.candidate_id !== context.candidate_id) invalid('Agent action escaped its candidate');
  for (const key of ['confirmations', 'reconcile', 'decisions', 'accepted_by', 'final_reduction', 'mobile_adaptation', 'adopt_artifact_id', 'adopt_candidate_id']) {
    if (Object.hasOwn(args, key) && !(key === 'accepted_by' && action.tool === 'studio_proposal_resolve')) invalid('Reviewer or direct-apply input is not permitted');
  }
  if (action.tool === 'studio_run_resume' && Object.keys(args).some(k => !['project_id', 'run_id', 'expected_run_revision', 'idempotency_key'].includes(k))) invalid('Only a plain resume is permitted');
  if (action.tool === 'studio_proposal_submit' && args.proposed_by !== AGENT_ACTOR) invalid('Proposal must identify the agent');
  if (action.tool === 'studio_proposal_resolve' && (args.resolution !== 'accept' || args.accepted_by !== AGENT_ACTOR)) invalid('Acceptance must identify the agent');
  return args;
}

export function createAgentDriver({ application, decide = null, directory = null, maxSteps = 12 }) {
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 30) throw Error('Invalid agent step limit');
  const store = createStore({ directory, durability: directory ? 'persistent' : 'ephemeral', maxBytes: 16 * 1024 * 1024 });
  const active = new Map();
  const keyOf = (owner, projectId, runId) => `agent:${fingerprint([owner, projectId, runId])}`;
  const write = (key, task) => { task.updated_at = new Date().toISOString(); store.putJson(key, task); };
  const get = key => {
    const task = store.getJson(key);
    if (task?.state === 'running' && !active.has(key)) return { ...task, state: 'interrupted', reason: 'Agent host stopped. Read the run and proposals before explicitly restarting.' };
    return task;
  };
  async function drive(owner, projectId, runId, key, task, signal) {
    let lastResult = null;
    const seen = new Set();
    try {
      for (let i = 0; i < maxSteps; i++) {
        if (signal.aborted) { task.state = 'stopped'; return; }
        const status = await application.getRun(owner, projectId, runId);
        task.observed_revision = status.run.revision;
        if (status.staleness?.length || status.run.pending_step || status.run.needs_reconciliation || ['failed', 'interrupted'].includes(status.run.state)) {
          task.state = 'needs_attention'; task.reason = 'Run is stale, failed or requires reconciliation'; return;
        }
        if (status.run.state === 'completed') { task.state = 'completed'; task.reason = 'Run delivered a Final artifact; listening and in-game acceptance remain separate.'; return; }
        const targets = await application.proposalTargets(owner, projectId, runId);
        const { rules } = await application.canonical.engines();
        const context = { project_id: projectId, run_id: runId, candidate_id: status.run.candidate_id,
          actor: AGENT_ACTOR, run: status, targets, tools: AGENT_TOOLS,
          rules: rules.PUBLISHED_CANONICAL?.documents ?? null,
          authorized_proposal_ids: task.proposal_ids, previous: lastResult };
        const action = await decide(context, { signal });
        if (signal.aborted) { task.state = 'stopped'; return; }
        const args = checkDispatchAction(action, context);
        if (!args) { task.state = 'waiting_review'; task.reason = action.reason; return; }
        const current = await application.getRun(owner, projectId, runId);
        if (current.run.revision !== status.run.revision || current.staleness?.length) { task.state = 'needs_attention'; task.reason = 'Run changed while the agent was deciding; read it again before continuing.'; return; }
        const signature = fingerprint([status.run.revision, action.tool, args]);
        if (seen.has(signature)) { task.state = 'waiting_review'; task.reason = 'Agent repeated an action without new evidence.'; return; }
        seen.add(signature);
        if (args.proposal_id) {
          const { proposal } = await application.getProposal(owner, projectId, args.proposal_id);
          if (proposal.run_id !== runId) invalid('Proposal belongs to another run');
          if (action.tool === 'studio_proposal_resolve' && (!task.proposal_ids.includes(args.proposal_id)
              || proposal.proposed_by !== AGENT_ACTOR || proposal.state !== 'submitted'
              || proposal.agent_review?.acceptable !== true)) invalid('Proposal has not been authorized for agent acceptance');
        }
        // Persist intent before mutation. Restart never retries an uncertain action.
        task.pending_action = { tool: action.tool, fingerprint: signature, revision: status.run.revision };
        write(key, task);
        lastResult = await runStudioTool(action.tool, args, { application, owner });
        if (action.tool === 'studio_proposal_submit' && lastResult.proposal?.proposal_id) task.proposal_ids.push(lastResult.proposal.proposal_id);
        task.steps++; task.pending_action = null; write(key, task);
        if (lastResult.error || lastResult.operation === 'blocked' || lastResult.operation === 'failed') {
          task.state = 'needs_attention'; task.reason = 'The existing service refused the action. Inspect the run and proposal.'; return;
        }
      }
      task.state = 'step_limit'; task.reason = `Stopped at the ${maxSteps}-step bound. Inspect progress before continuing.`;
    } catch (error) {
      task.state = signal.aborted ? 'stopped' : 'needs_attention';
      // Do not persist provider stderr, paths, credentials or arbitrary exception text.
      task.reason = signal.aborted ? 'Stopped by operator' : 'Agent execution failed or its action was refused. No automatic retry.';
      task.error_code = error instanceof StudioApplicationError ? error.code : 'AGENT_EXECUTION_FAILED';
    } finally { write(key, task); active.delete(key); }
  }
  return {
    enabled: Boolean(decide),
    async status(owner, projectId, runId) {
      await application.getRun(owner, projectId, runId); // authorization before task lookup
      return { enabled: Boolean(decide), actor: AGENT_ACTOR, task: get(keyOf(owner, projectId, runId)) };
    },
    async start(owner, projectId, runId, input) {
      if (!decide) invalid('No agent runner is configured on this host');
      if (!input || Object.keys(input).some(k => !['expected_run_revision', 'idempotency_key', 'authorization'].includes(k))
          || input.authorization !== 'reversible-proposals' || !Number.isSafeInteger(input.expected_run_revision)
          || typeof input.idempotency_key !== 'string' || !/^[\w:-]{1,120}$/.test(input.idempotency_key)) invalid('Explicit run-bound agent authorization is required');
      const status = await application.getRun(owner, projectId, runId);
      const key = keyOf(owner, projectId, runId), old = get(key);
      if (old?.idempotency_key === input.idempotency_key) {
        if (old.authorized_revision !== input.expected_run_revision) invalid('Idempotency key input changed');
        return { enabled: true, task: old, replayed: true };
      }
      if (active.has(key)) return { enabled: true, task: old, replayed: true };
      if (active.size >= 2) invalid('Agent host is busy; at most two runs may execute concurrently');
      if (old?.pending_action) invalid('An action result is uncertain; inspect and reconcile it before another dispatch');
      if (status.run.revision !== input.expected_run_revision || status.staleness?.length || status.run.pending_step || status.run.needs_reconciliation) invalid('Read the current run before dispatching');
      const task = { state: 'running', idempotency_key: input.idempotency_key, authorized_revision: input.expected_run_revision,
        authorization: input.authorization, observed_revision: status.run.revision, project_id: projectId, run_id: runId,
        actor: AGENT_ACTOR, proposal_ids: old?.proposal_ids ?? [], steps: 0, pending_action: null, reason: 'Agent started' };
      const abort = new AbortController(); active.set(key, { abort }); write(key, task);
      const promise = drive(owner, projectId, runId, key, task, abort.signal).catch(() => { active.delete(key); });
      active.get(key).promise = promise;
      return { enabled: true, task: structuredClone(task), replayed: false };
    },
    async stop(owner, projectId, runId) {
      await application.getRun(owner, projectId, runId);
      active.get(keyOf(owner, projectId, runId))?.abort.abort();
      return this.status(owner, projectId, runId);
    },
    // Operator-only administrative acknowledgement. Never offered to the model.
    // Clears no musical gate and performs/replays no Studio operation.
    async reconcile(owner, projectId, runId, input) {
      const current = await application.getRun(owner, projectId, runId);
      const key = keyOf(owner, projectId, runId), task = get(key);
      if (!input || Object.keys(input).some(k => !['pending_action_fingerprint', 'expected_run_revision', 'reason', 'inspected'].includes(k))
          || input.inspected !== true || typeof input.reason !== 'string' || input.reason.trim().length < 10 || input.reason.length > 1000) invalid('Record the inspected run/proposal outcome before clearing the agent interruption');
      if (active.has(key) || !task?.pending_action || task.pending_action.fingerprint !== input.pending_action_fingerprint
          || current.run.revision !== input.expected_run_revision || current.run.pending_step || current.run.needs_reconciliation || current.staleness?.length) invalid('Interruption or run changed; inspect the current records');
      task.reconciliation = { owner, at: new Date().toISOString(), action: task.pending_action, reason: input.reason.trim(), run_revision: current.run.revision };
      task.pending_action = null; task.state = 'stopped'; task.reason = 'Operator inspected the uncertain action. Explicit dispatch may now continue.';
      write(key, task); return { enabled: Boolean(decide), task };
    },
    async settled() { await Promise.all([...active.values()].map(a => a.promise)); },
    close() { for (const a of active.values()) a.abort.abort(); },
  };
}
