import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TARGET_MISMATCH,
  buildControlPlaneResult,
  classifyAuditGate,
  compareServiceInstance,
  expectedProductionConfig,
  findExpectedDeployment,
  railwayGraphQL,
  readProductionState,
  resolveDeploymentBinding,
  resolveProductionTarget,
  runAuditGate,
  runProductionAudit,
  waitForExpectedDeployment,
  watchedChangedPaths,
} from '../scripts/railway-production-audit.mjs';

const SHA = 'a'.repeat(40);
// Obviously fake Railway IDs: the real ones are resolved at run time and never
// kept in this public repository.
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ENVIRONMENT_ID = '22222222-2222-4222-8222-222222222222';
const SERVICE_ID = '33333333-3333-4333-8333-333333333333';
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function desired() {
  return expectedProductionConfig({
    plane: 'agent-control-plane',
    source: { repo: 'a91453/mml-tools', branch: 'main', rootDirectory: '.' },
    build: {
      dockerfilePath: 'railway/Dockerfile',
      watchPatterns: ['/server/mcp.mjs', '/server/studio-agent-driver.mjs', '/server/studio-agent-codex.mjs'],
    },
    deploy: {
      startCommand: 'node railway/server.mjs',
      healthcheckPath: '/healthz',
      healthcheckTimeout: 60,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 3,
      numReplicas: 1,
    },
  }, {
    projectName: 'mml-tools-allen',
    environmentName: 'production',
    serviceName: 'mml-tools',
    publicOrigin: 'https://mml-tools-production.up.railway.app',
    githubSource: 'a91453/mml-tools',
    githubBranch: 'main',
  });
}

// What resolveProductionTarget returns for the mocked token below.
function resolved() {
  return { ...desired(), projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID, serviceId: SERVICE_ID };
}

// Railway answers to the two target-resolution reads, by operation name.
function targetData(query, {
  projectName = 'mml-tools-allen',
  environmentName = 'production',
  services = [{ id: SERVICE_ID, name: 'mml-tools' }, { id: '44444444-4444-4444-8444-444444444444', name: 'other' }],
  scope = { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID },
} = {}) {
  if (query.includes('RailwayTargetScope')) return { projectToken: scope };
  if (query.includes('RailwayTargetNames')) return {
    project: { name: projectName, services: { edges: services.map(node => ({ node })) } },
    environment: { name: environmentName },
  };
  return null;
}

const reply = data => ({ ok: true, status: 200, async json() { return { data }; } });

function live(overrides = {}) {
  return {
    startCommand: 'node railway/server.mjs',
    healthcheckPath: '/healthz',
    healthcheckTimeout: 60,
    restartPolicyType: 'ON_FAILURE',
    restartPolicyMaxRetries: 3,
    numReplicas: 1,
    rootDirectory: '.',
    dockerfilePath: 'railway/Dockerfile',
    watchPatterns: ['/server/studio-agent-codex.mjs', '/server/mcp.mjs', '/server/studio-agent-driver.mjs'],
    ...overrides,
  };
}

test('desired production config is derived from repository references and sorts watch patterns', () => {
  const expected = desired();
  assert.equal(expected.projectName, 'mml-tools-allen');
  assert.equal(expected.environmentName, 'production');
  assert.equal(expected.serviceName, 'mml-tools');
  for (const field of ['projectId', 'environmentId', 'serviceId']) assert.equal(field in expected, false, field);
  assert.equal(expected.source.branch, 'main');
  assert.deepEqual(expected.config.watchPatterns, [
    '/server/mcp.mjs',
    '/server/studio-agent-codex.mjs',
    '/server/studio-agent-driver.mjs',
  ]);
});

test('config comparison is order-insensitive and detects missing/extra watch patterns exactly', () => {
  const expected = desired();
  assert.deepEqual(compareServiceInstance(expected, live()), []);
  assert.deepEqual(compareServiceInstance(expected, live({ rootDirectory: null, numReplicas: null })), []);
  const drift = compareServiceInstance(expected, live({
    watchPatterns: ['/server/mcp.mjs', '/server/obsolete.mjs'],
  }));
  assert.equal(drift.length, 1);
  assert.equal(drift[0].field, 'watchPatterns');
  assert.deepEqual(drift[0].missing, ['/server/studio-agent-codex.mjs', '/server/studio-agent-driver.mjs']);
  assert.deepEqual(drift[0].extra, ['/server/obsolete.mjs']);
});

