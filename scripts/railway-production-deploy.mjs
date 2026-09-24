// Explicit, bounded recovery for a Railway production deployment that was
// skipped after a transient CI failure. This deploys only the exact current
// origin/main SHA of the already-connected repository; it never uses Railway Agent.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  compareServiceInstance,
  expectedProductionConfig,
  findExpectedDeployment,
  LIVE_DEPLOYMENT_STATES,
  railwayGraphQL,
  readProductionState,
  resolveProductionTarget,
  saveAudit,
} from './railway-production-audit.mjs';

export const DEPLOY_CONFIRMATION = 'DEPLOY_CURRENT_MAIN_SHA';

const defaultGitImpl = args => execFileSync('git', args, {
  cwd: new URL('../', import.meta.url),
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 30000,
  maxBuffer: 8 * 1024 * 1024,
});

export function exactCurrentMainSha(gitImpl = defaultGitImpl) {
  const head = gitImpl(['rev-parse', 'HEAD']).toString('utf8').trim();
  const main = gitImpl(['rev-parse', 'refs/remotes/origin/main']).toString('utf8').trim();
  assert.match(head, /^[0-9a-f]{40}$/, 'full checkout HEAD required');
  assert.match(main, /^[0-9a-f]{40}$/, 'full origin/main SHA required');
  assert.equal(head, main, 'production deploy checkout must equal refs/remotes/origin/main exactly');
  return head;
}

export async function deployExactCurrentMain({
  token,
  expectedSha,
  loadJson = async path => JSON.parse(await readFile(path, 'utf8')),
  readState = readProductionState,
  graphQL = railwayGraphQL,
}) {
  assert.match(expectedSha ?? '', /^[0-9a-f]{40}$/, 'full expected main SHA required');
  const [serviceSettings, deploymentTarget] = await Promise.all([
    loadJson(resolve('railway/service-settings.json')),
    loadJson(resolve('railway/deployment-target.json')),
  ]);
  const expected = await resolveProductionTarget({
    token, expected: expectedProductionConfig(serviceSettings, deploymentTarget), graphQL,
  });
  const state = await readState({ token, expected });

  assert.deepEqual(state.missingSchemaFields, [], 'Railway schema drift blocks production deploy');
  assert.deepEqual(state.tokenScope, {
    projectId: expected.projectId,
    environmentId: expected.environmentId,
  }, 'Railway project token scope mismatch');
  const drift = compareServiceInstance(expected, state.instance, state.availableFields);
  assert.deepEqual(drift, [], 'Railway config drift blocks exact-main production deploy');

  const existing = findExpectedDeployment(state.deployments, expectedSha);
  const active = state.instance?.latestDeployment;
  if (LIVE_DEPLOYMENT_STATES.has(existing?.status) && active?.id === existing.id && LIVE_DEPLOYMENT_STATES.has(active?.status)) {
    return {
      status: 'NOOP',
      deployment_id: existing.id,
      commit_sha: expectedSha,
      note: 'The exact current main SHA is already the active successful production deployment.',
    };
  }

  if (existing && !['SKIPPED', 'FAILED', 'CRASHED', 'REMOVED'].includes(existing.status)) {
    return {
      status: 'IN_PROGRESS',
      deployment_id: existing.id,
      commit_sha: expectedSha,
      observed_status: existing.status,
      note: 'A deployment for the exact current main SHA already exists and is not terminally recoverable; no duplicate was requested.',
    };
  }

  const data = await graphQL({
    token,
    variables: {
      serviceId: expected.serviceId,
      environmentId: expected.environmentId,
      commitSha: expectedSha,
    },
    query: `mutation DeployExactCurrentMain(
      $serviceId: String!,
      $environmentId: String!,
      $commitSha: String!
    ) {
      serviceInstanceDeployV2(
        serviceId: $serviceId,
        environmentId: $environmentId,
        commitSha: $commitSha
      )
    }`,
  });
  const deploymentId = data.serviceInstanceDeployV2;
  assert.ok(typeof deploymentId === 'string' && deploymentId.length > 0, 'Railway deploy mutation returned no deployment id');
  return {
    status: 'REQUESTED',
    deployment_id: deploymentId,
    commit_sha: expectedSha,
    recovered_from: existing?.status ?? null,
    note: 'Exact-main deployment requested. Railway Wait for CI and the service healthcheck remain authoritative; this command does not wait for completion.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    confirm: { type: 'string' },
    out: { type: 'string' },
  } });
  if (values.confirm !== DEPLOY_CONFIRMATION) throw Error(`--confirm must equal ${DEPLOY_CONFIRMATION}`);
  if (!values.out) throw Error('--out is required');
  const expectedSha = exactCurrentMainSha();
  const receipt = await deployExactCurrentMain({
    token: process.env.RAILWAY_PROJECT_TOKEN,
    expectedSha,
  });
  await saveAudit(values.out, {
    schema_version: 1,
    scope: 'Exact current main SHA Railway production deploy request; no Railway Agent, no source/config/secret/domain/volume mutation',
    observed_at: new Date().toISOString(),
    ...receipt,
  });
  console.log(JSON.stringify({
    status: receipt.status,
    deployment_id: receipt.deployment_id,
    commit_sha: receipt.commit_sha,
  }));
}
