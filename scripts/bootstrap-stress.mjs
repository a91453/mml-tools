// M6 stress runner: runs the test suite (or any command) under the Git
// subprocess probe and reports what the Canonical bootstrap actually did.
//
//   node scripts/bootstrap-stress.mjs [--runs=N] [--concurrency=C] [--keep-logs] [-- <command> [args...]]
//
// Per run it records: test outcome, Git child processes started (total and per
// bootstrapping process), peak concurrent Git processes, every published
// Manifest identity and rules snapshot identity that a bootstrap from this
// checkout resolved, CANONICAL_NOT_LOADED reasons seen in the output, and
// whether anything in the run wrote the shared published discovery ref or HEAD
// (the reflogs record a rewrite even after it is restored). A run passes only
// when the command succeeded, exactly one published identity and one snapshot
// identity were resolved from this checkout, no bootstrap refused, and the
// shared refs were untouched. Numbers here are measurements of one machine at
// one moment: report them as such, never as a fixed failure rate.
//
// One exception, and only while a publication is under review: the Manifest
// verifier reads the rule documents at the snapshot the working-tree Manifest
// names, which is not yet the published one. That snapshot, and no other, may
// appear beside the published snapshot. Once the publication is merged the two
// are the same and the rule is exactly one again.
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const probe = resolve(root, 'studio/tests/support/git-subprocess-probe.mjs');
const PUBLISHED_REF = 'refs/remotes/origin/main';
// The snapshot named by the Manifest in this working tree (see the exception above).
const reviewedSnapshot = readFileSync(resolve(root, 'docs/CANONICAL_MANIFEST.md'), 'utf8').match(/^rules_snapshot_sha: ([0-9a-f]{40})$/m)?.[1] ?? null;

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
const options = separator === -1 ? argv : argv.slice(0, separator);
const custom = separator === -1 ? [] : argv.slice(separator + 1);
const option = (name, fallback) => {
  const found = options.find(arg => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
for (const arg of options) {
  if (!/^--(runs|concurrency)=\d+$/.test(arg) && arg !== '--keep-logs') {
    console.error(`Usage: node scripts/bootstrap-stress.mjs [--runs=N] [--concurrency=C] [--keep-logs] [-- <command> [args...]]\nUnknown option: ${arg}`);
    process.exit(2);
  }
}
const runs = Number(option('runs', '1'));
const concurrency = option('concurrency', null);
const keepLogs = options.includes('--keep-logs');

const testFiles = dir => readdirSync(resolve(root, dir)).filter(name => name.endsWith('.test.mjs')).sort().map(name => `${dir}/${name}`);
const command = custom.length ? custom : [
  process.execPath, '--test', ...(concurrency ? [`--test-concurrency=${concurrency}`] : []),
  ...testFiles('tests'), ...testFiles('studio/tests'),
];

const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// A delete-and-recreate can leave the same value and reflog count behind, so the
// identity (inode, size, change time) of each ref file, its reflog and
// packed-refs is observed too; read-only Git commands never touch them.
const fileIdentity = path => {
  try {
    const stat = statSync(path, { bigint: true });
    return { ino: String(stat.ino), size: String(stat.size), ctimeNs: String(stat.ctimeNs), mtimeNs: String(stat.mtimeNs) };
  } catch { return null; }
};
function observeSharedRefs() {
  const headReflog = git(['reflog', 'show', '--date=iso', '--format=%H %gd %gs', 'HEAD']);
  const publishedReflog = git(['reflog', 'show', '--date=iso', '--format=%H %gd %gs', PUBLISHED_REF]);
  const files = Object.fromEntries(['HEAD', 'logs/HEAD', PUBLISHED_REF, `logs/${PUBLISHED_REF}`, 'packed-refs']
    .map(path => [path, fileIdentity(resolve(root, git(['rev-parse', '--git-path', path])))]));
  return {
    head: git(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']),
    headReflogEntries: headReflog ? headReflog.split('\n').length : 0,
    headReflog,
    published: git(['rev-parse', '--verify', '--end-of-options', `${PUBLISHED_REF}^{commit}`]),
    publishedReflogEntries: publishedReflog ? publishedReflog.split('\n').length : 0,
    publishedReflog,
    files,
  };
}
// Reflog-based detection needs reflogs on; refuse to report "untouched" blindly.
const logAllRefUpdates = (() => { try { return git(['config', '--get', 'core.logAllRefUpdates']); } catch { return ''; } })();
if (/^(false|0|no|off)$/i.test(logAllRefUpdates)) {
  console.error('core.logAllRefUpdates is disabled: shared-ref mutation cannot be detected. Enable it before running this check.');
  process.exit(2);
}

const rootReal = realpathSync(root).replace(/\/$/, '');
const inRoot = record => {
  try { return realpathSync(record.cwd).replace(/\/$/, '') === rootReal; } catch { return record.cwd.replace(/\/$/, '') === rootReal; }
};
const objectRef = (record, path) => {
  const text = `${record.args.join(' ')}\n${record.input ?? ''}`;
  const match = text.match(new RegExp(`([0-9a-f]{40}):${path.replace(/[.\\/]/g, '\\$&')}(?![\\w/])`));
  return match ? match[1] : null;
};
// The Git subcommand, skipping global options such as --no-replace-objects and -c key=value.
const subcommand = record => {
  for (let index = 0; index < record.args.length; index += 1) {
    if (record.args[index] === '-c' || record.args[index] === '-C') { index += 1; continue; }
    if (!record.args[index].startsWith('-')) return record.args[index];
  }
  return null;
};
const isRead = record => subcommand(record) === 'show' || subcommand(record) === 'cat-file';

function analyse(logPath) {
  const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  const records = lines.map(line => JSON.parse(line));
  const rootRecords = records.filter(inRoot);
  const byPid = new Map();
  for (const record of rootRecords) byPid.set(record.pid, [...(byPid.get(record.pid) ?? []), record]);
  const manifestReads = rootRecords.filter(record => isRead(record) && objectRef(record, 'docs/CANONICAL_MANIFEST.md'));
  const bootstrapPids = new Set(manifestReads.map(record => record.pid));
  const gitPerBootstrap = [...bootstrapPids].map(pid => byPid.get(pid).length).sort((a, b) => a - b);
  const publishedIdentities = {};
  for (const record of manifestReads) {
    const commit = objectRef(record, 'docs/CANONICAL_MANIFEST.md');
    publishedIdentities[commit] = { reads: (publishedIdentities[commit]?.reads ?? 0) + 1, contentHash: record.hash };
  }
  const snapshotIdentities = new Set(rootRecords.map(record => isRead(record) && objectRef(record, 'docs/MASTER_RULES.md')).filter(Boolean));
  const events = records.flatMap(record => [[record.t0, 1], [record.t1, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0, peak = 0;
  for (const [, delta] of events) { current += delta; peak = Math.max(peak, current); }
  const commands = {};
  for (const record of rootRecords) commands[subcommand(record)] = (commands[subcommand(record)] ?? 0) + 1;
  return {
    gitSubprocesses: { total: records.length, fromThisCheckout: rootRecords.length, byCommand: commands },
    bootstrapAttempts: manifestReads.length,
    bootstrappingProcesses: bootstrapPids.size,
    // Root Git calls per bootstrapping process; a test file's own helper calls
    // in the checkout are included, so the minimum is the loader's own cost.
    gitSubprocessesPerBootstrappingProcess: gitPerBootstrap.length ? { min: gitPerBootstrap[0], median: gitPerBootstrap[Math.floor(gitPerBootstrap.length / 2)], max: gitPerBootstrap.at(-1) } : null,
    peakConcurrentGitSubprocesses: peak,
    publishedIdentitiesResolvedFromThisCheckout: publishedIdentities,
    snapshotIdentitiesResolvedFromThisCheckout: [...snapshotIdentities],
    failedGitCallsFromThisCheckout: rootRecords.filter(record => !record.ok).map(record => ({ args: record.args, error: record.error })),
  };
}

const reports = [];
for (let run = 1; run <= runs; run += 1) {
  const logDir = mkdtempSync(resolve(tmpdir(), 'mml-bootstrap-stress-'));
  const logPath = resolve(logDir, 'git.jsonl');
  const before = observeSharedRefs();
  const started = Date.now();
  const result = spawnSync(command[0], command.slice(1), {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, M6_PROBE_LOG: logPath, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(probe).href}`].filter(Boolean).join(' ') },
  });
  const wallSeconds = (Date.now() - started) / 1000;
  const after = observeSharedRefs();
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const refusals = {};
  for (const match of output.matchAll(/CANONICAL_NOT_LOADED: ([^\n'"]+)/g)) refusals[match[1].trim()] = (refusals[match[1].trim()] ?? 0) + 1;
  const tap = { pass: Number(output.match(/^# pass (\d+)/m)?.[1] ?? NaN), fail: Number(output.match(/^# fail (\d+)/m)?.[1] ?? NaN) };
  const metrics = analyse(logPath);
  const sharedRefsUntouched = JSON.stringify(before) === JSON.stringify(after);
  const publishedIdentities = Object.keys(metrics.publishedIdentitiesResolvedFromThisCheckout);
  const snapshots = metrics.snapshotIdentitiesResolvedFromThisCheckout;
  const oneSnapshot = snapshots.length === 1
    || (snapshots.length === 2 && reviewedSnapshot !== null && snapshots.includes(reviewedSnapshot));
  const report = {
    run, command: command.join(' '), exitCode: result.status, signal: result.signal, wallSeconds, tap,
    sharedRefsUntouched, sharedRefs: { before, after }, refusals, ...metrics,
    workingTreeManifestSnapshot: reviewedSnapshot,
    ok: result.status === 0 && sharedRefsUntouched && publishedIdentities.length === 1 && oneSnapshot && Object.keys(refusals).length === 0 && metrics.failedGitCallsFromThisCheckout.length === 0,
  };
  if (!report.ok) report.failingOutputTail = output.split('\n').filter(line => /^not ok|CANONICAL_NOT_LOADED:|Error:/.test(line.trim())).slice(0, 20);
  if (keepLogs) report.probeLog = logPath; else rmSync(logDir, { recursive: true, force: true });
  reports.push(report);
  console.error(`run ${run}/${runs}: ${report.ok ? 'ok' : 'FAILED'} in ${wallSeconds.toFixed(1)}s, ${metrics.gitSubprocesses.total} git subprocesses, ${metrics.bootstrapAttempts} bootstraps, ${publishedIdentities.length} published identit${publishedIdentities.length === 1 ? 'y' : 'ies'}, shared refs ${sharedRefsUntouched ? 'untouched' : 'WRITTEN'}`);
}
const summary = {
  machine: { platform: process.platform, cpus: (await import('node:os')).availableParallelism(), node: process.version, git: git(['--version']) },
  runs: reports.length,
  failedRuns: reports.filter(report => !report.ok).length,
  reports,
};
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.failedRuns === 0 ? 0 : 1;