test('Railway GraphQL errors expose only code/trace metadata, not server text or token', async () => {
  const token = 'project-token-secret';
  const fetchImpl = async (_url, request) => {
    assert.equal(request.headers['Project-Access-Token'], token);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          data: null,
          errors: [{
            message: 'sensitive provider detail that must not leave the runner',
            extensions: { code: 'INTERNAL_SERVER_ERROR', traceId: 'trace-123' },
          }],
        };
      },
    };
  };
  await assert.rejects(
    railwayGraphQL({ token, query: 'query { projectToken { projectId } }', fetchImpl }),
    error => {
      assert.match(error.message, /INTERNAL_SERVER_ERROR/);
      assert.match(error.message, /trace-123/);
      assert.doesNotMatch(error.message, /sensitive provider detail/);
      assert.doesNotMatch(error.message, new RegExp(token));
      return true;
    },
  );
});

test('readProductionState performs schema discovery and a read-only query', async () => {
  const expected = resolved();
  const requested = [];
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body);
    requested.push(body.query);
    if (body.query.includes('__type')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: { __type: { fields: [
            'startCommand', 'healthcheckPath', 'healthcheckTimeout', 'restartPolicyType',
            'restartPolicyMaxRetries', 'numReplicas', 'rootDirectory', 'dockerfilePath',
            'watchPatterns', 'latestDeployment',
          ].map(name => ({ name })) } } };
        },
      };
    }
    assert.doesNotMatch(body.query, /mutation\s/i);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          data: {
            projectToken: { projectId: expected.projectId, environmentId: expected.environmentId },
            serviceInstance: { ...live(), latestDeployment: {
              id: 'dep-1', status: 'SUCCESS', createdAt: '2026-09-21T00:00:00Z',
              meta: { commitHash: SHA, branch: 'main', reason: 'deploy' },
            } },
            deployments: { edges: [{ node: {
              id: 'dep-1', status: 'SUCCESS', createdAt: '2026-09-21T00:00:00Z',
              meta: { commitHash: SHA, branch: 'main', reason: 'deploy' },
            } }] },
          },
        };
      },
    };
  };
  const state = await readProductionState({ token: 'project-token-secret', expected, fetchImpl });
  assert.equal(requested.length, 2);
  assert.equal(state.instance.startCommand, 'node railway/server.mjs');
  assert.equal(state.deployments.length, 1);
  assert.deepEqual(state.missingSchemaFields, []);
});

test('schema drift fails closed before querying a service instance', async () => {
  const expected = resolved();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: { __type: { fields: [{ name: 'startCommand' }] } } };
      },
    };
  };
  const state = await readProductionState({ token: 'project-token-secret', expected, fetchImpl });
  assert.equal(calls, 1);
  assert.ok(state.missingSchemaFields.includes('watchPatterns'));
  assert.equal(state.instance, null);
});

