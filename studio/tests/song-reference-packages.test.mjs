// Song Reference Packages under imports/song-reference/ are imported song
// context: accepted MML, selected historical MML and the metadata that explains
// them. They hold no Canonical authority. These checks keep each package
// internally consistent with its own manifest and readable by the current
// parser, so a silent edit, an unlisted file or a source binary cannot enter
// the tree unnoticed. They re-run nothing musical: recorded gate results stay
// HISTORICAL_RECORDED_RESULT, and the song-level Final validation that needs a
// source-confirmed meter map is deliberately not attempted here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../backend/mml/index.mjs';
import { parseTrack, splitMML } from '../backend/mml/parser.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const packagesRoot = resolve(root, 'imports/song-reference');
const walk = dir => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
const packageDirs = existsSync(packagesRoot)
  ? readdirSync(packagesRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(packagesRoot, entry.name))
  : [];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const blobSha1 = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const commitExists = sha => {
  try { return execFileSync('git', ['cat-file', '-t', sha], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() === 'commit'; }
  catch { return false; }
};

// Real-song packages are kept out of the public repository, so the store may
// be empty; any package placed here is still held to every check below.
test('the song-reference store holds only package directories and its README', () => {
  if (!existsSync(packagesRoot)) return;
  const loose = readdirSync(packagesRoot, { withFileTypes: true }).filter(entry => !entry.isDirectory()).map(entry => entry.name);
  assert.deepEqual(loose, ['README.md']);
});

for (const dir of packageDirs) {
  const songId = relative(packagesRoot, dir);
  const manifest = JSON.parse(readFileSync(join(dir, 'package-manifest.json'), 'utf8'));
  const listed = new Map(manifest.files.map(file => [file.path, file]));

  test(`${songId}: manifest lists every package file exactly once with matching hashes and sizes`, () => {
    assert.equal(manifest.song_id, songId);
    assert.equal(manifest.import_path, `imports/song-reference/${songId}/`);
    const actual = walk(dir).map(file => relative(dir, file).replaceAll('\\', '/')).filter(file => file !== 'package-manifest.json').sort();
    assert.deepEqual([...listed.keys()].sort(), actual, 'listed files must equal the files on disk');
    assert.equal(listed.size, manifest.files.length, 'no duplicate paths');
    for (const [path, entry] of listed) {
      assert.ok(!path.startsWith('/') && !path.split('/').some(part => part === '..' || part === '.'), `relative path: ${path}`);
      const bytes = readFileSync(join(dir, path));
      assert.equal(bytes.length, entry.bytes, `${path} bytes`);
      assert.equal(sha256(bytes), entry.sha256, `${path} sha256`);
      assert.equal(blobSha1(bytes), entry.git_blob_sha1, `${path} git blob sha1`);
    }
  });

  test(`${songId}: no source binary is packaged`, () => {
    assert.equal(manifest.source_binaries_included, false);
    const prohibited = new Set(manifest.prohibited_source_binary_extensions);
    assert.ok(prohibited.size >= 7);
    for (const path of listed.keys()) assert.ok(!prohibited.has(extname(path).toLowerCase()), `prohibited binary: ${path}`);
    for (const file of walk(dir)) assert.ok(statSync(file).size < 200_000, `${relative(dir, file)} is too large for a text package`);
  });

  test(`${songId}: accepted MML is the recorded bytes and still splits into six Final-parsable tracks`, () => {
    assert.equal(manifest.accepted_mml_modified, false);
    const raw = readFileSync(join(dir, 'current-accepted.mml'), 'utf8');
    assert.equal(sha256(Buffer.from(raw)), manifest.current_accepted_sha256);
    const context = JSON.parse(readFileSync(join(dir, 'song-context.json'), 'utf8'));
    assert.equal(context.song_id, songId);
    assert.equal(context.current_accepted_version.version_id, manifest.current_accepted_version);
    assert.equal(context.current_accepted_version.sha256, manifest.current_accepted_sha256);
    assert.equal(context.current_accepted_version.file, 'current-accepted.mml');
    const tracks = splitMML(raw);
    assert.equal(tracks.length, 6);
    for (const [index, track] of tracks.entries()) {
      const parsed = parseTrack(track, ROLES[index], { mode: 'final' });
      assert.deepEqual(parsed.errors, [], `${ROLES[index]} must parse without errors`);
    }
  });

  test(`${songId}: every historical MML the context names exists, is listed and parses`, () => {
    const context = JSON.parse(readFileSync(join(dir, 'song-context.json'), 'utf8'));
    const mmlFiles = [...listed.keys()].filter(path => path.endsWith('.mml'));
    assert.ok(mmlFiles.length >= 1);
    for (const version of context.historical_reference_versions) {
      assert.ok(listed.has(version.file), `${version.version_id} -> ${version.file} must be in the manifest`);
    }
    for (const path of mmlFiles) {
      const tracks = splitMML(readFileSync(join(dir, path), 'utf8'));
      assert.equal(tracks.length, 6, path);
      for (const [index, track] of tracks.entries()) {
        assert.deepEqual(parseTrack(track, ROLES[index], { mode: 'final' }).errors, [], `${path} ${ROLES[index]}`);
      }
    }
  });

  test(`${songId}: recorded Canonical provenance names real commits and claims no authority`, () => {
    const context = JSON.parse(readFileSync(join(dir, 'song-context.json'), 'utf8'));
    for (const sha of [context.canonical_context.rules_snapshot_sha, context.canonical_context.manifest_commit, manifest.import_record.rules_snapshot_sha, manifest.import_record.manifest_commit, manifest.import_record.published_main_head_at_verification]) {
      assert.match(sha, /^[0-9a-f]{40}$/);
      assert.ok(commitExists(sha), `${sha} must be a commit in this repository`);
    }
    assert.equal(manifest.import_record.rules_snapshot_sha, context.canonical_context.rules_snapshot_sha);
    assert.ok(listed.has('import-record.md'));
    assert.match(manifest.authority_note, /Not a Canonical rule source/);
  });
}
