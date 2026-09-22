// Discovery evidence only. Never reports workflow completion or a Canonical PASS.
export const CONTINUATION_REQUIRED_TOOLS = Object.freeze([
  'studio_capabilities', 'studio_project_get', 'studio_baseline_events',
  'studio_run_plan', 'studio_run_start', 'studio_run_status', 'studio_run_next', 'studio_run_resume',
  'studio_proposal_targets', 'studio_proposal_submit', 'studio_proposal_status', 'studio_proposal_resolve',
  'studio_artifact_get',
]);
const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions']);
// Strip schema annotations, not actual input properties named title/description.
const semantic = (value, propertyMap = false) => Array.isArray(value) ? value.map(item => semantic(item))
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
    .filter(key => propertyMap || !['title', 'description', '$comment'].includes(key))
    .map(key => [key, key === 'required' && !propertyMap && Array.isArray(value[key])
      ? [...value[key]].sort() : semantic(value[key], !propertyMap && schemaMaps.has(key))])) : value;
const tools = value => {
  if (!Array.isArray(value) || value.some(tool => typeof tool !== 'string' && (!tool || typeof tool.name !== 'string'))) {
    throw new TypeError('Expected an observed tool array (names or tool definitions)');
  }
  const map = new Map(value.map(tool => [typeof tool === 'string' ? tool : tool.name, tool]));
  if (map.size !== value.length) throw new TypeError('Duplicate tool names');
  return map;
};
export function compareContinuationSurface(serverTools, observedClientTools = null) {
  const server = tools(serverTools);
  const client = observedClientTools === null ? null : tools(observedClientTools);
  const serverMissing = CONTINUATION_REQUIRED_TOOLS.filter(name => !server.has(name));
  const clientMissing = client === null ? null : CONTINUATION_REQUIRED_TOOLS.filter(name => !client.has(name));
  const schemaUnknown = [], schemaMismatches = [];
  if (client) for (const name of CONTINUATION_REQUIRED_TOOLS) {
    if (!server.has(name) || !client.has(name)) continue;
    const a = server.get(name)?.inputSchema, b = client.get(name)?.inputSchema;
    if (!a || !b) schemaUnknown.push(name);
    else if (JSON.stringify(semantic(a)) !== JSON.stringify(semantic(b))) schemaMismatches.push(name);
  }
  return {
    required_tools: [...CONTINUATION_REQUIRED_TOOLS], server_missing: serverMissing,
    client_missing: clientMissing, schema_unknown: schemaUnknown, schema_mismatches: schemaMismatches,
    status: serverMissing.length ? 'SERVER_TOOLS_MISSING'
      : client === null ? 'CLIENT_EXPOSURE_UNVERIFIED'
      : clientMissing.length ? 'CLIENT_TOOLS_MISSING'
      : schemaMismatches.length ? 'CLIENT_SCHEMA_MISMATCH'
      : schemaUnknown.length ? 'CLIENT_SCHEMAS_UNVERIFIED' : 'DISCOVERY_MATCH',
    behavioral_e2e: 'NOT_RUN',
    notice: 'An observed discovery match is not authorization, execution, continuation E2E or a Canonical PASS. Do not substitute server tools/list for the conversation client tool list.',
  };
}