test('deployment selection and final control-plane verdict bind the exact main SHA', () => {
  const expected = resolved();
  const deployments = [
    { id: 'old', status: 'SUCCESS', meta: { commitHash: 'b'.repeat(40), branch: 'main' } },
    { id: 'wanted', status: 'SUCCESS', createdAt: '2026-09-21T00:00:00Z', meta: { commitHash: SHA, branch: 'main', reason: 'deploy' } },
  ];
  const deployment = findExpectedDeployment(deployments, SHA);
  assert.equal(deployment.id, 'wanted');
  const result = buildControlPlaneResult({
    expected,
    expectedSha: SHA,
    state: {
      availableFields: new Set([
        'startCommand', 'healthcheckPath', 'healthcheckTimeout', 'restartPolicyType',
        'restartPolicyMaxRetries', 'numReplicas', 'rootDirectory', 'dockerfilePath', 'watchPatterns',
      ]),
      instance: live(),
      tokenScope: { projectId: expected.projectId, environmentId: expected.environmentId },
    },
    deployment,
    reason: null,
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.failure_reason, null);
  assert.equal(result.deployment.commit_sha, SHA);
});


test('watch pattern matching treats exact files and /** directories as production deploy triggers', () => {
  const patterns = ['/server/mcp.mjs', '/studio/web/service/**'];
  assert.deepEqual(watchedChangedPaths([
    'docs/README.md',
    'studio/web/service/app.mjs',
    'server/mcp.mjs',
    'studio/web/service/nested/asset.txt',
  ], patterns), [
    'server/mcp.mjs',
    'studio/web/service/app.mjs',
    'studio/web/service/nested/asset.txt',
  ]);
});

test('a SKIPPED main commit may reuse the active successful deployment only when no watched path changed', () => {
  const expected = resolved();
  const deployedSha = 'b'.repeat(40);
  const target = {
    id: 'skip-1',
    status: 'SKIPPED',
    createdAt: '2026-09-21T01:00:00Z',
    meta: { commitHash: SHA, branch: 'main' },
  };
  const active = {
    id: 'active-1',
    status: 'SUCCESS',
    createdAt: '2026-09-21T00:00:00Z',
    meta: { commitHash: deployedSha, branch: 'main', reason: 'deploy' },
  };
  const state = {
    instance: { ...live(), latestDeployment: active },
  };
  const binding = resolveDeploymentBinding({
    expected,
    expectedSha: SHA,
    state,
    targetDeployment: target,
    changedPaths: ['docs/ops.md', 'scripts/railway-production-audit.mjs'],
  });
  assert.equal(binding.reason, null);
  assert.equal(binding.activeDeployment.id, 'active-1');
  assert.equal(binding.effectiveSha, deployedSha);
  assert.deepEqual(binding.watchedSkippedChanges, []);

  const result = buildControlPlaneResult({
    expected,
    expectedSha: SHA,
    effectiveSha: binding.effectiveSha,
    state: {
      ...state,
      availableFields: new Set([
        'startCommand', 'healthcheckPath', 'healthcheckTimeout', 'restartPolicyType',
        'restartPolicyMaxRetries', 'numReplicas', 'rootDirectory', 'dockerfilePath', 'watchPatterns',
      ]),
      tokenScope: { projectId: expected.projectId, environmentId: expected.environmentId },
    },
    deployment: binding.activeDeployment,
    requestedDeployment: target,
    reason: binding.reason,
    skippedChanges: binding.skippedChanges,
    watchedSkippedChanges: binding.watchedSkippedChanges,
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.expected_sha, SHA);
  assert.equal(result.effective_deployed_sha, deployedSha);
  assert.equal(result.requested_deployment.status, 'SKIPPED');
});

test('a SKIPPED main commit fails closed if any production watch path changed', () => {
  const expected = resolved();
  const deployedSha = 'b'.repeat(40);
  const target = {
    id: 'skip-1',
    status: 'SKIPPED',
    meta: { commitHash: SHA, branch: 'main' },
  };
  const active = {
    id: 'active-1',
    status: 'SUCCESS',
    meta: { commitHash: deployedSha, branch: 'main', reason: 'deploy' },
  };
  const binding = resolveDeploymentBinding({
    expected,
    expectedSha: SHA,
    state: { instance: { ...live(), latestDeployment: active } },
    targetDeployment: target,
    changedPaths: ['server/mcp.mjs', 'docs/ops.md'],
  });
  assert.equal(binding.reason, 'SKIPPED_WATCHED_CHANGES');
  assert.deepEqual(binding.watchedSkippedChanges, ['server/mcp.mjs']);
});

// ─── Railway Wait for CI deadlock (observed 2026-09-22, main 37ddf414) ──────
//
// Railway held the deployment WAITING until every GitHub Actions workflow on
// the commit finished, while a dispatched audit on that commit polled the
// deployment for up to wait_seconds. Neither could finish first. These pin the
// two halves of the fix: never poll a held deployment, and let a gate decide
// before anything waits.

function railwayFetch(expected, deploymentStatus, target = {}) {
  const calls = [];
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body);
    calls.push(body.query);
    const resolution = targetData(body.query, target);
    if (resolution) return reply(resolution);
    if (body.query.includes('__type')) {
      return { ok: true, status: 200, async json() {
        return { data: { __type: { fields: [
          'startCommand', 'healthcheckPath', 'healthcheckTimeout', 'restartPolicyType',
          'restartPolicyMaxRetries', 'numReplicas', 'rootDirectory', 'dockerfilePath',
          'watchPatterns', 'latestDeployment',
        ].map(name => ({ name })) } } };
      } };
    }
    assert.doesNotMatch(body.query, /mutation\s/i);
    const node = deploymentStatus === null ? [] : [{ node: {
      id: 'dep-held', status: deploymentStatus, createdAt: '2026-09-22T17:21:30Z',
      meta: { commitHash: SHA, branch: 'main', reason: 'deploy' },
    } }];
    return { ok: true, status: 200, async json() {
      return { data: {
        projectToken: { projectId: expected.projectId, environmentId: expected.environmentId },
        serviceInstance: { ...live(), latestDeployment: null },
        deployments: { edges: node },
      } };
    } };
  };
  return { fetchImpl, calls };
}

