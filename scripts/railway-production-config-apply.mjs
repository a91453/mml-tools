// Explicit, bounded Railway desired-state application.
// This is the write-side companion to railway-production-audit.mjs.
// It updates only an allowlisted subset of ServiceInstance settings, never
// secrets, variables, domains, volumes, source connection, replicas or deploys.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  compareServiceInstance,
  expectedProductionConfig,
  railwayGraphQL,
  readProductionState,
  resolveProductionTarget,
  saveAudit,
} from './railway-production-audit.mjs';

export const APPLY_CONFIRMATION = 'APPLY_REPOSITORY_DESIRED_STATE';
export const MUTABLE_SERVICE_FIELDS = Object.freeze([
  'startCommand',
  'healthcheckPath',
  'healthcheckTimeout',
  'restartPolicyType',
  'restartPolicyMaxRetries',
  'rootDirectory',
  'dockerfilePath',
  'watchPatterns',
]);

export function mutableUpdateInput(expected, drift) {
  const allowed = new Set(MUTABLE_SERVICE_FIELDS);
  const unsupported = drift.filter(item => !allowed.has(item.field));
  assert.deepEqual(unsupported, [], 'unsupported Railway drift requires explicit operator handling');
  return Object.fromEntries(drift.map(item => [item.field, expected.config[item.field]]));
}

export async function applyRepositoryDesiredConfig({
  token,
  fetchImpl = fetch,
  loadJson = async path => JSON.parse(await readFile(path, 'utf8')),
}) {
  const [serviceSettings, deploymentTarget] = await Promise.all([
    loadJson(resolve('railway/service-settings.json')),
    loadJson(resolve('railway/deployment-target.json')),
  ]);
  const expected = await resolveProductionTarget({
    token, expected: expectedProductionConfig(serviceSettings, deploymentTarget), fetchImpl,
  });
  const before = await readProductionState({ token, expected, fetchImpl });
  assert.deepEqual(before.missingSchemaFields, [], 'Railway schema drift blocks config apply');
  assert.deepEqual(before.tokenScope, {
    projectId: expected.projectId,
    environmentId: expected.environmentId,
  }, 'Railway project token scope mismatch');
  const beforeDrift = compareServiceInstance(expected, before.instance, before.availableFields);
  if (beforeDrift.length === 0) {
    return {
      status: 'NOOP',
      project_id: expected.projectId,
      environment_id: expected.environmentId,
      service_id: expected.serviceId,
      changed_fields: [],
      before_drift: [],
      after_drift: [],
      note: 'Live mutable settings already match repository desired state. No Railway mutation was sent.',
    };
  }
  const input = mutableUpdateInput(expected, beforeDrift);
  await railwayGraphQL({
    token,
    fetchImpl,
    variables: {
      serviceId: expected.serviceId,
      environmentId: expected.environmentId,
      input,
    },
    query: `mutation ApplyRailwayRepositoryDesiredState(
      $serviceId: String!,
      $environmentId: String!,
      $input: ServiceInstanceUpdateInput!
    ) {
      serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
    }`,
  });
  const after = await readProductionState({ token, expected, fetchImpl });
  assert.deepEqual(after.missingSchemaFields, [], 'Railway schema drift after config apply');
  const afterDrift = compareServiceInstance(expected, after.instance, after.availableFields);
  assert.deepEqual(afterDrift, [], 'Railway config apply did not converge to repository desired state');
  return {
    status: 'APPLIED',
    project_id: expected.projectId,
    environment_id: expected.environmentId,
    service_id: expected.serviceId,
    changed_fields: Object.keys(input).sort(),
    before_drift: beforeDrift,
    after_drift: afterDrift,
    note: 'No deployment was requested. Settings that require a deployment take effect through the existing reviewed deployment path.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    confirm: { type: 'string' },
    out: { type: 'string' },
  } });
  if (values.confirm !== APPLY_CONFIRMATION) throw Error(`--confirm must equal ${APPLY_CONFIRMATION}`);
  if (!values.out) throw Error('--out is required');
  const receipt = await applyRepositoryDesiredConfig({
    token: process.env.RAILWAY_PROJECT_TOKEN,
  });
  await saveAudit(values.out, {
    schema_version: 1,
    scope: 'Bounded Railway ServiceInstance desired-state apply; no secrets/domains/volumes/source/scaling/deploy',
    observed_at: new Date().toISOString(),
    ...receipt,
  });
  console.log(JSON.stringify({ status: receipt.status, changed_fields: receipt.changed_fields }));
}
