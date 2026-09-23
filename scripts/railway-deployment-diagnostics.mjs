// Bounded diagnostics for a failed Railway production deployment.
// Reads build/runtime logs only after proving the deployment belongs to the
// configured production service. HTTP request logs, variables and service
// secrets are deliberately out of scope.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  expectedProductionConfig,
  railwayGraphQL,
  resolveProductionTarget,
  saveAudit,
} from './railway-production-audit.mjs';

export const DIAGNOSTIC_STATES = new Set(['FAILED', 'CRASHED']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[:=]\s*([^\s,;]+)/gi;
const BEARER = /\bBearer\s+[^\s]+/gi;
const URL_USERINFO = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const TOKEN_LIKE = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|railway_[A-Za-z0-9_\-]{16,})\b/g;

export function sanitizeLogMessage(message) {
  let value = String(message ?? '').replace(/[\r\n\0]+/g, ' ');
  value = value.replace(SECRET_ASSIGNMENT, '$1=[REDACTED]');
  value = value.replace(BEARER, 'Bearer [REDACTED]');
  value = value.replace(URL_USERINFO, '$1[REDACTED]@');
  value = value.replace(TOKEN_LIKE, '[REDACTED_TOKEN]');
  return value.slice(0, 2000);
}

export function sanitizeLogs(entries, limit = 200) {
  assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 500);
  return (Array.isArray(entries) ? entries : []).slice(0, limit).map(entry => ({
    timestamp: entry?.timestamp ?? null,
    severity: entry?.severity ?? null,
    message: sanitizeLogMessage(entry?.message),
  }));
}

export function selectDeployment(deployments, deploymentId) {
  assert.match(deploymentId ?? '', UUID, 'valid Railway deployment UUID required');
  const deployment = (deployments ?? []).find(item => item?.id === deploymentId);
  assert.ok(deployment, 'deployment is not in the configured production service history');
  assert.ok(DIAGNOSTIC_STATES.has(deployment.status), 'diagnostics are limited to FAILED/CRASHED deployments');
  return deployment;
}

export async function collectDeploymentDiagnostics({
  token,
  deploymentId,
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
  const membership = await railwayGraphQL({
    token,
    fetchImpl,
    variables: {
      input: {
        projectId: expected.projectId,
        serviceId: expected.serviceId,
        environmentId: expected.environmentId,
      },
    },
    query: `query RailwayDiagnosticMembership($input: DeploymentListInput!) {
      projectToken { projectId environmentId }
      deployments(input: $input, first: 50) {
        edges { node { id status createdAt meta } }
      }
    }`,
  });
  assert.deepEqual(membership.projectToken, {
    projectId: expected.projectId,
    environmentId: expected.environmentId,
  }, 'Railway project token scope mismatch');
  const deployments = membership.deployments?.edges?.map(edge => edge.node) ?? [];
  const deployment = selectDeployment(deployments, deploymentId);
  const logs = await railwayGraphQL({
    token,
    fetchImpl,
    variables: { deploymentId, limit: 200 },
    query: `query RailwayFailedDeploymentLogs($deploymentId: String!, $limit: Int) {
      buildLogs(deploymentId: $deploymentId, limit: $limit) {
        timestamp message severity
      }
      deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
        timestamp message severity
      }
    }`,
  });
  return {
    schema_version: 1,
    scope: 'Failed production deployment build/runtime diagnostics; sanitized, bounded, no HTTP logs or variables',
    observed_at: new Date().toISOString(),
    project_id: expected.projectId,
    environment_id: expected.environmentId,
    service_id: expected.serviceId,
    deployment: {
      id: deployment.id,
      status: deployment.status,
      created_at: deployment.createdAt,
      commit_sha: deployment.meta?.commitHash ?? null,
      branch: deployment.meta?.branch ?? null,
      reason: deployment.meta?.reason ?? null,
    },
    build_logs: sanitizeLogs(logs.buildLogs),
    runtime_logs: sanitizeLogs(logs.deploymentLogs),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    deployment: { type: 'string' },
    out: { type: 'string' },
  } });
  if (!values.deployment || !values.out) throw Error('--deployment and --out are required');
  const report = await collectDeploymentDiagnostics({
    token: process.env.RAILWAY_PROJECT_TOKEN,
    deploymentId: values.deployment,
  });
  await saveAudit(values.out, report);
  console.log(JSON.stringify({
    deployment: report.deployment.id,
    status: report.deployment.status,
    build_lines: report.build_logs.length,
    runtime_lines: report.runtime_logs.length,
  }));
}
