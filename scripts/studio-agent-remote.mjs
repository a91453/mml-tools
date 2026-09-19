// HTTP/MCP transport only. No engine, model, acceptance policy or retry loop.
import { createHash } from 'node:crypto';
import { PAGED_REPORT_TOOLS } from '../server/report-page.mjs';

const fail = (code, message, details) => { throw Object.assign(new Error(message), { code, details }); };
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');

export function createRemoteAgentClient({ origin, token, fetchImpl = fetch }) {
  let url;
  try { url = new URL(origin); } catch { fail('REMOTE_CONFIGURATION', 'service-url must be an explicit service origin.'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail('REMOTE_CONFIGURATION', 'Use an HTTPS origin, or a literal loopback HTTP origin, without credentials, path, query or fragment.');
  }
  if (typeof token !== 'string' || !token.length || token.length > 8192 || /\s/.test(token)) {
    fail('REMOTE_CONFIGURATION', 'Supply the existing service OAuth access token through the selected environment variable.');
  }
  const serviceOrigin = url.origin;
  let sequence = 0;
  async function request(path, options) {
    let response, body;
    try {
      response = await fetchImpl(serviceOrigin + path, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(120000),
        headers: { ...options.headers, authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      });
      const reader = response.body?.getReader();
      if (!reader) throw Error('Missing response');
      const chunks = []; let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8 * 1024 * 1024) { await reader.cancel(); throw Error('Response too large'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      body = Buffer.concat(chunks).toString('utf8');
    } catch {
      fail('REMOTE_REQUEST_UNCERTAIN', 'The remote response could not be read. The operation may already have executed; inspect project/run state before retrying. No automatic retry was made.');
    }
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      fail('REMOTE_HTTP_ERROR', 'The service did not return JSON. Check the service endpoint and authentication; inspect state before retrying a write.', { http_status: response.status });
    }
    if (!response.ok) {
      if (parsed?.error && typeof parsed.error === 'object' && parsed.error.code !== undefined) return parsed;
      fail('REMOTE_HTTP_ERROR', 'The service refused this HTTP request. Check authentication and inspect state before retrying a write.', { http_status: response.status });
    }
    return parsed;
  }
  async function rpc(method, params) {
    const id = ++sequence;
    const body = await request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    if (body.jsonrpc !== '2.0' || body.id !== id || (!body.result && !body.error)) fail('REMOTE_PROTOCOL_ERROR', 'Invalid MCP response; inspect state before retrying.');
    return body;
  }
  return {
    origin: serviceOrigin,
    async list() {
      const body = await rpc('tools/list', {});
      if (!Array.isArray(body.result?.tools)) fail('REMOTE_PROTOCOL_ERROR', 'The endpoint did not provide an MCP tool list.');
      return body.result.tools;
    },
    async call(name, args) {
      const body = await rpc('tools/call', { name, arguments: args });
      if (body.error) return { error: body.error };
      const result = body.result.structuredContent;
      if (!result || (body.result.isError && !result.error)) fail('REMOTE_PROTOCOL_ERROR', 'The endpoint did not return a structured operation result.');
      return result;
    },
    async upload(projectId, { kind, filename, bytes, mediaType }) {
      if (!/^prj_[0-9a-f]{32}$/.test(projectId)) fail('REMOTE_CONFIGURATION', 'Invalid project_id.');
      if (bytes.byteLength > 64 * 1024 * 1024) fail('PAYLOAD_TOO_LARGE', 'Asset exceeds the existing 64 MiB upload limit.');
      const form = new FormData();
      form.set('kind', kind);
      form.set('filename', filename);
      form.set('file', new Blob([bytes], { type: mediaType }), filename);
      return request(`/api/v1/projects/${projectId}/assets`, { method: 'POST', body: form });
    },
    async read(name, args, invoke) {
      if (!PAGED_REPORT_TOOLS.has(name) || args.confirmations !== undefined || args.refresh === true || args.report_page !== undefined) {
        fail('REMOTE_CONFIGURATION', 'Complete report reads require an unpaged read-only operation without confirmations or refresh.');
      }
      let offset = 0, expected_sha256, text = '', total;
      do {
        // invoke is the CLI's normal agent/schema-checked dispatch, including
        // on every subsequent read. Mutations never enter this loop.
        const result = await invoke(name, { ...args, report_page: { offset, length: 16000, ...(expected_sha256 ? { expected_sha256 } : {}) } });
        if (result.error) throw Object.assign(new Error(result.error.message), { remoteResult: result });
        const page = result.report_page;
        if (!page || page.offset !== offset || page.format !== 'json-text-fragment' || page.offset_unit !== 'utf16_code_units'
          || !Array.isArray(page.path) || page.path.length || !/^[0-9a-f]{64}$/.test(page.report_sha256)
          || page.value_sha256 !== page.report_sha256 || (expected_sha256 && expected_sha256 !== page.report_sha256)
          || !Number.isSafeInteger(page.total_units) || page.total_units < 0 || page.total_units > 64 * 1024 * 1024
          || (total !== undefined && total !== page.total_units) || typeof page.json_fragment !== 'string' || page.json_fragment.length > 16000) {
          fail('REMOTE_REPORT_INVALID', 'Invalid report page; no report file was written.');
        }
        total = page.total_units; expected_sha256 = page.report_sha256;
        text += page.json_fragment;
        const end = offset + page.json_fragment.length;
        if (page.next_offset !== (end < total ? end : null) || end > total || (end < total && end <= offset)) {
          fail('REMOTE_REPORT_INVALID', 'Invalid report page progression; no report file was written.');
        }
        offset = page.next_offset;
      } while (offset !== null);
      if (text.length !== total || sha(text) !== expected_sha256) fail('REMOTE_REPORT_INVALID', 'Report content hash does not match; no report file was written.');
      try { return JSON.parse(text); } catch { fail('REMOTE_REPORT_INVALID', 'The complete report is not valid JSON.'); }
    },
  };
}
