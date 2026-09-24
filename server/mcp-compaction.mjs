// Bounded MCP responses for long lists, without losing data.
//
// A transport view on an Application Service result, like report paging, and
// applied at the same place: `runStudioTool`, for every MCP call that does not
// ask for a report page. The local agent CLI, which has no result cap and keeps
// whole results in files, opts out with `compact: false`. The Application
// Service result, every stored run, candidate and artifact, and the HTTP
// responses are unchanged; a report page is always read from the full result.
//
// Why it exists. A real song under machine-delivery schema @2 carries about 1,500
// provisionally rendered releases, and their per-release records appear in every
// machine-delivery ledger a run, review, Final or artifact embeds -- twice per
// ledger. Event-level diffs, reduction plans and micro-timing enforcement lists
// grow the same way. Such a response exceeded the MCP result cap while the
// operation itself had succeeded, so a model saw an error for a mutation that
// had already taken effect, and could retry it.
//
// What it does, in order:
//
//   1. Every machine-delivery ledger entry's per-release lists
//      (`provisional_releases`, `unverified_lead_event_ids`) are always
//      summarized, whatever the response size, so their shape is stable: counts
//      (per role where the items name one), the first items, the SHA-256 of the
//      full list and where to read it.
//   2. When the response is larger than `triggerBytes`, the largest long lists
//      are summarized the same way, deepest bulk list first, until it fits in
//      `budgetBytes`. A response at or below the trigger is not touched, so an
//      ordinary response is returned exactly as the service produced it (and
//      matches the HTTP API byte for byte).
//
// A summary names where the full list is: `report_page` (the tool, its
// arguments and the JSON path to page) when the same content can be read again,
// otherwise `retrieve` (reads of the stored records that carry it). `sha256` is
// the SHA-256 of the omitted list's JSON text, which is also report_page's
// `value_sha256` for that path. A huge string is never cut: a response that
// still does not fit reaches the transport's size envelope, as before.
import { sha256Hex } from '../studio/backend/source/sha256.mjs';
import { PAGED_REPORT_TOOLS } from './report-page.mjs';

export const RESPONSE_COMPACTION = Object.freeze({
  schema: 'mml-studio/mcp-response-compaction@1',
  // Of the structured result's JSON text. The MCP transport carries it twice
  // (text and structured content), so a response at the budget stays far
  // below the 512 KiB result cap.
  budgetBytes: 32 * 1024,
  // Size-based compaction starts only above this size (it then compacts down
  // to `budgetBytes`), well below the result cap even when carried twice.
  triggerBytes: 96 * 1024,
  // Items a summary keeps: at most this many, and only while they fit in
  // `firstBytes` (a summary of very large items keeps none).
  firstItems: 3,
  ledgerFirstItems: 5,
  firstBytes: 1536,
  // Which lists count as bulk, tried in order while the response is still
  // over budget: long lists first, then shorter ones.
  bulkPasses: Object.freeze([
    Object.freeze({ minItems: 8, minBytes: 2048 }),
    Object.freeze({ minItems: 4, minBytes: 1024 }),
  ]),
});

// The machine-delivery ledger's per-release lists.
const LEDGER_LIST_KEYS = Object.freeze(['provisional_releases', 'unverified_lead_event_ids']);
const LEDGER_PHASES = Object.freeze(['blocking', 'non_blocking_pending', 'post_delivery', 'unresolved_evidence_ledger']);

// Fields a delivered Final's artifact stores exactly as `studio_finalize`
// returns them (application/final-service.mjs).
const FINAL_ARTIFACT_FIELDS = new Set(['micro_gap', 'provisional_release_rendering', 'tempo_restatements', 'machine_delivery', 'diagnostics', 'roles', 'round_trip', 'character_counts']);

// Reads whose whole purpose is the bulk list itself; they keep the documented
// report_page contract and are never summarized by size.
const BULK_SOURCE_READS = new Set(['studio_arrangement_suggest', 'studio_baseline_events']);

export const COMPACTION_NOTICE = 'Long lists in this response are summarized as {compacted: true, truncated, total, first, sha256, report_page | retrieve}; nothing was dropped from the stored records. Read a full list with report_page on the named read tool and JSON path (its value_sha256 equals sha256), or through the named retrieve read.';

const digest = text => sha256Hex(new TextEncoder().encode(text));
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Exact JSON.stringify length of a JSON-shaped value, computed bottom-up so a
// deep result is measured once rather than once per level.
function sizes(value, path, out) {
  if (Array.isArray(value)) {
    let total = 2 + Math.max(0, value.length - 1);
    value.forEach((item, index) => { total += sizes(item, [...path, String(index)], out); });
    out.push({ path, size: total, length: value.length, value });
    return total;
  }
  if (plain(value)) {
    const entries = Object.entries(value);
    let total = 2 + Math.max(0, entries.length - 1);
    for (const [key, child] of entries) total += JSON.stringify(key).length + 1 + sizes(child, [...path, key], out);
    return total;
  }
  return JSON.stringify(value).length;
}

