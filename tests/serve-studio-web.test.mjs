// The Studio preview server (scripts/serve-studio-web.mjs) serves the build
// and nothing outside it. Its containment check once compared a `/`-suffixed
// root with what `path.resolve` returns; on Windows that answer uses `\`, so
// every request -- `/`, the Workshop, build.json -- was a 404 there. The check
// is exercised here with both platforms' path rules, and over real HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, posix, win32 } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { resolveServed, serveStudio } from '../scripts/serve-studio-web.mjs';

const ASSETS = ['/index.html', '/studio/web/workshop/index.html', '/build.json'];
const ESCAPES = ['/../secret.json', '/studio/../../secret.json', '/..', '/../web-build-evil/a.json'];

test('Windows: assets resolve inside the root, whichever way the root is spelled', () => {
  for (const root of ['C:\\Users\\me\\mml-tool\\studio\\web-build\\', 'C:\\Users\\me\\mml-tool\\studio\\web-build', 'c:/Users/me/mml-tool/studio/web-build/']) {
    for (const name of ASSETS) {
      const file = resolveServed(root, name, win32);
      assert.ok(file, `${root} ${name}`);
      assert.equal(file.toLowerCase(), win32.join('C:\\Users\\me\\mml-tool\\studio\\web-build', name).toLowerCase());
    }
  }
});

test('Windows: nothing outside the root is served', () => {
  const root = 'C:\\srv\\web-build\\';
  for (const name of [...ESCAPES, '/..\\secret.json', '/studio\\..\\..\\secret.json', '/..\\web-build-evil\\a.json']) {
    assert.equal(resolveServed(root, name, win32), null, name);
  }
  // A drive or UNC spelling stays a name under the root; it never selects
  // another volume.
  for (const name of ['/C:/Windows/win.ini', '/D:\\secret.json', '/\\\\server\\share\\x.json']) {
    const file = resolveServed(root, name, win32);
    assert.ok(file === null || file.toLowerCase().startsWith('c:\\srv\\web-build\\'), `${name} → ${file}`);
  }
});

test('POSIX: assets resolve inside the root and escapes are refused', () => {
  for (const root of ['/srv/web-build/', '/srv/web-build']) {
    for (const name of ASSETS) assert.equal(resolveServed(root, name, posix), posix.join('/srv/web-build', name));
    for (const name of ESCAPES) assert.equal(resolveServed(root, name, posix), null, name);
  }
  // A file whose name merely starts with two dots is inside.
  assert.equal(resolveServed('/srv/web-build', '/..notes.json', posix), '/srv/web-build/..notes.json');
});

const get = (port, path) => new Promise((resolve, reject) => {
  // `path` is sent as written: no client-side normalisation of `..`.
  const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject);
  req.end();
});

test('over HTTP: the build is served and a sibling or parent file is not', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'serve-studio-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'web-build');
  mkdirSync(join(root, 'studio', 'web', 'workshop'), { recursive: true });
  mkdirSync(join(dir, 'web-build-evil'));
  writeFileSync(join(root, 'index.html'), 'home');
  writeFileSync(join(root, 'studio', 'web', 'workshop', 'index.html'), 'workshop');
  writeFileSync(join(root, 'build.json'), '{"ok":true}');
  writeFileSync(join(dir, 'secret.json'), '"parent"');
  writeFileSync(join(dir, 'web-build-evil', 'a.json'), '"sibling"');

  const server = await serveStudio({ port: 0, root });
  t.after(() => new Promise(done => server.close(done)));
  const { port } = server.address();

  assert.deepEqual(await get(port, '/'), { status: 200, body: 'home' });
  assert.deepEqual(await get(port, '/studio/web/workshop/index.html'), { status: 200, body: 'workshop' });
  assert.deepEqual(await get(port, '/build.json'), { status: 200, body: '{"ok":true}' });
  for (const path of ['/../secret.json', '/%2e%2e/secret.json', '/..%2fsecret.json', '/..%2Fweb-build-evil%2Fa.json', '/studio/..%2f..%2fsecret.json']) {
    const res = await get(port, path);
    assert.equal(res.status, 404, path);
    assert.doesNotMatch(res.body, /parent|sibling/, path);
  }
});
