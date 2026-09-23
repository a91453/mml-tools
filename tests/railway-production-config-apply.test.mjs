import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLY_CONFIRMATION,
  MUTABLE_SERVICE_FIELDS,
  applyRepositoryDesiredConfig,
  mutableUpdateInput,
} from '../scripts/railway-production-config-apply.mjs';

// Obviously fake Railway IDs, returned by the mocked target resolution below.
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ENVIRONMENT_ID = '22222222-2222-4222-8222-222222222222';
const SERVICE_ID = '33333333-3333-4333-8333-333333333333';

const expected = {
  config: {
    startCommand: 'node railway/server.mjs',
    healthcheckPath: '/healthz',
    healthcheckTimeout: 60,
    restartPolicyType: 'ON_FAILURE',
    restartPolicyMaxRetries: 3,
    rootDirectory: '.',
    dockerfilePath: 'railway/Dockerfile',
    watchPatterns: ['/a', '/b'],
    numReplicas: 1,
  },
};

test('config apply confirmation remains an explicit fixed phrase', () => {
  assert.equal(APPLY_CONFIRMATION, 'APPLY_REPOSITORY_DESIRED_STATE');
});

test('mutable Railway field allowlist excludes destructive and scaling concerns', () => {
  const fields = new Set(MUTABLE_SERVICE_FIELDS);
  for (const forbidden of ['variables', 'domains', 'volume', 'source', 'repo', 'branch', 'numReplicas', 'region']) {
    assert.equal(fields.has(forbidden), false);
  }
});

test('mutable update input contains only fields that actually drift', () => {
  assert.deepEqual(mutableUpdateInput(expected, [
    { field: 'watchPatterns', expected: ['/a', '/b'], actual: ['/a'] },
    { field: 'healthcheckPath', expected: '/healthz', actual: '/health' },
  ]), {
    watchPatterns: ['/a', '/b'],
    healthcheckPath: '/healthz',
  });
});

test('unsupported drift fails closed instead of silently changing scaling', () => {
  assert.throws(
    () => mutableUpdateInput(expected, [{ field: 'numReplicas', expected: 1, actual: 2 }]),
    /unsupported Railway drift/,
  );
});

const loadJson = async path => (String(path).endsWith('service-settings.json')
  ? {
      plane: 'agent-control-plane',
      source: { repo: 'a91453/mml-tools', branch: 'main', rootDirectory: '.' },
      build: { dockerfilePath: 'railway/Dockerfile', watchPatterns: ['/a', '/b'] },
      deploy: {
        startCommand: 'node railway/server.mjs', healthcheckPath: '/healthz', healthcheckTimeout: 60,
        restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 3, numReplicas: 1,
      },
    }
  : {
      projectName: 'mml-tools-allen', environmentName: 'production', serviceName: 'mml-tools',
      githubSource: 'a91453/mml-tools', githubBranch: 'main', publicOrigin: 'https://example.invalid',
    });

// Railway mock: target resolution by name, then schema and state reads that
// already match the desired config. Records every query it receives.
function railwayFetch({ projectName = 'mml-tools-allen' } = {}) {
  const queries = [];
  const fetchImpl = async (_url, request) => {
    const { query, variables } = JSON.parse(request.body);
    queries.push(query);
    let data;
    if (query.includes('RailwayTargetScope')) data = { projectToken: { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID } };
    else if (query.includes('RailwayTargetNames')) data = {
      project: { name: projectName, services: { edges: [{ node: { id: SERVICE_ID, name: 'mml-tools' } }] } },
      environment: { name: 'production' },
    };
    else if (query.includes('__type')) data = { __type: { fields: [...MUTABLE_SERVICE_FIELDS, 'numReplicas'].map(name => ({ name })) } };
    else {
      assert.doesNotMatch(query, /mutation\s/i);
      assert.deepEqual(variables.input, { projectId: PROJECT_ID, serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID });
      data = {
        projectToken: { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID },
        serviceInstance: { ...expected.config, latestDeployment: null },
        deployments: { edges: [] },
      };
    }
    return { ok: true, status: 200, async json() { return { data }; } };
  };
  return { fetchImpl, queries };
}

test('config apply reads the service resolved by name and sends nothing when settings match', async () => {
  const { fetchImpl, queries } = railwayFetch();
  const receipt = await applyRepositoryDesiredConfig({ token: 'test-token', fetchImpl, loadJson });
  assert.equal(receipt.status, 'NOOP');
  assert.deepEqual([receipt.project_id, receipt.environment_id, receipt.service_id], [PROJECT_ID, ENVIRONMENT_ID, SERVICE_ID]);
  assert.equal(queries.filter(query => /mutation\s/i.test(query)).length, 0);
});

test('config apply fails closed on a token for another project before any read or mutation', async () => {
  const { fetchImpl, queries } = railwayFetch({ projectName: 'someone-elses-project' });
  await assert.rejects(applyRepositoryDesiredConfig({ token: 'test-token', fetchImpl, loadJson }), /belongs to a different project/);
  assert.equal(queries.length, 2, 'only the two target-resolution reads');
});
