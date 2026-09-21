// Read-only Railway production verification for GitHub Actions / operator use.
// This script performs no Railway mutation and never reads service variables.
// It verifies control-plane state against repository desired settings, then runs
// the existing public production provenance probe against the same expected main.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { loadProbeInputs, probeProduction } from './studio-production-probe.mjs';

export const RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.com/graphql/v2';
export const TERMINAL_DEPLOYMENT_STATES = new Set(['SUCCESS', 'FAILED', 'CRASHED', 'REMOVED', 'SLEEPING', 'SKIPPED']);

const safeMessage = error => error instanceof Error ? error.message : String(error);
const sortStrings = values => [...values].sort((a, b) => a.localeCompare(b));

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

export function expectedProductionConfig(serviceSettings, deploymentTarget) {
  assert.equal(serviceSettings?.plane, 'agent-control-plane');
  assert.equal(serviceSettings?.source?.repo, deploymentTarget?.githubSource);
  assert.equal(serviceSettings?.source?.branch, deploymentTarget?.githubBranch);
  const watchPatterns = serviceSettings?.build?.watchPatterns;
  assert.ok(Array.isArray(watchPatterns) && watchPatterns.length > 0, 'desired watchPatterns required');
  assert.equal(new Set(watchPatterns).size, watchPatterns.length, 'desired watchPatterns must be unique');
  return {
    projectId: deploymentTarget.projectId,
    environmentId: deploymentTarget.environmentId,
    serviceId: deploymentTarget.serviceId,
    projectName: deploymentTarget.projectName,
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
        latestDeployment { id status createdAt }
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
    if (Date.now() >= deadline) return { state, deployment, reason: 'DEPLOYMENT_TIMEOUT' };
    await delay(pollSeconds * 1000);
  } while (true);
}

export function buildControlPlaneResult({ expected, expectedSha, state, deployment, reason }) {
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
  const deploymentOk = deployment?.status === 'SUCCESS' && deployment?.meta?.commitHash === expectedSha
    && deployment?.meta?.branch === expected.source.branch;
  return {
    status: !reason && deploymentOk && drift.length === 0 ? 'PASS' : 'FAIL',
    expected_sha: expectedSha,
    deployment: deployment ? {
      id: deployment.id,
      status: deployment.status,
      created_at: deployment.createdAt,
      commit_sha: deployment.meta?.commitHash ?? null,
      branch: deployment.meta?.branch ?? null,
      reason: deployment.meta?.reason ?? null,
    } : null,
    failure_reason: reason ?? (!deploymentOk ? 'DEPLOYMENT_MISMATCH' : drift.length ? 'CONFIG_DRIFT' : null),
    config_drift: drift,
  };
}

export async function saveAudit(path, report) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

export async function runProductionAudit({
  token, expectedSha, manifestCommit, out, waitSeconds = 900, pollSeconds = 15,
  fetchImpl = fetch, loadJson = async path => JSON.parse(await readFile(path, 'utf8')),
}) {
  const [serviceSettings, deploymentTarget] = await Promise.all([
    loadJson(resolve('railway/service-settings.json')),
    loadJson(resolve('railway/deployment-target.json')),
  ]);
  const expected = expectedProductionConfig(serviceSettings, deploymentTarget);
  const report = {
    schema_version: 1,
    scope: 'Read-only Railway production control-plane plus HTTPS provenance; not song quality or in-game acceptance',
    observed_at: new Date().toISOString(),
    expected: {
      project_id: expected.projectId,
      environment_id: expected.environmentId,
      service_id: expected.serviceId,
      source_repo: expected.source.repo,
      source_branch: expected.source.branch,
      public_origin: expected.publicOrigin,
      expected_sha: expectedSha,
      manifest_commit: manifestCommit,
    },
    control_plane: { status: 'NOT_RUN' },
    public_probe: { status: 'NOT_RUN' },
    status: 'FAIL',
  };
  try {
    const waited = await waitForExpectedDeployment({
      token, expected, expectedSha, fetchImpl, waitSeconds, pollSeconds,
    });
    report.control_plane = buildControlPlaneResult({ expected, expectedSha, ...waited });
    if (report.control_plane.status !== 'PASS') return report;
    const probeInputs = await loadProbeInputs({ main: expectedSha, manifestCommit });
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
  } });
  const token = process.env.RAILWAY_PROJECT_TOKEN;
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
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}
