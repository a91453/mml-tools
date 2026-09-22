// Discovery evidence only. Never reports workflow completion or a Canonical PASS.
export const CONTINUATION_REQUIRED_TOOLS = Object.freeze([
  'studio_capabilities', 'studio_project_get', 'studio_baseline_events',
  'studio_run_plan', 'studio_run_start', 'studio_run_status', 'studio_run_next', 'studio_run_resume',
  'studio_proposal_targets', 'studio_proposal_submit', 'studio_proposal_status', 'studio_proposal_resolve',
  'studio_artifact_get',
]);
const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const schemaLists = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const schemaValues = new Set(['items', 'additionalItems', 'additionalProperties', 'unevaluatedProperties',
  'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema']);
const annotations = new Set(['title', 'description', '$comment']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Literal data (const/enum/default/unknown vocabulary) keeps every key. A
// literal property named "description" is not a JSON Schema annotation.
const ordered = value => Array.isArray(value) ? value.map(ordered)
  : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
// Traverse only positions known to contain schemas. This is a conservative
// structural comparison, not a claim to decide arbitrary schema equivalence.
const semantic = value => !isObject(value) ? ordered(value)
  : Object.fromEntries(Object.keys(value).sort().filter(key => !annotations.has(key)).map(key => {
    const child = value[key];
    if (schemaMaps.has(key) && isObject(child)) {
      return [key, Object.fromEntries(Object.keys(child).sort().map(name => [name, semantic(child[name])]))];
    }
    if (schemaLists.has(key) && Array.isArray(child)) return [key, child.map(semantic)];
    if (schemaValues.has(key)) return [key, Array.isArray(child) ? child.map(semantic) : semantic(child)];
    if (key === 'required' && Array.isArray(child)) return [key, [...child].sort()];
    return [key, ordered(child)];
  }));
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
