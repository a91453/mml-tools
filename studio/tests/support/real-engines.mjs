// The real Canonical-aware engines, loaded the way `provenance.mjs` loads them.
//
// Used by regressions that need to substitute exactly one engine function while
// every other answer stays real. A test that replaced the whole engine set with
// a mock would prove that the mock said PASS, which is the one thing these
// regressions must never be able to do.

import { ENGINE_MODULES } from '../../backend/application/provenance.mjs';

const resolve = relative => new URL(relative, import.meta.resolve('../../backend/application/index.mjs')).href;

export async function realEngines({ recordPublished } = {}) {
  const rules = await import(resolve(ENGINE_MODULES.rules));
  recordPublished?.(rules.PUBLISHED_CANONICAL);
  const entries = await Promise.all(
    Object.entries(ENGINE_MODULES)
      .filter(([name]) => name !== 'rules')
      .map(async ([name, relative]) => [name, await import(resolve(relative))]),
  );
  return { rules, ...Object.fromEntries(entries) };
}

/**
 * The real engines with one module's exports shallow-overridden.
 *
 * `override(engines)` returns the patch, so it can delegate to the real
 * function it is wrapping.
 */
export const enginesWith = override => async context => {
  const engines = await realEngines(context);
  return { ...engines, ...override(engines) };
};
