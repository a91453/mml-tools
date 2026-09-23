// node:test reporter for CI: the usual TAP stream, then every failed test by
// name at the very end. A suite of a few thousand tests puts the one failing
// test thousands of lines above the log's last lines, which are all a log tail
// or a GitHub log reader shows. Usage: node --test --test-reporter=./scripts/test-reporter-ci.mjs
import { relative } from 'node:path';
import { tap } from 'node:test/reporters';

// Not a cause of its own: a parent that failed only because a subtest did,
// and a test cancelled because its parent failed (a failing hook, a timed-out
// file), whose parent is listed with the actual cause.
const SUMMARY_ONLY = new Set(['subtestsFailed', 'cancelledByParent']);
const MESSAGE_LIMIT = 200;

const escapeProperty = text => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
const escapeData = text => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

export function firstLine(error) {
  const cause = error?.cause ?? error;
  const text = String(cause?.message ?? cause ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? '';
  return text.length > MESSAGE_LIMIT ? text.slice(0, MESSAGE_LIMIT - 1) + '…' : text;
}

export function failureLines(failures, { github = false } = {}) {
  if (!failures.length) return [];
  const lines = [`# Failed tests (${failures.length}):`];
  for (const failure of failures) {
    const where = failure.file ? `${failure.file}${failure.line ? ':' + failure.line : ''}` : '(unknown file)';
    lines.push(`#   ${where} › ${failure.path.join(' › ')}${failure.message ? ' — ' + failure.message : ''}`);
  }
  if (github) {
    for (const failure of failures) {
      const props = [failure.file && `file=${escapeProperty(failure.file)}`, failure.line && `line=${failure.line}`, `title=${escapeProperty('Failed test: ' + failure.path.join(' › '))}`].filter(Boolean);
      lines.push(`::error ${props.join(',')}::${escapeData(failure.message || 'test failed')}`);
    }
  }
  return lines.map(line => line + '\n');
}

export default async function* ciReporter(source) {
  const failures = [];
  // Names of the tests currently open per file and nesting depth, to give a
  // subtest its full path.
  const open = new Map();
  async function* collect() {
    for await (const event of source) {
      const data = event.data ?? {};
      if (event.type === 'test:start') {
        const stack = open.get(data.file) ?? [];
        stack.length = data.nesting;
        stack.push(data.name);
        open.set(data.file, stack);
      } else if (event.type === 'test:fail' && !data.todo && !SUMMARY_ONLY.has(data.details?.error?.failureType)) {
        const parents = (open.get(data.file) ?? []).slice(0, data.nesting);
        failures.push({
          file: data.file ? relative(process.cwd(), data.file) : null,
          line: data.line ?? null,
          path: [...parents, data.name],
          message: firstLine(data.details?.error),
        });
      }
      yield event;
    }
  }
  yield* tap(collect());
  yield* failureLines(failures, { github: process.env.GITHUB_ACTIONS === 'true' });
}
