// Production-safe external inference through OpenAI Responses API.
// The model receives no native tools and returns exactly one schema-bound action.
// The parent driver still validates that action against the existing Studio MCP
// allowlist, proposal protocol and run identity before anything can execute.
import { ACTION_SCHEMA, buildAgentPrompt } from './studio-agent-codex.mjs';

const ENDPOINT = 'https://api.openai.com/v1/responses';
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

function boundedInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw Error(`${name} is outside its hard bound`);
  return value;
}

function outputTextOf(response) {
  if (!response || response.status !== 'completed' || !Array.isArray(response.output)) {
    throw Error('OpenAI response did not complete; no action applied');
  }
  const messages = response.output.filter(item => item?.type === 'message');
  if (messages.length !== 1 || !Array.isArray(messages[0].content)) {
    throw Error('OpenAI response did not contain exactly one message; no action applied');
  }
  if (messages[0].content.some(part => part?.type === 'refusal')) {
    throw Error('OpenAI response was refused; no action applied');
  }
  const text = messages[0].content.filter(part => part?.type === 'output_text').map(part => part.text);
  if (text.length !== 1 || typeof text[0] !== 'string' || !text[0].trim()) {
    throw Error('OpenAI response did not contain exactly one structured action; no action applied');
  }
  return text[0];
}

export function createOpenAIResponsesDecider({
  apiKey,
  model,
  timeoutMs = 60000,
  maxInputBytes = 262144,
  maxOutputTokens = 900,
  maxResponseBytes = 524288,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.trim().length < 20 || apiKey.length > 1024) {
    throw Error('OPENAI_API_KEY is required for the OpenAI Responses agent');
  }
  if (typeof model !== 'string' || !MODEL.test(model)) throw Error('MML_AGENT_MODEL is invalid');
  if (typeof fetchImpl !== 'function') throw Error('A fetch implementation is required');
  boundedInteger(timeoutMs, 'MML_AGENT_TIMEOUT_MS', 1000, 90000);
  boundedInteger(maxInputBytes, 'MML_AGENT_MAX_INPUT_BYTES', 4096, 393216);
  boundedInteger(maxOutputTokens, 'MML_AGENT_MAX_OUTPUT_TOKENS', 64, 1536);
  boundedInteger(maxResponseBytes, 'Agent response byte limit', 4096, 1048576);

  return async (context, { signal } = {}) => {
    const prompt = buildAgentPrompt(context);
    if (Buffer.byteLength(prompt) > maxInputBytes) {
      throw Error('Agent context exceeds the configured input budget; use report pages or a smaller review surface');
    }
    if (signal?.aborted) throw Error('Agent stopped');

    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          store: false,
          input: prompt,
          max_output_tokens: maxOutputTokens,
          text: {
            format: {
              type: 'json_schema',
              name: 'studio_agent_action',
              strict: true,
              schema: ACTION_SCHEMA,
            },
          },
        }),
        signal: controller.signal,
      });
      if (!response?.ok) {
        throw Error(`OpenAI Responses request failed with HTTP ${Number(response?.status) || 0}; no automatic retry`);
      }
      const declared = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > maxResponseBytes) {
        throw Error('OpenAI response exceeded the byte budget; no action applied');
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw) > maxResponseBytes) {
        throw Error('OpenAI response exceeded the byte budget; no action applied');
      }
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw Error('OpenAI response was not JSON; no action applied'); }
      let action;
      try { action = JSON.parse(outputTextOf(parsed)); } catch (error) {
        if (String(error?.message ?? '').startsWith('OpenAI response')) throw error;
        throw Error('OpenAI structured action was not JSON; no action applied');
      }
      return action;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
}
