// Read-only Railway production verification for GitHub Actions / operator use.
// This script performs no Railway mutation and never reads service variables.
// It verifies control-plane state against repository desired settings, then runs
// the existing public production provenance probe against the same expected main.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { loadProbeInputs, probeProduction } from './studio-production-probe.mjs';

export const RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.com/graphql/v2';
export const TERMINAL_DEPLOYMENT_STATES = new Set(['SUCCESS', 'FAILED', 'CRASHED', 'REMOVED', 'SLEEPING', 'SKIPPED']);
// A deployment Railway has put to sleep (App Sleeping, deploy.sleepApplication)
// is still the live deployment: it succeeded, its image answers the next
// request, and Railway reports it as SLEEPING instead of SUCCESS until traffic
// wakes it. The production service sleeps between uses, so an audit that
// accepted only SUCCESS failed on every healthy idle service (observed
// 2026-09-23 for main f4629169: control_plane FAIL, DEPLOYMENT_SLEEPING, no
// drift). The public probe that follows wakes the service by requesting it.
export const LIVE_DEPLOYMENT_STATES = new Set(['SUCCESS', 'SLEEPING']);

// A newer main merge can replace the audited deployment while its audit is
// still running: Railway builds the newer commit, marks the audited one
// REMOVED, and the newer deployment becomes latestDeployment. The newer
// commit's in-progress event lands in its own concurrency group, so nothing
// cancels the older audit, and it used to report ACTIVE_DEPLOYMENT_MISMATCH or
// DEPLOYMENT_REMOVED -- a red audit on a healthy commit after every overlapping
// merge (observed 2026-09-23, run #40: 784aad83 REMOVED by d359ab79, drift 0).
// When the deployment that replaced it is LIVE, on the same branch, and its
// commit strictly descends from the audited one, the audited commit is
// SUPERSEDED: neither verified nor failed here, because production now runs a
// later commit and that commit's own audit verifies it. A replacement that
// does not descend (a rollback, another branch) still fails.
//
// A later deployment that is not live -- still building, held for CI, failed,
// crashed or skipped -- replaces nothing: the audited deployment is still the
// one serving, so it is audited normally, public probe included, and the later
// deployment's own audit reports its outcome. Treating it as SUPERSEDED would
// leave the serving deployment unverified exactly when its successor failed.
export const SUPERSEDED = 'SUPERSEDED';
export const SUPERSEDABLE_DEPLOYMENT_STATES = new Set([...LIVE_DEPLOYMENT_STATES, 'REMOVED', 'SKIPPED']);
// Railway holds a deployment in these states before it builds: WAITING is the
// "Wait for CI" hold (every GitHub Actions workflow on the commit must finish
// first) and NEEDS_APPROVAL waits for a person. An audit that polls such a
// deployment from a workflow on the same commit is itself one of the checks
// Railway is waiting for, so the two wait on each other until the audit times
// out -- and a failed or cancelled audit can then make Railway skip the
// deployment. Observed on 2026-09-22 for main 37ddf414: the deployment stayed
// WAITING for 14 minutes while a dispatched audit polled it.
export const HELD_DEPLOYMENT_STATES = new Set(['WAITING', 'NEEDS_APPROVAL']);

// Whether a workflow may start (or keep) waiting on this deployment. Only a
// released deployment -- building, deploying or terminal -- is safe to audit.
export function classifyAuditGate(deployment) {
  if (!deployment) return { action: 'DEFER', reason: 'DEPLOYMENT_NOT_FOUND', status: null };
  if (HELD_DEPLOYMENT_STATES.has(deployment.status)) {
    return { action: 'DEFER', reason: 'DEPLOYMENT_HELD_BY_WAIT_FOR_CI', status: deployment.status };
  }
  return { action: 'AUDIT', reason: null, status: deployment.status };
}

const safeMessage = error => error instanceof Error ? error.message : String(error);
const sortStrings = values => [...values].sort((a, b) => a.localeCompare(b));
const defaultGitImpl = args => execFileSync('git', args, {
  cwd: new URL('../', import.meta.url),
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 30000,
  maxBuffer: 8 * 1024 * 1024,
});

