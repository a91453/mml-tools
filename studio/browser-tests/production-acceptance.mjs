// Live HTTPS driver: the operator logs in interactively. No password arguments,
// stored browser state, TLS overrides, traces, or automatic mutation retries.
import { readFile, mkdir, writeFile, open } from 'node:fs/promises';
import { resolve, basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { acceptanceReport, loadProbeInputs, probeProduction, serviceOrigin } from '../../scripts/studio-production-probe.mjs';
import { sixSourceVoices } from '../tests/fixtures/midi-fixtures.mjs';
import { exerciseProductionWorkspace } from './production-workflow.mjs';

const { values } = parseArgs({ options: { origin: { type: 'string' }, 'expected-main': { type: 'string' },
  'manifest-commit': { type: 'string' }, out: { type: 'string' }, midi: { type: 'string' },
  profile: { type: 'string', default: 'desktop' }, 'create-test-project': { type: 'boolean' } } });
if (!values.out || !values['create-test-project']) throw Error('--out and --create-test-project are required; one new persistent project will be created');
const origin = serviceOrigin(values.origin);
if (!['desktop', 'iphone', 'ipad'].includes(values.profile)) throw Error('profile must be desktop, iphone or ipad');
const source = values.midi ? await readFile(values.midi) : Buffer.from(sixSourceVoices());
if (source.length > 64 * 1024 * 1024 || source.subarray(0, 4).toString() !== 'MThd') throw Error('a MIDI file within the service limit is required');
const sourceName = values.midi ? basename(values.midi) : 'synthetic-production-transport.mid';
const out = resolve(values.out); await mkdir(out, { recursive: true });
// Keep the lock after interruption. A fresh output directory is required each run.
const lock = await open(join(out, 'acceptance.lock'), 'wx', 0o600); await lock.close();
const report = acceptanceReport(origin);
report.source = values.midi ? 'operator-provided MIDI; identity not independently verified' : 'generated synthetic MIDI, not a song';
const save = () => writeFile(join(out, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
let browser, phase = 'public_probe', bearer;
try {
  const inputs = await loadProbeInputs({ main: values['expected-main'], manifestCommit: values['manifest-commit'] });
  report.public_probe = await probeProduction({ origin, ...inputs }); await save();
  phase = 'browser_mcp';
  const { chromium, webkit } = await import('playwright');
  const mobile = values.profile !== 'desktop';
  browser = await (mobile ? webkit : chromium).launch({ headless: false });
  const context = await browser.newContext({ viewport: mobile
    ? (values.profile === 'iphone' ? { width: 390, height: 844 } : { width: 820, height: 1180 })
    : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage(); let pageErrors = 0;
  page.on('pageerror', () => { pageErrors++; });
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname.startsWith('/api/v1/')) {
      const authorization = request.headers().authorization;
      if (authorization?.startsWith('Bearer ')) bearer = authorization.slice(7);
    }
  });
  await page.goto(origin + '/studio/');
  console.log('In the opened browser, click 登入服務 and complete your normal login. The test will create one isolated project after login.');
  await page.locator('#workspace').waitFor({ state: 'visible', timeout: 300000 });
  const evidence = await exerciseProductionWorkspace({ page, origin, token: () => bearer, source, sourceName,
    checkpoint: async evidence => { report.browser_mcp = { ...evidence, profile: values.profile }; await save(); } });
  if (pageErrors) throw Error('Browser page error');
  report.browser_mcp = { ...evidence, profile: values.profile };
  // The external test client is not evidence of ChatGPT connector behavior.
  report.service_transport_status = 'PASS';
} catch {
  report.status = 'FAIL';
  report[phase] = { ...report[phase], status: 'FAIL', reason: 'ACCEPTANCE_STEP_FAILED',
    recovery: 'Inspect the saved project/run before retrying. No write was automatically retried.' };
} finally {
  bearer = undefined; await browser?.close(); await save();
}
console.log(JSON.stringify({ status: report.status, service_transport_status: report.service_transport_status ?? 'NOT_VERIFIED' }));
process.exitCode = report.status === 'FAIL' ? 1 : 2;
