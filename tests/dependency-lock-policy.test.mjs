// Dependency resolution is locked for current builds (roadmap G13).
//
// Direct dependencies were exactly pinned but nothing pinned their own
// dependencies: `package-lock.json` was ignored and every CI job installed with
// `npm install --package-lock=false`, so each run resolved the transitive tree
// afresh. The repository already pins what it builds (buildId, release-lock,
// SHA-256 verification); the tree those builds are made from is now pinned too.
//
// These regressions keep it that way: the lockfile stays committed, it agrees
// with package.json, and no current workflow or image resolves around it. The
// one exception is archival and is verified rather than trusted: a publisher
// that rebuilds a pinned historical commit which itself carries no lockfile,
// where `npm ci` cannot run and the historical release identity must not move.
//
// Runs in Studio CI's classify job, before any dependency is installed and
// whatever paths a change touches, so it imports nothing outside Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = path => readFileSync(resolve(root, path), 'utf8');
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

// Archival publishers: the workflow, and the historical commit it rebuilds.
// An entry is honoured only while that commit really has no lockfile.
const ARCHIVAL_INSTALLS = Object.freeze({
  '.github/workflows/studio-durable-release.yml': 'npm install --ignore-scripts --package-lock=false',
});

const NPM_RESOLVING_INSTALL = /\bnpm\s+(?:install|i|add|update|upgrade)\b/;
const LOCKFILE_BYPASS = /--(?:no-)?package-lock(?:=false)?\b|--no-shrinkwrap\b/;
const commandLines = text => text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
const workflows = () => readdirSync(resolve(root, '.github/workflows'))
  .filter(name => /\.ya?ml$/.test(name)).map(name => `.github/workflows/${name}`);

test('package-lock.json is committed and nothing ignores it', () => {
  assert.equal(git('ls-files', '--error-unmatch', '--', 'package-lock.json').status, 0, 'package-lock.json must be tracked');
  assert.equal(git('check-ignore', '-q', '--no-index', 'package-lock.json').status, 1, 'no ignore rule may match package-lock.json');
  for (const lock of ['npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']) {
    assert.equal(existsSync(resolve(root, lock)), false, `${lock} would compete with package-lock.json`);
  }
  if (existsSync(resolve(root, '.npmrc'))) {
    assert.doesNotMatch(read('.npmrc'), /^\s*(?:package-lock|shrinkwrap)\s*=\s*false\b/m, '.npmrc must not turn the lockfile off');
  }
});

test('the lockfile agrees with package.json and pins every package to the registry by integrity', () => {
  const manifest = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  const top = lock.packages[''];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.deepEqual(top[field] ?? {}, manifest[field] ?? {}, `package-lock.json ${field} differ from package.json`);
  }
  // Direct dependencies stay exact versions, and the lockfile installs those.
  for (const [name, spec] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    assert.match(spec, /^\d+\.\d+\.\d+$/, `${name} must be an exact version, not ${spec}`);
    assert.equal(lock.packages[`node_modules/${name}`]?.version, spec, `${name} is locked at another version than package.json pins`);
  }
  const packages = Object.entries(lock.packages).filter(([path]) => path);
  assert.ok(packages.length > Object.keys(manifest.dependencies).length, 'the transitive tree is locked, not only the direct dependencies');
  for (const [path, entry] of packages) {
    assert.equal(entry.link, undefined, `${path} is a link, not a registry package`);
    assert.ok(entry.resolved?.startsWith('https://registry.npmjs.org/'), `${path} must resolve from the public npm registry, not ${entry.resolved}`);
    assert.match(entry.integrity ?? '', /^sha512-/, `${path} needs a sha512 integrity`);
  }
});

test('current workflows install with npm ci and never resolve around the lockfile', () => {
  const offending = [];
  let installs = 0;
  for (const workflow of workflows()) {
    const archival = ARCHIVAL_INSTALLS[workflow];
    for (const line of commandLines(read(workflow))) {
      if (/\bnpm\s+ci\b/.test(line)) {
        installs++;
        if (LOCKFILE_BYPASS.test(line)) offending.push(`${workflow}: ${line}`);
      } else if (NPM_RESOLVING_INSTALL.test(line) || LOCKFILE_BYPASS.test(line)) {
        if (line !== archival) offending.push(`${workflow}: ${line}`);
      }
    }
  }
  assert.deepEqual(offending, [], 'a current workflow resolves dependencies instead of installing the lockfile');
  assert.ok(installs >= 3, 'the Node suite, the browser suite and the service browser suite install with npm ci');
});

test('an archival install is exempt only while the commit it rebuilds carries no lockfile', () => {
  for (const [workflow, install] of Object.entries(ARCHIVAL_INSTALLS)) {
    const text = read(workflow);
    assert.ok(commandLines(text).some(line => line === install), `${workflow} no longer runs its archival install; drop the exemption`);
    const pinned = [...text.matchAll(/git worktree add --detach \S+ ([0-9a-f]{40})\b/g)].map(match => match[1]);
    assert.equal(pinned.length, 1, `${workflow} must rebuild exactly one pinned commit`);
    assert.equal(git('cat-file', '-e', `${pinned[0]}^{commit}`).status, 0, `pinned commit ${pinned[0]} is not in this clone; fetch full history`);
    assert.notEqual(git('cat-file', '-e', `${pinned[0]}:package-lock.json`).status, 0,
      `${pinned[0]} carries package-lock.json, so ${workflow} must install it with npm ci`);
  }
});

test('the Railway image installs the lockfile it is allowed to see', () => {
  const dockerfile = commandLines(read('railway/Dockerfile'));
  assert.ok(dockerfile.includes('COPY package.json package-lock.json ./'), 'the dependency layer must copy the lockfile');
  const installs = dockerfile.filter(line => /\bnpm\s/.test(line));
  assert.deepEqual(installs, ['RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund']);
  assert.match(read('.dockerignore'), /^!package-lock\.json$/m, 'the build context must admit the lockfile');
});

test('no package script resolves dependencies at run time', () => {
  const { scripts = {} } = JSON.parse(read('package.json'));
  for (const [name, command] of Object.entries(scripts)) {
    assert.doesNotMatch(command, NPM_RESOLVING_INSTALL, `npm script ${name} installs dependencies`);
  }
});