export function watchPatternMatchesPath(pattern, path) {
  assert.ok(typeof pattern === 'string' && pattern.startsWith('/'), 'absolute Railway watch pattern required');
  assert.ok(typeof path === 'string' && path.length > 0 && !path.includes('\n'), 'repository-relative path required');
  const normalized = pattern.slice(1);
  if (normalized.endsWith('/**')) {
    const prefix = normalized.slice(0, -3);
    return path === prefix || path.startsWith(prefix + '/');
  }
  assert.ok(!normalized.includes('*'), 'unsupported Railway watch glob in production audit');
  return path === normalized;
}

export function watchedChangedPaths(paths, watchPatterns) {
  return [...new Set(paths)].filter(path => watchPatterns.some(pattern => watchPatternMatchesPath(pattern, path))).sort();
}

export function changedPathsBetween({ fromSha, toSha, gitImpl = defaultGitImpl }) {
  assert.match(fromSha ?? '', /^[0-9a-f]{40}$/, 'full deployed SHA required');
  assert.match(toSha ?? '', /^[0-9a-f]{40}$/, 'full target SHA required');
  gitImpl(['merge-base', '--is-ancestor', fromSha, toSha]);
  return gitImpl(['diff', '--name-only', fromSha, toSha, '--']).toString('utf8').split(/\r?\n/).filter(Boolean);
}

// True only when `sha` is a different commit that has `ancestorSha` in its
// history. Any git failure, an unknown commit included, answers false, which
// keeps the audit's earlier, failing verdict.
export function commitStrictlyDescends({ ancestorSha, sha, gitImpl = defaultGitImpl }) {
  if (!/^[0-9a-f]{40}$/.test(ancestorSha ?? '') || !/^[0-9a-f]{40}$/.test(sha ?? '') || ancestorSha === sha) return false;
  const known = () => { try { gitImpl(['cat-file', '-e', `${sha}^{commit}`]); return true; } catch { return false; } };
  // The audit job fetched main when it started; a merge that landed while it
  // waited is fetched once more before ancestry is decided.
  if (!known()) {
    try { gitImpl(['fetch', '--quiet', 'origin', 'main']); } catch { return false; }
    if (!known()) return false;
  }
  try {
    gitImpl(['merge-base', '--is-ancestor', ancestorSha, sha]);
    return true;
  } catch {
    return false;
  }
}

// Railway's latest deployment when it is a different deployment of a later
// commit on the same branch, whatever its status; otherwise null.
export function laterDeployment({ expected, expectedSha, state, targetDeployment, gitImpl = defaultGitImpl }) {
  if (!targetDeployment) return null;
  const active = state?.instance?.latestDeployment;
  if (!active || active.id === targetDeployment.id || active.meta?.branch !== expected.source.branch) return null;
  return commitStrictlyDescends({ ancestorSha: expectedSha, sha: active.meta?.commitHash, gitImpl }) ? active : null;
}

// The deployment that replaced the audited one: a later commit's deployment
// that is live, over an audited one that is live, removed or skipped.
export function supersedingDeployment({ expected, expectedSha, state, targetDeployment, gitImpl = defaultGitImpl }) {
  if (!targetDeployment || !SUPERSEDABLE_DEPLOYMENT_STATES.has(targetDeployment.status)) return null;
  const later = laterDeployment({ expected, expectedSha, state, targetDeployment, gitImpl });
  return later && LIVE_DEPLOYMENT_STATES.has(later.status) ? later : null;
}

export function manifestCommitAt(sha, gitImpl = defaultGitImpl) {
  assert.match(sha ?? '', /^[0-9a-f]{40}$/, 'full SHA required for Manifest lookup');
  const commit = gitImpl(['log', '-1', '--format=%H', sha, '--', 'docs/CANONICAL_MANIFEST.md']).toString('utf8').trim();
  assert.match(commit, /^[0-9a-f]{40}$/, 'Manifest commit lookup failed');
  return commit;
}

