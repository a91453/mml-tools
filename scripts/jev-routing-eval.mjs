// Offline Jev routing evaluation. Implementation notes, not Canonical policy.
//
// Measures whether TypeSafe's Jev has usable discrimination on THIS project's
// halted runs before anything is wired into a workflow. It lives entirely in the
// agent layer: it never imports studio/backend/application/**, never calls an
// MCP tool, never writes into any Studio store, and adds no dependency. Receipts
// are read as data.
//
// A Jev answer is never a Canonical verdict. Typed output guarantees the
// interface, not truth: routing says which handling path a halted run should
// take, and nothing here may decide a gate, a rule or a musical result.
//
// Dry run is the default because a live run spends the operator's Jev credits.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ENDPOINT = '/v1/systemone';
const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
const DEFAULT_MODEL = 'jev-latest';
// Published input price at the time of writing; output is unmetered. Verify
// against the current TypeSafe pricing page before quoting a real budget.
const INPUT_USD_PER_MTOK = 0.042;

const HELP = `Offline Jev routing evaluation for halted Studio runs (agent layer only)

  node scripts/jev-routing-eval.mjs --data-dir DIR [--out results.json]
  node scripts/jev-routing-eval.mjs --cases cases.json --live --out results.json

  --data-dir DIR   Derive cases from an existing studio-agent workspace: every
                   receipt in DIR/receipts whose result carries a run with at
                   least one review request becomes one case per request.
  --cases FILE     Read cases directly: a JSON array of { id, state, label? }.
  --labels FILE    JSON object of { caseId: expectedRoute }, merged over any
                   label already on the case. Enables the separation report.
  --live           Actually call the API. This SPENDS CREDITS. Without it the
                   run is a dry run: payloads are built and printed, nothing is
                   sent, and no key is read.
  --limit N        Evaluate at most N cases.
  --out FILE       Write the full result JSON, including every raw answer.
  --model NAME     Model override (default ${DEFAULT_MODEL}).

Environment: TYPESAFE_API_KEY (required for --live), TYPESAFE_BASE_URL (optional).
`;

const refuse = (message, details) => {
  const error = new Error(message);
  error.details = details ?? null;
  error.refusal = true;
  throw error;
};

// ── questions ───────────────────────────────────────────────────────────────
//
// Asked together over one state: they run in parallel and cannot see one
// another's answers. Question keys are for this code and are not sent, so each
// instruction carries its full meaning on its own.
//
// `route` is a choice because the paths are competing alternatives and its
// distribution is what a threshold would read. `evidence_gap` is a score
// because "how much is missing" is a degree along an ordered dimension. A noul
// would not express that: a noul near 0.5 means yes and no are equally likely,
// not that half the evidence is present. `human_judgment_required` is a noul
// because it is genuinely a yes/no condition, and it returns a probability with
// no separate confidence field.

export const QUESTIONS = Object.freeze({
  route: {
    type: 'choice',
    instructions:
      'A Mabinogi Mobile MML arrangement run has halted and recorded a review request. '
      + 'Given the run state, the review request code, the recorded blockers, warnings and gate results, '
      + 'which handling path should this run take next? '
      + 'Decide only the handling path. Do not decide any musical content, do not select a proposal, '
      + 'and do not judge whether any rule or gate passed.',
    criteria: {
      continue_automatically:
        'The request is routine and already determined by the recorded state. An automated agent can prepare '
        + 'the admissible proposal from what is recorded, without new evidence and without asking a person.',
      deep_review:
        'The recorded state is enough to decide, but the decision is consequential or contested enough that it '
        + 'deserves a careful agent review pass before any proposal is submitted.',
      needs_source:
        'The run cannot be settled because source material, source provenance or the meter binding is missing, '
        + 'unproven or ambiguous. What is absent is evidence about the source, not a preference between options.',
      human_review:
        'Settling this needs a person: it turns on musical taste, on accepting a risk, or on authority an agent '
        + 'does not hold. This is also the answer when none of the other paths fits.',
    },
  },
  evidence_gap: {
    type: 'score',
    instructions:
      'How much of the evidence needed to settle this review request is missing from the recorded run state? '
      + 'Judge only how complete the evidence is. Do not judge whether the eventual decision is easy or hard, '
      + 'and do not judge musical quality.',
    criteria: [
      'Everything needed is recorded: the source binding, the candidate and the gate results are all present and unambiguous.',
      'A minor detail is absent, but it can be derived from what is recorded or it does not affect the decision.',
      'A substantive piece is absent: the decision can be framed, but settling it would rest on an assumption that nothing recorded supports.',
      'The evidence needed is essentially absent: the run does not record enough to even state what the decision is between.',
    ],
  },
  human_judgment_required: {
    type: 'noul',
    instructions:
      'Does settling this review request require a person rather than any automated agent, because it turns on '
      + 'musical taste, on accepting a risk, or on authority that an agent does not hold?',
    criteria: {
      true: 'A person must decide; an agent may prepare options but may not settle it.',
      false: 'An automated agent can settle it from recorded evidence and existing rules.',
    },
  },
});