// The same read again. Its arguments are the caller's own: repeated here when
// they are small, and otherwise named rather than copied into every summary
// (a reduction plan's decision set can be long).
function sameRead(name, readArgs, path) {
  const text = JSON.stringify(readArgs);
  return text.length <= 2048
    ? { tool: name, arguments: JSON.parse(text), path }
    : { tool: name, same_arguments: true, path };
}

function pointerFor(name, args, result, path) {
  const { report_page: _page, ...readArgs } = args ?? {};
  if (PAGED_REPORT_TOOLS.has(name) && readArgs.confirmations === undefined && readArgs.refresh !== true) {
    return sameRead(name, readArgs, path);
  }
  // A run operation returns the same run view the status read serves.
  if ((name === 'studio_run_start' || name === 'studio_run_resume') && path[0] === 'run'
    && typeof result?.run?.run_id === 'string' && typeof args?.project_id === 'string') {
    return { tool: 'studio_run_status', arguments: { project_id: args.project_id, run_id: result.run.run_id }, path };
  }
  const project_id = typeof args?.project_id === 'string' ? args.project_id : null;
  const review = candidate_id => (project_id && typeof candidate_id === 'string'
    ? { tool: 'studio_candidate_review', arguments: { project_id, candidate_id } } : null);
  // A review that also recorded confirmations reads back identically without them.
  if (name === 'studio_candidate_review') {
    const read = review(args?.candidate_id);
    return read ? { ...read, path } : null;
  }
  // An apply that re-reviewed its new candidate returns that candidate's review.
  if ((name === 'studio_final_reduction_apply' || name === 'studio_mobile_adaptation_apply') && path[0] === 'review') {
    const read = review((result?.reduction ?? result?.adaptation)?.candidate_id);
    return read ? { ...read, path } : null;
  }
  // The new candidate's event-level diff from the Source-Faithful Baseline is
  // its review's lineage diff from that baseline.
  if (name === 'studio_decisions_apply' && path[0] === 'decisions' && path[1] === 'diff_from_baseline') {
    const read = review(result?.decisions?.candidate_id);
    return read ? { ...read, path: ['review', 'lineage', 'sourceToCandidate', ...path.slice(2)] } : null;
  }
  // A delivered Final stores these fields in its artifact as returned.
  if (name === 'studio_finalize' && FINAL_ARTIFACT_FIELDS.has(path[0]) && typeof result?.artifact_id === 'string' && result.artifact_id) {
    return { tool: 'studio_artifact_get', arguments: { artifact_id: result.artifact_id }, path: ['artifact', ...path] };
  }
  return null;
}

// The stored records a mutation's omitted lists live in, when its response
// cannot be read again as it is.
function retrieveFor(args, result) {
  const reads = [];
  const project_id = [result?.project_id, result?.run?.project_id, args?.project_id].find(value => typeof value === 'string');
  const run_id = [result?.run?.run_id, result?.run_id, args?.run_id].find(value => typeof value === 'string');
  const candidate_id = [result?.candidate_id, result?.decisions?.candidate_id, result?.reduction?.candidate_id, result?.adaptation?.candidate_id, result?.run?.candidate_id]
    .find(value => typeof value === 'string');
  const artifact_id = [result?.artifact_id, result?.run?.final_artifact_id].find(value => typeof value === 'string' && value);
  const proposal_id = [result?.proposal?.proposal_id, args?.proposal_id].find(value => typeof value === 'string');
  if (artifact_id) reads.push({ tool: 'studio_artifact_get', arguments: { artifact_id } });
  if (project_id && candidate_id) reads.push({ tool: 'studio_candidate_review', arguments: { project_id, candidate_id } });
  if (project_id && run_id) reads.push({ tool: 'studio_run_status', arguments: { project_id, run_id } });
  if (project_id && proposal_id) reads.push({ tool: 'studio_proposal_status', arguments: { project_id, proposal_id } });
  return reads;
}

function leading(list, keep) {
  const first = [];
  let bytes = 2;
  for (const item of list.slice(0, keep)) {
    bytes += JSON.stringify(item).length + 1;
    if (bytes > RESPONSE_COMPACTION.firstBytes) break;
    first.push(item);
  }
  return first;
}

