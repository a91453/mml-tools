// Fixed-module packaging for the legacy Sites gateway, not a new validator.
// Node/Railway wires a real Published Canonical gate and Application Service.
// A single-file Sites artifact has neither Git history nor durable storage:
// reuse the existing technical service's explicit fail-closed path instead of
// embedding stale rules, importing Node services, or falling back to legacy.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const sitesNotice = 'CANONICAL_NOT_LOADED: this single-file Sites artifact has no Published Git history or Studio storage. Canonical validation and uploads require the separately configured Railway service. No legacy fallback is allowed.';

// These modules use named static imports/exports only. This intentionally
// bounded packager rejects any new dependency or unsupported syntax; it does
// not guess module resolution or evaluate source while building.
async function scope(root, path, name, dependencies, exports) {
  let source = await readFile(resolve(root, path), 'utf8');
  source = source.replace(/^import\s*\{([^}]+)\}\s*from\s*(['"])([^'"\n]+)\2\s*;[ \t]*(?:\r?\n|$)/gm,
    (_, bindings, _quote, specifier) => {
      if (!Object.hasOwn(dependencies, specifier)) throw Error(`Unmapped Sites import in ${path}: ${specifier}`);
      const names = bindings.split(',').map(value => value.trim()).filter(Boolean).map(binding => {
        if (!/^[A-Za-z_$][\w$]*(?:\s+as\s+[A-Za-z_$][\w$]*)?$/.test(binding)) throw Error(`Unsupported Sites binding in ${path}`);
        return binding.replace(/\s+as\s+/, ': ');
      });
      return `const { ${names.join(', ')} } = ${dependencies[specifier]};\n`;
    });
  if (/^\s*import\s/m.test(source) || /\bimport\s*\(/.test(source)) throw Error(`Unsupported Sites import syntax in ${path}`);
  for (const exported of exports) {
    const declaration = new RegExp(`^export\\s+(?:async\\s+)?(?:const|let|class|function)\\s+${exported}\\b`, 'm');
    if (!declaration.test(source)) throw Error(`Missing Sites export in ${path}: ${exported}`);
  }
  source = source.replace(/^export\s+(?=(?:async\s+)?(?:const|let|class|function)\b)/gm, '');
  if (/^\s*export\s/m.test(source)) throw Error(`Unsupported Sites export syntax in ${path}`);
  return `const ${name} = (() => {\n${source}\nreturn Object.freeze({ ${exports.join(', ')} });\n})();\n`;
}

export async function bundleSitesWorker(root, assets) {
  const parts = [];
  parts.push(await scope(root, 'dist/core.js', 'sitesCore', {}, ['VERSION', 'PROFILE', 'ROLES', 'secondsAt', 'validateMML']));
  parts.push(await scope(root, 'studio/backend/application/contracts.mjs', 'sitesContracts', {}, ['ERROR_CODES', 'StudioApplicationError', 'fail']));
  parts.push(await scope(root, 'studio/backend/application/technical-service.mjs', 'sitesTechnical', {
    '../../../dist/core.js': 'sitesCore', './contracts.mjs': 'sitesContracts',
  }, ['createTechnicalService']));
  // createTechnicalService already refuses Canonical operations when its gate
  // is null. This adapter supplies no rule identity, fake snapshot or verifier.
  // The listening player (studio_listen and its UI resource) is advertised only
  // with an attached Studio, which Sites never has; these are its inert stand-ins.
  parts.push(`const sitesEnvironment = Object.freeze({\ncreateCanonicalGate: () => null,\nSTUDIO_MCP_TOOLS: Object.freeze([]),\nUPLOAD_INSTRUCTION: ${JSON.stringify(sitesNotice)},\nrunStudioTool: () => { throw new Error('Studio is unavailable in Sites'); },\nDEFAULT_LISTEN_CONFIG: null,\nLISTEN_MCP_TOOLS: Object.freeze([]),\nLISTEN_TOOL_NAME: 'studio_listen',\nlistenResources: () => [],\nreadListenResource: () => null,\nrunListenTool: () => { throw new Error('Studio is unavailable in Sites'); }\n});\n`);
  parts.push(await scope(root, 'server/mcp.mjs', 'sitesMcp', {
    '../dist/core.js': 'sitesCore',
    '../studio/backend/application/technical-service.mjs': 'sitesTechnical',
    '../studio/backend/application/contracts.mjs': 'sitesContracts',
    '../studio/backend/application/provenance.mjs': 'sitesEnvironment',
    './mcp-studio.mjs': 'sitesEnvironment',
    './mcp-listen.mjs': 'sitesEnvironment',
  }, ['handleMcp', 'SERVICE_VERSION']));
  parts.push(await scope(root, 'server/worker.mjs', 'sitesWorker', { './mcp.mjs': 'sitesMcp' }, ['createWorker']));
  parts.push(`const bundledAssets = ${JSON.stringify(assets)};\nexport default sitesWorker.createWorker(bundledAssets);\n`);
  return parts.join('\n');
}