/** The routes the summary tallies, taken from the question so the two cannot drift apart. */
export const ROUTES = Object.freeze(Object.keys(QUESTIONS.route.criteria));

// ── case construction ───────────────────────────────────────────────────────

/**
 * Summarize one halted run and one of its review requests into Jev state.
 *
 * Deliberately a summary, not the whole run: a full suggestion or review report
 * can exceed the 512 KiB the MCP layer caps, and input tokens are billed. The
 * fields kept are the ones a reviewer actually reads to choose a handling path.
 */
export const buildCase = (run, request, meta = {}) => {
  const list = value => (Array.isArray(value) ? value : []);
  const codesOf = entries => list(entries).map(entry => (typeof entry === 'string' ? entry : entry?.code)).filter(Boolean);
  // The index is part of the identity: one run may raise the same code twice with
  // different payloads, and those are two cases, not a duplicate.
  const index = meta.index ?? 0;
  return {
    id: `${run.run_id ?? 'run'}:${run.revision ?? 0}:${index}:${request?.code ?? 'request'}`,
    source: meta.source ?? null,
    state: {
      run: {
        state: run.state ?? null,
        revision: run.revision ?? null,
        pending_step: run.pending_step?.step ?? null,
        needs_reconciliation: run.needs_reconciliation === true,
        has_candidate: Boolean(run.candidate_id),
        has_final_artifact: Boolean(run.final_artifact_id),
      },
      review_request: request ?? null,
      blockers: codesOf(run.blockers),
      readiness_blockers: codesOf(run.readiness_blockers),
      warnings: codesOf(run.warnings),
      gates: run.gates ?? null,
      counts: {
        steps: list(run.steps).length,
        blockers: list(run.blockers).length,
        readiness_blockers: list(run.readiness_blockers).length,
        warnings: list(run.warnings).length,
        review_requests: list(run.review_requests).length,
      },
    },
  };
};

/** Read every receipt in DIR/receipts and derive one case per review request. */
export const casesFromDataDir = directory => {
  const receiptsDir = join(resolve(directory), 'receipts');
  let names;
  try { names = readdirSync(receiptsDir).filter(name => name.endsWith('.json')).sort(); }
  catch { refuse(`No receipts directory at ${receiptsDir}. Point --data-dir at a studio-agent workspace.`); }
  const cases = [];
  const seen = new Set();
  for (const name of names) {
    const path = join(receiptsDir, name);
    if (!statSync(path).isFile()) continue;
    let receipt;
    try { receipt = JSON.parse(readFileSync(path, 'utf8')); }
    catch { continue; }
    const run = receipt?.result?.run;
    if (!run || !Array.isArray(run.review_requests) || !run.review_requests.length) continue;
    for (const [index, request] of run.review_requests.entries()) {
      const built = buildCase(run, request, { source: name, index });
      // A run is re-read many times; keep one case per run revision and code.
      if (seen.has(built.id)) continue;
      seen.add(built.id);
      cases.push(built);
    }
  }
  return cases;
};