function summarize(list, { keep, name, args, result, path }) {
  const first = leading(list, keep);
  const summary = {
    compacted: true,
    truncated: list.length > first.length,
    total: list.length,
    first,
    sha256: digest(JSON.stringify(list)),
  };
  const roles = list.map(item => (plain(item) && typeof item.role === 'string' ? item.role : null));
  if (roles.length && roles.every(Boolean)) {
    summary.by_role = Object.fromEntries([...new Set(roles)].sort().map(role => [role, roles.filter(entry => entry === role).length]));
  }
  const pointer = pointerFor(name, args, result, path);
  if (pointer) summary.report_page = pointer;
  else summary.retrieve = retrieveFor(args, result);
  return summary;
}

const setAt = (root, path, value) => {
  let node = root;
  for (const key of path.slice(0, -1)) node = node[key];
  node[path.at(-1)] = value;
};

const isPrefix = (prefix, path) => prefix.length <= path.length && prefix.every((key, index) => path[index] === key);

const valueAt = (root, path) => {
  let node = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
};

// Every machine-delivery ledger in the result, wherever it is embedded: a run,
// a readiness report, a Final, an artifact, a continuation snapshot.
function ledgerLists(value, path, out) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => ledgerLists(item, [...path, String(index)], out));
    return out;
  }
  if (!plain(value)) return out;
  if (Array.isArray(value.unresolved_evidence_ledger) && typeof value.schema === 'string') {
    for (const phase of LEDGER_PHASES) {
      if (!Array.isArray(value[phase])) continue;
      value[phase].forEach((entry, index) => {
        for (const key of LEDGER_LIST_KEYS) {
          if (plain(entry) && Array.isArray(entry[key])) out.push([...path, phase, String(index), key]);
        }
      });
    }
  }
  for (const [key, child] of Object.entries(value)) ledgerLists(child, [...path, key], out);
  return out;
}

/**
 * The MCP view of one Studio tool result. Never throws for a result shape; a
 * non-object result is returned unchanged.
 */
export function compactStudioResponse(name, args, result) {
  if (!plain(result)) return result;
  const view = JSON.parse(JSON.stringify(result));
  const compacted = [];
  const record = (path, summary) => compacted.push({ path, total: summary.total });

  for (const path of ledgerLists(view, [], [])) {
    let list = view;
    for (const key of path) list = list[key];
    const summary = summarize(list, { keep: RESPONSE_COMPACTION.ledgerFirstItems, name, args, result, path });
    setAt(view, path, summary);
    record(path, summary);
  }

  if (!BULK_SOURCE_READS.has(name) && sizes(view, [], []) > RESPONSE_COMPACTION.triggerBytes) {
    for (const pass of RESPONSE_COMPACTION.bulkPasses) {
      const arrays = [];
      let estimate = sizes(view, [], arrays);
      if (estimate <= RESPONSE_COMPACTION.budgetBytes) break;
      const candidates = arrays.filter(entry => entry.length >= pass.minItems && entry.size >= pass.minBytes && entry.path.length > 0
        // Nothing inside a summary (its kept items, its pointer) is summarized again.
        && !compacted.some(done => isPrefix(done.path, entry.path)));
      // Prefer the list that actually holds the bulk: a list is passed over
      // when one list inside it is more than half its size, and that inner list
      // is summarized instead.
      const dominated = entry => candidates.some(inner => inner !== entry && isPrefix(entry.path, inner.path) && inner.size * 2 > entry.size);
      for (const entry of [...candidates].sort((a, b) => b.size - a.size)) {
        if (estimate <= RESPONSE_COMPACTION.budgetBytes) break;
        if (compacted.some(done => isPrefix(done.path, entry.path)) || dominated(entry)) continue;
        // A list can hold lists summarized earlier (a ledger phase holds the
        // per-release lists step 1 summarized). Its summary describes the
        // stored list, as report_page serves it, not the half-compacted view
        // of it: otherwise `sha256` is not report_page's `value_sha256` and
        // `first` holds summaries instead of items. Nothing outside a summary
        // is ever replaced, so the same path in `result` is that list.
        const stored = valueAt(result, entry.path);
        const summary = summarize(Array.isArray(stored) ? stored : entry.value, { keep: RESPONSE_COMPACTION.firstItems, name, args, result, path: entry.path });
        setAt(view, entry.path, summary);
        estimate -= entry.size - JSON.stringify(summary).length;
        // The summaries inside it are gone from the view, and so are their paths.
        for (let index = compacted.length - 1; index >= 0; index -= 1) {
          if (isPrefix(entry.path, compacted[index].path)) compacted.splice(index, 1);
        }
        record(entry.path, summary);
      }
    }
  }

  if (!compacted.length) return result;
  return {
    ...view,
    response_compaction: {
      schema: RESPONSE_COMPACTION.schema,
      trigger_bytes: RESPONSE_COMPACTION.triggerBytes,
      budget_bytes: RESPONSE_COMPACTION.budgetBytes,
      compacted,
      notice: COMPACTION_NOTICE,
    },
  };
}
