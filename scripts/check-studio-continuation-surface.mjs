// Compare an explicitly captured client tool list with this checkout's server.
// No network, credentials, model calls, mutation or deployment.
import { readFileSync } from 'node:fs';
import { STUDIO_MCP_TOOLS } from '../server/mcp-studio.mjs';
import { compareContinuationSurface } from '../server/continuation-surface.mjs';
try {
  if (process.argv.length > 3) throw Error('Usage: node scripts/check-studio-continuation-surface.mjs [observed-client-tools.json]');
  const captured = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : null;
  const report = compareContinuationSurface(STUDIO_MCP_TOOLS, captured?.tools ?? captured);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'DISCOVERY_MATCH' ? 0 : 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