// ── request ─────────────────────────────────────────────────────────────────

export const buildPayload = (entry, model) => ({ model, state: entry.state, questions: QUESTIONS });

const callJev = async (payload, { baseURL, apiKey, signal }) => {
  const response = await fetch(`${baseURL.replace(/\/+$/, '')}${ENDPOINT}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'mml-tools-jev-eval/1',
    },
    body: JSON.stringify(payload),
    signal,
  });
  const text = await response.text();
  if (!response.ok) refuse(`Jev returned HTTP ${response.status}`, { status: response.status, body: text.slice(0, 2000) });
  try { return JSON.parse(text); }
  catch { refuse('Jev returned a body that is not JSON.', { body: text.slice(0, 2000) }); }
};

// ── reporting ───────────────────────────────────────────────────────────────

export const estimateCostUsd = inputTokens => (inputTokens / 1e6) * INPUT_USD_PER_MTOK;

/**
 * Distribution report over raw answers. Thresholds are NOT applied here: this
 * says what Jev reported, so that a policy can be chosen against real data
 * rather than assumed. Confidence bands are reporting buckets, not a policy.
 */
export const summarize = results => {
  const answered = results.filter(entry => entry.answers);
  const routes = Object.fromEntries(ROUTES.map(route => [route, 0]));
  const bands = { high: 0, medium: 0, low: 0 };
  let confidenceSum = 0;
  let inputTokens = 0;
  for (const entry of answered) {
    const route = entry.answers.route;
    if (route && Object.hasOwn(routes, route.choice)) routes[route.choice] += 1;
    const confidence = route?.confidence ?? 0;
    confidenceSum += confidence;
    bands[confidence >= 0.85 ? 'high' : confidence >= 0.6 ? 'medium' : 'low'] += 1;
    inputTokens += entry.usage?.input_tokens ?? 0;
  }
  const separation = {};
  for (const entry of answered) {
    if (!entry.label) continue;
    const bucket = (separation[entry.label] ??= { count: 0, routes: {}, confidence_sum: 0, agreed: 0 });
    bucket.count += 1;
    const choice = entry.answers.route?.choice ?? 'unknown';
    bucket.routes[choice] = (bucket.routes[choice] ?? 0) + 1;
    bucket.confidence_sum += entry.answers.route?.confidence ?? 0;
    if (choice === entry.label) bucket.agreed += 1;
  }
  for (const bucket of Object.values(separation)) {
    bucket.mean_confidence = bucket.count ? bucket.confidence_sum / bucket.count : 0;
    bucket.agreement = bucket.count ? bucket.agreed / bucket.count : 0;
    delete bucket.confidence_sum;
  }
  return {
    cases: results.length,
    answered: answered.length,
    failed: results.filter(entry => entry.error).length,
    routes,
    confidence_bands: bands,
    mean_route_confidence: answered.length ? confidenceSum / answered.length : 0,
    input_tokens: inputTokens,
    estimated_cost_usd: estimateCostUsd(inputTokens),
    separation: Object.keys(separation).length ? separation : null,
    notice:
      'Raw Jev answers. No threshold is applied and no Canonical verdict is implied. '
      + 'Choose thresholds against these distributions and the cost of each mistake, then keep them in code.',
  };
};

const formatSummary = summary => {
  const lines = [];
  lines.push(`Live: ${summary.answered}/${summary.cases} cases answered`
    + (summary.failed ? `, ${summary.failed} failed` : ''));
  lines.push('routes:  ' + ROUTES.map(route => `${route}=${summary.routes[route]}`).join('  '));
  lines.push(`confidence: high=${summary.confidence_bands.high} medium=${summary.confidence_bands.medium} low=${summary.confidence_bands.low}`
    + `  mean=${summary.mean_route_confidence.toFixed(3)}`);
  lines.push(`input tokens: ${summary.input_tokens}  estimated cost: $${summary.estimated_cost_usd.toFixed(6)}`);
  if (summary.separation) {
    lines.push('separation by label:');
    for (const [label, bucket] of Object.entries(summary.separation)) {
      lines.push(`  ${label}: n=${bucket.count} agreement=${bucket.agreement.toFixed(2)} `
        + `mean_confidence=${bucket.mean_confidence.toFixed(3)} routes=${JSON.stringify(bucket.routes)}`);
    }
  }
  return lines.join('\n');
};

// ── entry point ─────────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    'data-dir': { type: 'string' }, cases: { type: 'string' }, labels: { type: 'string' },
    out: { type: 'string' }, model: { type: 'string', default: DEFAULT_MODEL },
    limit: { type: 'string' }, live: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help || (!values['data-dir'] && !values.cases)) { process.stdout.write(HELP); return 0; }

  let cases = values.cases
    ? JSON.parse(readFileSync(resolve(values.cases), 'utf8'))
    : casesFromDataDir(values['data-dir']);
  if (!Array.isArray(cases)) refuse('--cases must hold a JSON array of { id, state, label? }.');
  if (values.labels) {
    const labels = JSON.parse(readFileSync(resolve(values.labels), 'utf8'));
    cases = cases.map(entry => (Object.hasOwn(labels, entry.id) ? { ...entry, label: labels[entry.id] } : entry));
  }
  if (values.limit !== undefined) {
    const limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) refuse(`--limit must be a positive integer, not ${JSON.stringify(values.limit)}.`);
    cases = cases.slice(0, limit);
  }
  if (!cases.length) refuse('No cases found. A case needs a run with at least one review request.');
  // Check every case before spending anything: a malformed --cases file should
  // name the offending entry, not fail mid-run with a type error.
  cases.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') refuse(`Case ${index} is not an object.`);
    if (typeof entry.id !== 'string' || !entry.id) refuse(`Case ${index} has no id.`);
    if (!entry.state || typeof entry.state !== 'object') refuse(`Case ${entry.id} has no state object to evaluate.`);
  });

  const live = values.live === true;
  const baseURL = process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL;
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (live && !apiKey) refuse('--live needs TYPESAFE_API_KEY in the environment. The key is never read from a file or an argument.');

  const results = [];
  for (const entry of cases) {
    const payload = buildPayload(entry, values.model);
    const stateChars = JSON.stringify(payload.state).length;
    if (!live) {
      results.push({ id: entry.id, label: entry.label ?? null, state_chars: stateChars, payload, answers: null });
      continue;
    }
    // One failed case must not discard the cases already paid for: record the
    // failure and carry on, so --out still holds every answer bought so far.
    try {
      const response = await callJev(payload, { baseURL, apiKey });
      results.push({
        id: entry.id, label: entry.label ?? null, state_chars: stateChars,
        model: response.model ?? null, answers: response.answers ?? null, usage: response.usage ?? null,
      });
    } catch (error) {
      results.push({
        id: entry.id, label: entry.label ?? null, state_chars: stateChars, answers: null,
        error: { message: error.message, details: error.details ?? null },
      });
      process.stderr.write(`case ${entry.id} failed: ${error.message}\n`);
    }
  }

  const summary = summarize(results);
  if (!live) {
    const chars = results.reduce((total, entry) => total + entry.state_chars, 0);
    process.stdout.write(
      `Dry run: ${results.length} cases built, ${chars} state characters total, nothing sent.\n`
      + `Review the payloads, then re-run with --live to spend Jev credits.\n`
      + (values.out ? '' : 'Pass --out FILE to inspect the exact payloads.\n'));
  } else {
    process.stdout.write(formatSummary(summary) + '\n');
  }
  if (values.out) writeFileSync(resolve(values.out), JSON.stringify({ summary, results }, null, 2) + '\n', 'utf8');
  // Non-zero when some cases failed, so a caller notices; the answers already
  // bought are still in --out.
  return summary.failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then(code => process.exit(code)).catch(error => {
    process.stderr.write(`${error.refusal ? 'REFUSED' : 'ERROR'}: ${error.message}\n`
      + (error.details ? JSON.stringify(error.details, null, 2) + '\n' : ''));
    process.exit(1);
  });
}