test('the audit gate defers held or missing deployments and audits released ones', () => {
  assert.deepEqual(classifyAuditGate(null), { action: 'DEFER', reason: 'DEPLOYMENT_NOT_FOUND', status: null });
  for (const status of ['WAITING', 'NEEDS_APPROVAL']) {
    assert.equal(classifyAuditGate({ status }).action, 'DEFER', status);
    assert.equal(classifyAuditGate({ status }).reason, 'DEPLOYMENT_HELD_BY_WAIT_FOR_CI', status);
  }
  for (const status of ['QUEUED', 'INITIALIZING', 'BUILDING', 'DEPLOYING', 'SUCCESS', 'FAILED', 'CRASHED', 'SKIPPED', 'REMOVED']) {
    assert.equal(classifyAuditGate({ status }).action, 'AUDIT', status);
  }
});

test('a WAITING deployment is never polled: the audit returns at once instead of holding the check', async () => {
  const expected = resolved();
  const { fetchImpl, calls } = railwayFetch(expected, 'WAITING');
  const started = Date.now();
  // The pre-fix loop would poll here for the whole 900 s budget while Railway
  // waited for this very workflow to finish.
  const waited = await waitForExpectedDeployment({ token: 'project-token-secret', expected, expectedSha: SHA, fetchImpl, waitSeconds: 900, pollSeconds: 60 });
  assert.ok(Date.now() - started < 5000, 'returned without sleeping');
  assert.equal(waited.reason, 'DEPLOYMENT_HELD_BY_WAIT_FOR_CI');
  assert.equal(waited.deployment.status, 'WAITING');
  assert.equal(calls.length, 2, 'exactly one schema read and one state read');
});

const loadJson = async path => (path.endsWith('service-settings.json')
  ? { plane: 'agent-control-plane', source: { repo: 'a91453/mml-tools', branch: 'main', rootDirectory: '.' },
    build: { dockerfilePath: 'railway/Dockerfile', watchPatterns: ['/server/mcp.mjs', '/server/studio-agent-driver.mjs', '/server/studio-agent-codex.mjs'] },
    deploy: { startCommand: 'node railway/server.mjs', healthcheckPath: '/healthz', healthcheckTimeout: 60, restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 3, numReplicas: 1 } }
  : { projectName: 'mml-tools-allen', environmentName: 'production', serviceName: 'mml-tools',
    publicOrigin: 'https://mml-tools-production.up.railway.app', githubSource: 'a91453/mml-tools', githubBranch: 'main' });

test('the gate reads once and releases the audit only for a released deployment', async () => {
  const expected = resolved();
  for (const [status, action] of [['WAITING', 'DEFER'], [null, 'DEFER'], ['BUILDING', 'AUDIT'], ['DEPLOYING', 'AUDIT'], ['SUCCESS', 'AUDIT']]) {
    const { fetchImpl, calls } = railwayFetch(expected, status);
    const gate = await runAuditGate({ token: 'project-token-secret', expectedSha: SHA, fetchImpl, loadJson });
    assert.equal(gate.action, action, String(status));
    assert.equal(calls.length, 4, 'target resolution, then one read, no polling');
    assert.match(calls[0], /RailwayTargetScope/);
    assert.match(calls[1], /RailwayTargetNames/);
  }
});

// ─── Railway IDs are resolved from names at run time ───────────────────────
//
// The repository is public: railway/deployment-target.json names the project,
// environment and service, and the IDs come from the project token's own scope,
// proven by name. Every mismatch fails closed; no repository ID is a fallback.

function targetFetch(target = {}) {
  const calls = [];
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body);
    calls.push(body);
    assert.doesNotMatch(body.query, /mutation\s/i);
    const data = targetData(body.query, target);
    assert.ok(data, 'only target-resolution reads are expected');
    return reply(data);
  };
  return { fetchImpl, calls };
}

test('the tracked deployment target names Railway resources and carries no Railway ID', () => {
  const read = path => JSON.parse(readFileSync(new URL('../' + path, import.meta.url), 'utf8'));
  const target = read('railway/deployment-target.json');
  const ids = [];
  const walk = (value, path) => {
    if (typeof value === 'string' && UUID_SHAPE.test(value)) ids.push(path);
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (/(^id$|Id$)/.test(key)) ids.push(`${path}.${key}`);
        walk(child, `${path}.${key}`);
      }
    }
  };
  walk(target, '$');
  assert.deepEqual(ids, []);
  const expected = expectedProductionConfig(read('railway/service-settings.json'), target);
  assert.deepEqual([expected.projectName, expected.environmentName, expected.serviceName],
    ['mml-tools-allen', 'production', 'mml-tools']);
  for (const field of ['projectId', 'environmentId', 'serviceId']) assert.equal(field in expected, false, field);
});

