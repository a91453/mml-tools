import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildControlPlaneResult,
  classifyAuditGate,
  compareServiceInstance,
  expectedProductionConfig,
  findExpectedDeployment,
  railwayGraphQL,
  readProductionState,
  resolveDeploymentBinding,
  runAuditGate,
  waitForExpectedDeployment,
  watchedChangedPaths,
} from '../scripts/railway-production-audit.mjs';

const SHA = 'a'.repeat(40);

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
    projectId: 'project-1',
    environmentId: 'env-1',
    serviceId: 'service-1',
    projectName: 'mml-tools-allen',
    serviceName: 'mml-tools',
    publicOrigin: 'https://mml-tools-production.up.railway.app',
    githubSource: 'a91453/mml-tools',
    githubBranch: 'main',
  });
}

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
  assert.equal(expected.projectId, 'project-1');
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
  const expected = desired();
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
  const expected = desired();
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
  const expected = desired();
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
  const expected = desired();
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
  const expected = desired();
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

function railwayFetch(expected, deploymentStatus) {
  const calls = [];
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body);
    calls.push(body.query);
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
  const expected = desired();
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

test('the gate reads once and releases the audit only for a released deployment', async () => {
  const expected = desired();
  const loadJson = async path => (path.endsWith('service-settings.json')
    ? { plane: 'agent-control-plane', source: { repo: 'a91453/mml-tools', branch: 'main', rootDirectory: '.' },
      build: { dockerfilePath: 'railway/Dockerfile', watchPatterns: ['/server/mcp.mjs', '/server/studio-agent-driver.mjs', '/server/studio-agent-codex.mjs'] },
      deploy: { startCommand: 'node railway/server.mjs', healthcheckPath: '/healthz', healthcheckTimeout: 60, restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 3, numReplicas: 1 } }
    : { projectId: expected.projectId, environmentId: expected.environmentId, serviceId: expected.serviceId,
      projectName: 'mml-tools-allen', serviceName: 'mml-tools', publicOrigin: expected.publicOrigin,
      githubSource: 'a91453/mml-tools', githubBranch: 'main' });
  for (const [status, action] of [['WAITING', 'DEFER'], [null, 'DEFER'], ['BUILDING', 'AUDIT'], ['DEPLOYING', 'AUDIT'], ['SUCCESS', 'AUDIT']]) {
    const { fetchImpl, calls } = railwayFetch(expected, status);
    const gate = await runAuditGate({ token: 'project-token-secret', expectedSha: SHA, fetchImpl, loadJson });
    assert.equal(gate.action, action, String(status));
    assert.equal(calls.length, 2, 'one read, no polling');
  }
});