export async function railwayGraphQL({ token, query, variables = {}, fetchImpl = fetch }) {
  assert.ok(typeof token === 'string' && token.length >= 8, 'RAILWAY_PROJECT_TOKEN is required');
  const response = await fetchImpl(RAILWAY_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Project-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error(`Railway API HTTP ${response.status}`);
  const payload = await response.json();
  if (Array.isArray(payload.errors) && payload.errors.length) {
    const codes = payload.errors.map(error => error?.extensions?.code ?? 'GRAPHQL_ERROR');
    const traceIds = payload.errors.map(error => error?.extensions?.traceId).filter(Boolean);
    throw Error(`Railway GraphQL error: ${codes.join(',')}${traceIds.length ? ` trace=${traceIds.join(',')}` : ''}`);
  }
  if (!payload.data) throw Error('Railway GraphQL response missing data');
  return payload.data;
}

// The repository is public, so the deployment target names Railway resources
// and never carries their IDs; resolveProductionTarget looks the IDs up at run
// time from the project token's own scope.
export function expectedProductionConfig(serviceSettings, deploymentTarget) {
  assert.equal(serviceSettings?.plane, 'agent-control-plane');
  assert.equal(serviceSettings?.source?.repo, deploymentTarget?.githubSource);
  assert.equal(serviceSettings?.source?.branch, deploymentTarget?.githubBranch);
  for (const field of ['projectName', 'environmentName', 'serviceName']) {
    assert.ok(typeof deploymentTarget?.[field] === 'string' && deploymentTarget[field].length > 0, `deployment target ${field} required`);
  }
  const watchPatterns = serviceSettings?.build?.watchPatterns;
  assert.ok(Array.isArray(watchPatterns) && watchPatterns.length > 0, 'desired watchPatterns required');
  assert.equal(new Set(watchPatterns).size, watchPatterns.length, 'desired watchPatterns must be unique');
  return {
    projectName: deploymentTarget.projectName,
    environmentName: deploymentTarget.environmentName,
    serviceName: deploymentTarget.serviceName,
    publicOrigin: deploymentTarget.publicOrigin,
    source: {
      repo: serviceSettings.source.repo,
      branch: serviceSettings.source.branch,
    },
    config: {
      startCommand: serviceSettings.deploy.startCommand,
      healthcheckPath: serviceSettings.deploy.healthcheckPath,
      healthcheckTimeout: serviceSettings.deploy.healthcheckTimeout,
      restartPolicyType: serviceSettings.deploy.restartPolicyType,
      restartPolicyMaxRetries: serviceSettings.deploy.restartPolicyMaxRetries,
      numReplicas: serviceSettings.deploy.numReplicas,
      rootDirectory: serviceSettings.source.rootDirectory,
      dockerfilePath: serviceSettings.build.dockerfilePath,
      watchPatterns: sortStrings(watchPatterns),
    },
  };
}

// Code on every failed target check below, so a caller can tell a token for
// the wrong project, environment or service (report it) from a failed read.
export const TARGET_MISMATCH = 'RAILWAY_TARGET_MISMATCH';
const assertTarget = (ok, message) => {
  if (!ok) throw Object.assign(new assert.AssertionError({ message }), { code: TARGET_MISMATCH });
};

// Resolves the production IDs from names and fails closed on any mismatch. A
// Railway project token is scoped to one project and one environment, so the
// IDs come from the token itself and are then proven by name; nothing falls
// back to an ID kept in the repository. Query shapes (Railway GraphQL v2):
//   projectToken { projectId environmentId }
//   project(id) { name services { edges { node { id name } } } }
//   environment(id) { name }
export async function resolveProductionTarget({ token, expected, fetchImpl = fetch, graphQL = railwayGraphQL }) {
  for (const field of ['projectName', 'environmentName', 'serviceName']) {
    assert.ok(typeof expected?.[field] === 'string' && expected[field].length > 0, `expected ${field} required`);
  }
  const scope = (await graphQL({
    token,
    fetchImpl,
    query: `query RailwayTargetScope {
      projectToken { projectId environmentId }
    }`,
  })).projectToken;
  const { projectId, environmentId } = scope ?? {};
  assertTarget(typeof projectId === 'string' && projectId.length > 0
    && typeof environmentId === 'string' && environmentId.length > 0, 'Railway project token scope unavailable');
  const data = await graphQL({
    token,
    fetchImpl,
    variables: { projectId, environmentId },
    query: `query RailwayTargetNames($projectId: String!, $environmentId: String!) {
      project(id: $projectId) {
        name
        services { edges { node { id name } } }
      }
      environment(id: $environmentId) { name }
    }`,
  });
  assertTarget(data.project?.name === expected.projectName, 'Railway project token belongs to a different project');
  assertTarget(data.environment?.name === expected.environmentName, 'Railway project token belongs to a different environment');
  const services = (data.project.services?.edges ?? []).map(edge => edge?.node)
    .filter(node => node?.name === expected.serviceName);
  assertTarget(services.length === 1, `expected exactly one Railway service named ${expected.serviceName}, found ${services.length}`);
  const serviceId = services[0].id;
  assertTarget(typeof serviceId === 'string' && serviceId.length > 0, 'Railway service id unavailable');
  return { ...expected, projectId, environmentId, serviceId };
}

export function compareServiceInstance(expected, actual, availableFields = null) {
  const drift = [];
  const compare = (field, expectedValue, actualValue) => {
    if (availableFields && !availableFields.has(field)) {
      drift.push({ field, expected: expectedValue, actual: 'UNAVAILABLE_IN_RAILWAY_SCHEMA' });
      return;
    }
    // Railway may serialize defaults as null even when their effective value is
    // the repository default. Normalize only defaults whose equivalence is
    // explicit in our desired settings.
    if (field === 'rootDirectory' && expectedValue === '.' && (actualValue === null || actualValue === '')) actualValue = '.';
    if (field === 'numReplicas' && expectedValue === 1 && actualValue === null) actualValue = 1;
    if (actualValue !== expectedValue) drift.push({ field, expected: expectedValue, actual: actualValue ?? null });
  };
  for (const field of ['startCommand', 'healthcheckPath', 'healthcheckTimeout', 'restartPolicyType',
    'restartPolicyMaxRetries', 'numReplicas', 'rootDirectory', 'dockerfilePath']) {
    compare(field, expected.config[field], actual?.[field]);
  }
  if (availableFields && !availableFields.has('watchPatterns')) {
    drift.push({ field: 'watchPatterns', expected: expected.config.watchPatterns, actual: 'UNAVAILABLE_IN_RAILWAY_SCHEMA' });
  } else {
    const current = Array.isArray(actual?.watchPatterns) ? sortStrings(actual.watchPatterns) : [];
    if (JSON.stringify(current) !== JSON.stringify(expected.config.watchPatterns)) {
      drift.push({
        field: 'watchPatterns',
        expected: expected.config.watchPatterns,
        actual: current,
        missing: expected.config.watchPatterns.filter(value => !current.includes(value)),
        extra: current.filter(value => !expected.config.watchPatterns.includes(value)),
      });
    }
  }
  return drift;
}

export async function serviceInstanceFields({ token, fetchImpl = fetch }) {
  const data = await railwayGraphQL({
    token,
    fetchImpl,
    query: `query RailwayServiceInstanceSchema {
      __type(name: "ServiceInstance") {
        fields { name }
      }
    }`,
  });
  const fields = data.__type?.fields?.map(field => field.name);
  assert.ok(Array.isArray(fields) && fields.length > 0, 'Railway ServiceInstance schema unavailable');
  return new Set(fields);
}

const wantedServiceFields = Object.freeze([
  'startCommand', 'healthcheckPath', 'healthcheckTimeout', 'restartPolicyType',
  'restartPolicyMaxRetries', 'numReplicas', 'rootDirectory', 'dockerfilePath', 'watchPatterns',
]);

export async function readProductionState({ token, expected, fetchImpl = fetch }) {
  const availableFields = await serviceInstanceFields({ token, fetchImpl });
  const missingSchemaFields = wantedServiceFields.filter(field => !availableFields.has(field));
  if (missingSchemaFields.length) {
    return {
      availableFields,
      missingSchemaFields,
      instance: null,
      deployments: [],
      tokenScope: null,
    };
  }
  const fields = wantedServiceFields.join('\n');
  const data = await railwayGraphQL({
    token,
    fetchImpl,
    variables: {
      serviceId: expected.serviceId,
      environmentId: expected.environmentId,
      input: {
        projectId: expected.projectId,
        serviceId: expected.serviceId,
        environmentId: expected.environmentId,
      },
    },
    query: `query RailwayProductionAudit($serviceId: String!, $environmentId: String!, $input: DeploymentListInput!) {
      projectToken { projectId environmentId }
      serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
        ${fields}
        latestDeployment { id status createdAt meta }
      }
      deployments(input: $input, first: 20) {
        edges {
          node { id status createdAt meta }
        }
      }
    }`,
  });
  return {
    availableFields,
    missingSchemaFields: [],
    tokenScope: data.projectToken,
    instance: data.serviceInstance,
    deployments: data.deployments?.edges?.map(edge => edge.node) ?? [],
  };
}

export function findExpectedDeployment(deployments, expectedSha) {
  assert.match(expectedSha ?? '', /^[0-9a-f]{40}$/, 'full expected deployment SHA required');
  return deployments.find(deployment => deployment?.meta?.commitHash === expectedSha) ?? null;
}

export function resolveDeploymentBinding({ expected, expectedSha, state, targetDeployment, changedPaths = [], supersededBy = null, pendingSuccessor = null }) {
  if (!targetDeployment) return {
    activeDeployment: null,
    effectiveSha: expectedSha,
    reason: 'DEPLOYMENT_NOT_FOUND',
    skippedChanges: [],
    watchedSkippedChanges: [],
  };
  if (supersededBy && supersededBy.id !== targetDeployment.id && SUPERSEDABLE_DEPLOYMENT_STATES.has(targetDeployment.status)) return {
    activeDeployment: targetDeployment,
    effectiveSha: expectedSha,
    reason: SUPERSEDED,
    supersededBy,
    skippedChanges: [],
    watchedSkippedChanges: [],
  };
  if (LIVE_DEPLOYMENT_STATES.has(targetDeployment.status)) {
    const active = state?.instance?.latestDeployment;
    // A later commit's deployment that is not live yet (or never became live)
    // is Railway's latest, but the audited one is still the one serving.
    const successorNotLive = Boolean(pendingSuccessor) && active?.id === pendingSuccessor.id
      && !LIVE_DEPLOYMENT_STATES.has(active?.status);
    const activeMatches = (active?.id === targetDeployment.id && LIVE_DEPLOYMENT_STATES.has(active?.status)) || successorNotLive;
    return {
      activeDeployment: targetDeployment,
      effectiveSha: expectedSha,
      reason: activeMatches ? null : 'ACTIVE_DEPLOYMENT_MISMATCH',
      ...(successorNotLive ? { pendingSuccessor } : {}),
      skippedChanges: [],
      watchedSkippedChanges: [],
    };
  }
  if (targetDeployment.status !== 'SKIPPED') return {
    activeDeployment: targetDeployment,
    effectiveSha: expectedSha,
    reason: 'DEPLOYMENT_' + targetDeployment.status,
    skippedChanges: [],
    watchedSkippedChanges: [],
  };
  const active = state?.instance?.latestDeployment;
  const activeSha = active?.meta?.commitHash;
  const activeBranch = active?.meta?.branch;
  if (!LIVE_DEPLOYMENT_STATES.has(active?.status) || !/^[0-9a-f]{40}$/.test(activeSha ?? '') || activeBranch !== expected.source.branch) {
    return {
      activeDeployment: active ?? null,
      effectiveSha: activeSha ?? expectedSha,
      reason: 'NO_ACTIVE_SUCCESS_DEPLOYMENT',
      skippedChanges: changedPaths,
      watchedSkippedChanges: [],
    };
  }
  const watched = watchedChangedPaths(changedPaths, expected.config.watchPatterns);
  return {
    activeDeployment: active,
    effectiveSha: activeSha,
    reason: watched.length ? 'SKIPPED_WATCHED_CHANGES' : null,
    skippedChanges: [...new Set(changedPaths)].sort(),
    watchedSkippedChanges: watched,
  };
}

export async function waitForExpectedDeployment({
  token, expected, expectedSha, fetchImpl = fetch, waitSeconds = 900, pollSeconds = 15,
}) {
  assert.ok(Number.isInteger(waitSeconds) && waitSeconds >= 0 && waitSeconds <= 1800, 'invalid waitSeconds');
  assert.ok(Number.isInteger(pollSeconds) && pollSeconds >= 1 && pollSeconds <= 60, 'invalid pollSeconds');
  const deadline = Date.now() + waitSeconds * 1000;
  let state;
  do {
    state = await readProductionState({ token, expected, fetchImpl });
    if (state.missingSchemaFields.length) return { state, deployment: null, reason: 'SCHEMA_DRIFT' };
    const scope = state.tokenScope;
    if (scope?.projectId !== expected.projectId || scope?.environmentId !== expected.environmentId) {
      return { state, deployment: null, reason: 'TOKEN_SCOPE_MISMATCH' };
    }
    const deployment = findExpectedDeployment(state.deployments, expectedSha);
    if (deployment && TERMINAL_DEPLOYMENT_STATES.has(deployment.status)) {
      return { state, deployment, reason: null };
    }
    // Never poll a held deployment: this process may be the check it is held for.
    if (deployment && HELD_DEPLOYMENT_STATES.has(deployment.status)) {
      return { state, deployment, reason: 'DEPLOYMENT_HELD_BY_WAIT_FOR_CI' };
    }
    if (Date.now() >= deadline) return { state, deployment, reason: 'DEPLOYMENT_TIMEOUT' };
    await delay(pollSeconds * 1000);
  } while (true);
}

// One read, no waiting: decides whether the audit job may run at all. Used by
// the workflow's gate job so a premature dispatch finishes in seconds instead
// of holding a check open on the commit Railway is waiting to release.
export async function runAuditGate({ token, expectedSha, fetchImpl = fetch,
  loadJson = async path => JSON.parse(await readFile(path, 'utf8')) }) {
  assert.match(expectedSha ?? '', /^[0-9a-f]{40}$/, 'full expected deployment SHA required');
  const [serviceSettings, deploymentTarget] = await Promise.all([
    loadJson(resolve('railway/service-settings.json')),
    loadJson(resolve('railway/deployment-target.json')),
  ]);
  let expected;
  try {
    expected = await resolveProductionTarget({
      token, expected: expectedProductionConfig(serviceSettings, deploymentTarget), fetchImpl,
    });
  } catch (error) {
    // A token for another project, environment or service is a scope problem
    // for the audit job to report, like TOKEN_SCOPE_MISMATCH below; only a
    // failed read propagates (and defers).
    if (error?.code !== TARGET_MISMATCH) throw error;
    return { action: 'AUDIT', reason: 'TARGET_MISMATCH', status: null, deployment_id: null };
  }
  const state = await readProductionState({ token, expected, fetchImpl });
  if (state.missingSchemaFields.length) return { action: 'AUDIT', reason: 'SCHEMA_DRIFT', status: null, deployment_id: null };
  const scope = state.tokenScope;
  if (scope?.projectId !== expected.projectId || scope?.environmentId !== expected.environmentId) {
    return { action: 'AUDIT', reason: 'TOKEN_SCOPE_MISMATCH', status: null, deployment_id: null };
  }
  const deployment = findExpectedDeployment(state.deployments, expectedSha);
  return { ...classifyAuditGate(deployment), deployment_id: deployment?.id ?? null };
}

export function buildControlPlaneResult({
  expected, expectedSha, effectiveSha = expectedSha, state, deployment, requestedDeployment = deployment,
  reason, skippedChanges = [], watchedSkippedChanges = [], supersededBy = null, pendingSuccessor = null,
}) {
  const drift = state?.instance
    ? compareServiceInstance(expected, state.instance, state.availableFields)
    : (state?.missingSchemaFields ?? []).map(field => ({
        field,
        expected: expected.config[field],
        actual: 'UNAVAILABLE_IN_RAILWAY_SCHEMA',
      }));
  if (state?.tokenScope && (state.tokenScope.projectId !== expected.projectId || state.tokenScope.environmentId !== expected.environmentId)) {
    drift.push({
      field: 'projectToken.scope',
      expected: { projectId: expected.projectId, environmentId: expected.environmentId },
      actual: state.tokenScope,
    });
  }
  const deploymentOk = LIVE_DEPLOYMENT_STATES.has(deployment?.status) && deployment?.meta?.commitHash === effectiveSha
    && deployment?.meta?.branch === expected.source.branch;
  const requestedOk = requestedDeployment?.status === 'SKIPPED'
    ? effectiveSha !== expectedSha && watchedSkippedChanges.length === 0
    : requestedDeployment?.id === deployment?.id && effectiveSha === expectedSha;
  const summarizeDeployment = item => item ? {
    id: item.id,
    status: item.status,
    created_at: item.createdAt,
    commit_sha: item.meta?.commitHash ?? null,
    branch: item.meta?.branch ?? null,
    reason: item.meta?.reason ?? null,
  } : null;
  // Config drift is about the service as it is now, not about which commit
  // it runs, so a superseded commit still fails on it.
  if (reason === SUPERSEDED) return {
    status: drift.length === 0 ? SUPERSEDED : 'FAIL',
    expected_sha: expectedSha,
    effective_deployed_sha: effectiveSha,
    deployment: summarizeDeployment(deployment),
    requested_deployment: summarizeDeployment(requestedDeployment),
    superseded_by: summarizeDeployment(supersededBy),
    skipped_change_paths: skippedChanges,
    watched_skipped_change_paths: watchedSkippedChanges,
    failure_reason: drift.length ? 'CONFIG_DRIFT' : null,
    config_drift: drift,
  };
  return {
    status: !reason && deploymentOk && requestedOk && drift.length === 0 ? 'PASS' : 'FAIL',
    // A later commit's deployment that is not live: named, so a reader sees
    // why Railway's latest deployment is not the one audited.
    ...(pendingSuccessor ? { later_deployment_not_live: summarizeDeployment(pendingSuccessor) } : {}),
    expected_sha: expectedSha,
    effective_deployed_sha: effectiveSha,
    deployment: summarizeDeployment(deployment),
    requested_deployment: summarizeDeployment(requestedDeployment),
    skipped_change_paths: skippedChanges,
    watched_skipped_change_paths: watchedSkippedChanges,
    failure_reason: reason ?? (!deploymentOk || !requestedOk ? 'DEPLOYMENT_MISMATCH' : drift.length ? 'CONFIG_DRIFT' : null),
    config_drift: drift,
  };
}

export async function saveAudit(path, report) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

export async function runProductionAudit({
  token, expectedSha, manifestCommit, out, waitSeconds = 900, pollSeconds = 15,
  fetchImpl = fetch, loadJson = async path => JSON.parse(await readFile(path, 'utf8')), gitImpl = defaultGitImpl,
}) {
  const [serviceSettings, deploymentTarget] = await Promise.all([
    loadJson(resolve('railway/service-settings.json')),
    loadJson(resolve('railway/deployment-target.json')),
  ]);
  const desired = expectedProductionConfig(serviceSettings, deploymentTarget);
  const report = {
    schema_version: 1,
    scope: 'Read-only Railway production control-plane plus HTTPS provenance; not song quality or in-game acceptance',
    observed_at: new Date().toISOString(),
    expected: {
      // Filled once resolveProductionTarget has proven the IDs by name.
      project_id: null,
      environment_id: null,
      service_id: null,
      source_repo: desired.source.repo,
      source_branch: desired.source.branch,
      public_origin: desired.publicOrigin,
      expected_sha: expectedSha,
      manifest_commit: manifestCommit,
    },
    control_plane: { status: 'NOT_RUN' },
    public_probe: { status: 'NOT_RUN' },
    status: 'FAIL',
  };
  try {
    const expected = await resolveProductionTarget({ token, expected: desired, fetchImpl });
    report.expected.project_id = expected.projectId;
    report.expected.environment_id = expected.environmentId;
    report.expected.service_id = expected.serviceId;
    const waited = await waitForExpectedDeployment({
      token, expected, expectedSha, fetchImpl, waitSeconds, pollSeconds,
    });
    const later = waited.reason ? null : laterDeployment({
      expected, expectedSha, state: waited.state, targetDeployment: waited.deployment, gitImpl,
    });
    const supersededBy = later && LIVE_DEPLOYMENT_STATES.has(later.status)
      && SUPERSEDABLE_DEPLOYMENT_STATES.has(waited.deployment?.status) ? later : null;
    const pendingSuccessor = later && !LIVE_DEPLOYMENT_STATES.has(later.status)
      && LIVE_DEPLOYMENT_STATES.has(waited.deployment?.status) ? later : null;
    let changedPaths = [];
    if (!waited.reason && !supersededBy && waited.deployment?.status === 'SKIPPED') {
      const activeSha = waited.state?.instance?.latestDeployment?.meta?.commitHash;
      if (/^[0-9a-f]{40}$/.test(activeSha ?? '')) {
        changedPaths = changedPathsBetween({ fromSha: activeSha, toSha: expectedSha, gitImpl });
      }
    }
    const binding = waited.reason ? {
      activeDeployment: waited.deployment,
      effectiveSha: expectedSha,
      reason: waited.reason,
      skippedChanges: [],
      watchedSkippedChanges: [],
    } : resolveDeploymentBinding({
      expected,
      expectedSha,
      state: waited.state,
      targetDeployment: waited.deployment,
      changedPaths,
      supersededBy,
      pendingSuccessor,
    });
    report.control_plane = buildControlPlaneResult({
      expected,
      expectedSha,
      state: waited.state,
      deployment: binding.activeDeployment,
      requestedDeployment: waited.deployment,
      effectiveSha: binding.effectiveSha,
      reason: binding.reason,
      skippedChanges: binding.skippedChanges,
      watchedSkippedChanges: binding.watchedSkippedChanges,
      supersededBy: binding.supersededBy ?? null,
      pendingSuccessor: binding.pendingSuccessor ?? null,
    });
    if (report.control_plane.status === SUPERSEDED) {
      report.status = SUPERSEDED;
      return report;
    }
    if (report.control_plane.status !== 'PASS') return report;
    const effectiveManifestCommit = binding.effectiveSha === expectedSha
      ? manifestCommit
      : manifestCommitAt(binding.effectiveSha);
    report.expected.effective_deployed_sha = binding.effectiveSha;
    report.expected.effective_manifest_commit = effectiveManifestCommit;
    const probeInputs = await loadProbeInputs({ main: binding.effectiveSha, manifestCommit: effectiveManifestCommit });
    report.public_probe = await probeProduction({
      origin: expected.publicOrigin,
      ...probeInputs,
      fetchImpl,
    });
    report.status = report.public_probe.status === 'PASS' ? 'PASS' : 'FAIL';
  } catch (error) {
    if (report.control_plane.status === 'PASS') {
      report.public_probe = {
        status: 'FAIL',
        reason: error?.code === 'CANONICAL_NOT_LOADED' ? 'CANONICAL_NOT_LOADED' : 'PUBLIC_PROBE_FAILED',
      };
    }
    report.failure = {
      code: error?.code ?? 'AUDIT_FAILED',
      message: safeMessage(error).slice(0, 500),
    };
  } finally {
    if (out) await saveAudit(out, report);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    'expected-sha': { type: 'string' },
    'manifest-commit': { type: 'string' },
    out: { type: 'string' },
    'wait-seconds': { type: 'string', default: '900' },
    'poll-seconds': { type: 'string', default: '15' },
    gate: { type: 'boolean', default: false },
  } });
  const token = process.env.RAILWAY_PROJECT_TOKEN;
  if (values.gate) {
    // Schema drift and token-scope problems are left to the audit job, which
    // reports them as failures; the gate only defers a held deployment.
    // A gate that cannot read Railway defers rather than fails: on a held
    // deployment a failed check makes Railway skip it, and deferring claims
    // nothing was verified.
    let gate;
    try { gate = await runAuditGate({ token, expectedSha: values['expected-sha'] }); }
    catch (error) { gate = { action: 'DEFER', reason: 'GATE_READ_FAILED', status: null, deployment_id: null, error: safeMessage(error).slice(0, 200) }; }
    console.log(JSON.stringify(gate));
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `released=${gate.action === 'AUDIT'}\ngate_reason=${gate.reason ?? ''}\ngate_status=${gate.status ?? ''}\n`);
    }
    process.exit(0);
  }
  if (!values.out) throw Error('--out is required');
  const report = await runProductionAudit({
    token,
    expectedSha: values['expected-sha'],
    manifestCommit: values['manifest-commit'],
    out: values.out,
    waitSeconds: Number(values['wait-seconds']),
    pollSeconds: Number(values['poll-seconds']),
  });
  console.log(JSON.stringify({
    status: report.status,
    control_plane: report.control_plane.status,
    public_probe: report.public_probe.status,
    deployment: report.control_plane.deployment?.id ?? null,
    drift_count: report.control_plane.config_drift?.length ?? null,
  }));
  if (report.status === SUPERSEDED) {
    const later = report.control_plane.superseded_by;
    console.log(`::warning::Railway production audit SUPERSEDED: ${values['expected-sha']} was replaced by deployment ${later?.id} of later main commit ${later?.commit_sha}; nothing was verified here, that commit's audit verifies production.`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, [
        '### Railway production audit SUPERSEDED — not verified',
        `The deployment for \`${values['expected-sha']}\` was replaced by deployment \`${later?.id}\` of later main commit \`${later?.commit_sha}\` (status ${later?.status}) while this audit ran.`,
        'Production no longer runs this commit, so it is neither verified nor failed here. The later commit\'s own audit verifies production.',
        '',
      ].join('\n'));
    }
  }
  // Drift has one remedy, and it is not a rebuild: the repository's desired
  // state reaches Railway only through the dispatched config-apply workflow.
  if (report.control_plane.failure_reason === 'CONFIG_DRIFT') {
    const fields = [...new Set((report.control_plane.config_drift ?? []).map(item => item.field))].join(', ');
    console.log(`::error::Railway production config drift (${fields}). If railway/service-settings.json changed in this merge, dispatch 'Railway production config apply' on main with confirmation APPLY_REPOSITORY_DESIRED_STATE, then re-run this audit.`);
  }
  process.exitCode = report.status === 'PASS' || report.status === SUPERSEDED ? 0 : 1;
}