test('a deployment target without all three names fails closed', () => {
  const settings = {
    plane: 'agent-control-plane', source: { repo: 'r', branch: 'main', rootDirectory: '.' },
    build: { dockerfilePath: 'railway/Dockerfile', watchPatterns: ['/a'] }, deploy: {},
  };
  const target = { projectName: 'p', environmentName: 'production', serviceName: 's', githubSource: 'r', githubBranch: 'main' };
  for (const field of ['projectName', 'environmentName', 'serviceName']) {
    assert.throws(() => expectedProductionConfig(settings, { ...target, [field]: undefined }), new RegExp(field));
    assert.throws(() => expectedProductionConfig(settings, { ...target, [field]: '' }), new RegExp(field));
  }
});

test('resolveProductionTarget takes the IDs from the token scope once the names match', async () => {
  const { fetchImpl, calls } = targetFetch();
  // An ID left in the target by mistake is never used.
  const stale = { ...desired(), projectId: 'repository-id', environmentId: 'repository-id', serviceId: 'repository-id' };
  const target = await resolveProductionTarget({ token: 'project-token-secret', expected: stale, fetchImpl });
  assert.deepEqual(target, resolved());
  assert.equal(calls.length, 2);
  assert.match(calls[0].query, /projectToken\s*\{\s*projectId\s+environmentId\s*\}/);
  assert.match(calls[1].query, /project\(id: \$projectId\)/);
  assert.match(calls[1].query, /environment\(id: \$environmentId\)/);
  assert.deepEqual(calls[1].variables, { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID });
});

test('resolveProductionTarget fails closed on any project, environment or service mismatch', async () => {
  const cases = [
    [{ projectName: 'someone-elses-project' }, /belongs to a different project/],
    [{ environmentName: 'staging' }, /belongs to a different environment/],
    [{ services: [{ id: SERVICE_ID, name: 'mml-tools-preview' }] }, /exactly one Railway service named mml-tools, found 0/],
    [{ services: [] }, /exactly one Railway service named mml-tools, found 0/],
    [{ services: [{ id: SERVICE_ID, name: 'mml-tools' }, { id: '55555555-5555-4555-8555-555555555555', name: 'mml-tools' }] },
      /exactly one Railway service named mml-tools, found 2/],
    [{ services: [{ id: '', name: 'mml-tools' }] }, /service id unavailable/],
    [{ scope: null }, /token scope unavailable/],
    [{ scope: { projectId: PROJECT_ID, environmentId: null } }, /token scope unavailable/],
  ];
  for (const [target, message] of cases) {
    const { fetchImpl } = targetFetch(target);
    await assert.rejects(
      resolveProductionTarget({ token: 'project-token-secret', expected: desired(), fetchImpl }),
      error => {
        assert.match(error.message, message);
        assert.equal(error.code, TARGET_MISMATCH);
        return true;
      },
      JSON.stringify(target),
    );
  }
});

test('resolveProductionTarget refuses expected config without names before reading Railway', async () => {
  const { fetchImpl, calls } = targetFetch();
  await assert.rejects(
    resolveProductionTarget({ token: 'project-token-secret', expected: { ...desired(), environmentName: undefined }, fetchImpl }),
    /expected environmentName required/,
  );
  assert.equal(calls.length, 0);
});

test('the gate releases a target mismatch to the audit job and lets a failed read defer', async () => {
  const { fetchImpl, calls } = railwayFetch(resolved(), 'WAITING', { projectName: 'someone-elses-project' });
  const gate = await runAuditGate({ token: 'project-token-secret', expectedSha: SHA, fetchImpl, loadJson });
  assert.deepEqual(gate, { action: 'AUDIT', reason: 'TARGET_MISMATCH', status: null, deployment_id: null });
  assert.equal(calls.length, 2, 'no deployment read for the wrong target');

  const failing = async () => ({ ok: false, status: 503, async json() { return {}; } });
  await assert.rejects(runAuditGate({ token: 'project-token-secret', expectedSha: SHA, fetchImpl: failing, loadJson }), /HTTP 503/);
});

test('the audit reports a target mismatch as a failure and reads no deployment state', async () => {
  const { fetchImpl, calls } = railwayFetch(resolved(), 'SUCCESS', { environmentName: 'staging' });
  const report = await runProductionAudit({
    token: 'project-token-secret', expectedSha: SHA, manifestCommit: SHA, fetchImpl, loadJson, waitSeconds: 0,
  });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.control_plane.status, 'NOT_RUN');
  assert.equal(report.failure.code, TARGET_MISMATCH);
  assert.match(report.failure.message, /different environment/);
  assert.deepEqual([report.expected.project_id, report.expected.environment_id, report.expected.service_id], [null, null, null]);
  assert.equal(calls.length, 2);
});
