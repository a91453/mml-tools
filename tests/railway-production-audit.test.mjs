import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildControlPlaneResult,
  compareServiceInstance,
  expectedProductionConfig,
  findExpectedDeployment,
  railwayGraphQL,
  readProductionState,
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
            serviceInstance: { ...live(), latestDeployment: { id: 'dep-1', status: 'SUCCESS', createdAt: '2026-09-21T00:00:00Z' } },
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
