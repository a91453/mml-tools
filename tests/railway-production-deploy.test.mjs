import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEPLOY_CONFIRMATION,
  exactCurrentMainSha,
  deployExactCurrentMain,
} from '../scripts/railway-production-deploy.mjs';

const sha = 'a'.repeat(40);
const old = 'b'.repeat(40);
const expectedJson = path => path.endsWith('service-settings.json')
  ? {
      plane: 'agent-control-plane',
      source: { repo: 'a91453/mml-tools', branch: 'main', rootDirectory: '.' },
      build: { dockerfilePath: 'railway/Dockerfile', watchPatterns: ['/railway/server.mjs'] },
      deploy: {
        startCommand: 'node railway/server.mjs',
        healthcheckPath: '/healthz',
        healthcheckTimeout: 60,
        restartPolicyType: 'ON_FAILURE',
        restartPolicyMaxRetries: 3,
        numReplicas: 1,
      },
      volume: { mountPath: '/data', sizeMB: 5000 },
      port: 3000,
    }
  : {
      projectId: 'project',
      environmentId: 'environment',
      serviceId: 'service',
      githubSource: 'a91453/mml-tools',
      githubBranch: 'main',
      publicOrigin: 'https://example.invalid',
      volumeId: 'volume',
    };

const fields = new Set([
  'source','branch','rootDirectory','builder','dockerfilePath','watchPatterns',
  'startCommand','healthcheckPath','healthcheckTimeout','restartPolicyType',
  'restartPolicyMaxRetries','numReplicas','serviceDomains','volumeMounts',
]);

function state(existing = null) {
  return {
    availableFields: fields,
    missingSchemaFields: [],
    tokenScope: { projectId: 'project', environmentId: 'environment' },
    instance: {
      source: { repo: 'a91453/mml-tools' },
      branch: 'main',
      rootDirectory: '.',
      builder: 'DOCKERFILE',
      dockerfilePath: 'railway/Dockerfile',
      watchPatterns: ['/railway/server.mjs'],
      startCommand: 'node railway/server.mjs',
      healthcheckPath: '/healthz',
      healthcheckTimeout: 60,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 3,
      numReplicas: 1,
      serviceDomains: { 'example.invalid': { port: 3000 } },
      volumeMounts: { volume: { mountPath: '/data' } },
      latestDeployment: existing?.status === 'SUCCESS' ? existing : {
        id: 'old-deploy', status: 'SUCCESS', meta: { commitHash: old, branch: 'main' },
      },
    },
    deployments: existing ? [existing] : [],
  };
}

test('deploy confirmation stays explicit and fixed', () => {
  assert.equal(DEPLOY_CONFIRMATION, 'DEPLOY_CURRENT_MAIN_SHA');
});

test('exactCurrentMainSha refuses a checkout that is not exact origin/main', () => {
  const same = args => Buffer.from(args.includes('HEAD') ? sha : sha);
  assert.equal(exactCurrentMainSha(same), sha);
  const mismatch = args => Buffer.from(args.includes('HEAD') ? sha : old);
  assert.throws(() => exactCurrentMainSha(mismatch), /must equal refs\/remotes\/origin\/main exactly/);
});

test('skipped exact-main deployment is recovered with commit-bound deployV2', async () => {
  const skipped = { id: 'skipped', status: 'SKIPPED', meta: { commitHash: sha, branch: 'main' } };
  let mutation;
  const result = await deployExactCurrentMain({
    token: 'test-token',
    expectedSha: sha,
    loadJson: async path => expectedJson(String(path)),
    readState: async () => state(skipped),
    graphQL: async input => {
      mutation = input;
      return { serviceInstanceDeployV2: 'new-deploy' };
    },
  });
  assert.equal(result.status, 'REQUESTED');
  assert.equal(result.deployment_id, 'new-deploy');
  assert.equal(result.recovered_from, 'SKIPPED');
  assert.equal(mutation.variables.commitSha, sha);
  assert.match(mutation.query, /serviceInstanceDeployV2/);
});

test('active success for exact main is a no-op', async () => {
  const success = { id: 'active', status: 'SUCCESS', meta: { commitHash: sha, branch: 'main' } };
  let called = false;
  const result = await deployExactCurrentMain({
    token: 'test-token',
    expectedSha: sha,
    loadJson: async path => expectedJson(String(path)),
    readState: async () => state(success),
    graphQL: async () => { called = true; return {}; },
  });
  assert.equal(result.status, 'NOOP');
  assert.equal(called, false);
});


test('workflow checkout remains exact-main without unauthenticated refetch', () => {
  const workflow = readFileSync(new URL('../.github/workflows/railway-production-deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /ref:\s*main/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /git rev-parse HEAD/);
  assert.match(workflow, /git rev-parse refs\/remotes\/origin\/main/);
  assert.doesNotMatch(workflow, /git fetch origin main/);
});
