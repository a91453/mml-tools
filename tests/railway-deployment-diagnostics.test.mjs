import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectDeploymentDiagnostics,
  sanitizeLogMessage,
  sanitizeLogs,
  selectDeployment,
} from '../scripts/railway-deployment-diagnostics.mjs';

const FAILED_ID = '11111111-2222-3333-4444-555555555555';
const SUCCESS_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
// Obviously fake Railway IDs, returned by the mocked target resolution below.
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ENVIRONMENT_ID = '22222222-2222-4222-8222-222222222222';
const SERVICE_ID = '33333333-3333-4333-8333-333333333333';

test('diagnostic log sanitizer removes common credential shapes and flattens lines', () => {
  const input = [
    'Authorization: Bearer abc.def.ghi',
    ' MML_OWNER_PASSWORD=super-secret',
    ' url=https://user:pass@example.test/path',
    ' token=railway_abcdefghijklmnopqrstuvwxyz',
    ' github_pat_abcdefghijklmnopqrstuvwxyz123456',
  ].join('\n');
  const output = sanitizeLogMessage(input);
  assert.doesNotMatch(output, /abc\.def\.ghi/);
  assert.doesNotMatch(output, /super-secret/);
  assert.doesNotMatch(output, /user:pass/);
  assert.doesNotMatch(output, /railway_abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(output, /github_pat_/);
  assert.doesNotMatch(output, /[\r\n]/);
  assert.match(output, /\[REDACTED\]/);
});

test('diagnostic log sanitizer is bounded', () => {
  assert.equal(sanitizeLogMessage('x'.repeat(3000)).length, 2000);
  const entries = Array.from({ length: 250 }, (_, i) => ({
    timestamp: String(i), severity: 'info', message: 'line ' + i,
  }));
  assert.equal(sanitizeLogs(entries).length, 200);
});

test('diagnostics accept only a failed or crashed deployment in the selected service history', () => {
  const deployments = [
    { id: FAILED_ID, status: 'FAILED' },
    { id: SUCCESS_ID, status: 'SUCCESS' },
  ];
  assert.equal(selectDeployment(deployments, FAILED_ID).status, 'FAILED');
  assert.throws(() => selectDeployment(deployments, SUCCESS_ID), /FAILED\/CRASHED/);
  assert.throws(
    () => selectDeployment(deployments, '99999999-2222-3333-4444-555555555555'),
    /configured production service history/,
  );
  assert.throws(() => selectDeployment(deployments, 'not-an-id'), /valid Railway deployment UUID/);
});

const loadJson = async path => (String(path).endsWith('service-settings.json')
  ? {
      plane: 'agent-control-plane',
      source: { repo: 'a91453/mml-tools', branch: 'main', rootDirectory: '.' },
      build: { dockerfilePath: 'railway/Dockerfile', watchPatterns: ['/railway/server.mjs'] },
      deploy: {},
    }
  : {
      projectName: 'mml-tools-allen', environmentName: 'production', serviceName: 'mml-tools',
      githubSource: 'a91453/mml-tools', githubBranch: 'main', publicOrigin: 'https://example.invalid',
    });

// Railway mock: target resolution by name, the membership read and the logs.
function railwayFetch({ serviceName = 'mml-tools' } = {}) {
  const requests = [];
  const fetchImpl = async (_url, request) => {
    const { query, variables } = JSON.parse(request.body);
    requests.push({ query, variables });
    let data;
    if (query.includes('RailwayTargetScope')) data = { projectToken: { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID } };
    else if (query.includes('RailwayTargetNames')) data = {
      project: { name: 'mml-tools-allen', services: { edges: [{ node: { id: SERVICE_ID, name: serviceName } }] } },
      environment: { name: 'production' },
    };
    else if (query.includes('RailwayDiagnosticMembership')) data = {
      projectToken: { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID },
      deployments: { edges: [{ node: { id: FAILED_ID, status: 'FAILED', createdAt: '2026-09-21T00:00:00Z', meta: {} } }] },
    };
    else data = { buildLogs: [{ timestamp: 't', severity: 'error', message: 'TOKEN=secret' }], deploymentLogs: [] };
    return { ok: true, status: 200, async json() { return { data }; } };
  };
  return { fetchImpl, requests };
}

test('diagnostics read only the deployment history of the service resolved by name', async () => {
  const { fetchImpl, requests } = railwayFetch();
  const report = await collectDeploymentDiagnostics({ token: 'test-token', deploymentId: FAILED_ID, fetchImpl, loadJson });
  assert.deepEqual([report.project_id, report.environment_id, report.service_id], [PROJECT_ID, ENVIRONMENT_ID, SERVICE_ID]);
  const membership = requests.find(request => request.query.includes('RailwayDiagnosticMembership'));
  assert.deepEqual(membership.variables.input, { projectId: PROJECT_ID, serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID });
  assert.equal(report.deployment.id, FAILED_ID);
  assert.doesNotMatch(report.build_logs[0].message, /secret/);
});

test('diagnostics fail closed when the named service is missing, before reading any logs', async () => {
  const { fetchImpl, requests } = railwayFetch({ serviceName: 'mml-tools-renamed' });
  await assert.rejects(
    collectDeploymentDiagnostics({ token: 'test-token', deploymentId: FAILED_ID, fetchImpl, loadJson }),
    /exactly one Railway service named mml-tools, found 0/,
  );
  assert.equal(requests.length, 2, 'only the two target-resolution reads');
});
