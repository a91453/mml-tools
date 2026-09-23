import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

import { ingestMusicXML, decodeMusicXMLBytes, isZipContainer, MXL_LIMITS } from '../backend/score/index.mjs';
import { extractMusicXmlFromMxl, inflateRaw, crc32 } from '../backend/score/mxl.mjs';
import { createStudioApplication } from '../backend/application/index.mjs';
import { intakeMxl, intake } from '../web/model.mjs';

const encoder = new TextEncoder();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const XML = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">`
  + '<measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><direction><sound tempo="120"/></direction>'
  + '<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note><note><rest/><duration>2</duration><voice>1</voice></note></measure>'
  + '<measure number="2"><note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note><barline location="right"><repeat direction="backward"/></barline></measure>'
  + '</part></score-partwise>';
const CONTAINER = (path = 'score.xml', mediaType = 'application/vnd.recordare.musicxml+xml') => `<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="${path}" media-type="${mediaType}"/><rootfile full-path="score.pdf" media-type="application/pdf"/></rootfiles></container>`;

/**
 * A small ZIP writer for fixtures. Each entry may override what the headers
 * claim (`size`, `crc`, `flags`, `method`) so hostile archives can be built
 * from real bytes.
 */
function zip(entries, { entryCount = null } = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const method = entry.method ?? 8;
    const body = entry.body ?? (method === 8 ? new Uint8Array(deflateRawSync(data)) : data);
    const name = encoder.encode(entry.name);
    const crc = entry.crc ?? crc32(data);
    const size = entry.size ?? data.length;
    const flags = entry.flags ?? 0x0800;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, flags, true); local.setUint16(8, method, true);
    local.setUint32(14, crc, true); local.setUint32(18, entry.compressedSize ?? body.length, true); local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, body);
    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true); record.setUint16(4, 20, true); record.setUint16(6, 20, true); record.setUint16(8, flags, true);
    record.setUint16(10, method, true); record.setUint32(16, crc, true); record.setUint32(20, entry.compressedSize ?? body.length, true);
    record.setUint32(24, size, true); record.setUint16(28, name.length, true); record.setUint32(42, offset, true);
    central.push(new Uint8Array(record.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entryCount ?? entries.length, true); end.setUint16(10, entryCount ?? entries.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  return new Uint8Array(Buffer.concat([...chunks, ...central, new Uint8Array(end.buffer)]));
}

const mxl = (extra = [], container = CONTAINER()) => zip([
  { name: 'mimetype', data: 'application/vnd.recordare.musicxml', method: 0 },
  { name: 'META-INF/container.xml', data: container },
  { name: 'score.xml', data: XML },
  ...extra,
]);

function refusedWith(bytes, code, limits) {
  assert.throws(() => extractMusicXmlFromMxl(bytes, limits), error => error.code === code || (assert.fail(`expected ${code}, got ${error.code}: ${error.message}`), false));
}

test('an .mxl round trip reads the rootfile named by container.xml and records where the XML came from', () => {
  const bytes = mxl([{ name: 'thumbnail.png', data: new Uint8Array(64), method: 0 }]);
  assert.equal(isZipContainer(bytes), true);
  const { xml, container } = decodeMusicXMLBytes(bytes);
  assert.equal(xml, XML);
  assert.equal(container.format, 'mxl');
  assert.equal(container.rootfile, 'score.xml');
  assert.equal(container.rootfileSha256, sha256(encoder.encode(XML)));
  assert.equal(container.rootfileMethod, 'deflate');
  assert.equal(container.entryCount, 4);
  assert.equal(container.rootfileCount, 2);

  const plain = ingestMusicXML(XML, { sourceId: 'src', label: 'Fixture' });
  const packed = ingestMusicXML(xml, { sourceId: 'src', label: 'Fixture', container });
  assert.deepEqual(packed.events, plain.events);
  assert.equal(packed.complete, true);
  assert.deepEqual(packed.source.metadata.container, container);
  // Stored entries work too.
  const stored = zip([{ name: 'META-INF/container.xml', data: CONTAINER('music/score.musicxml'), method: 0 }, { name: 'music/score.musicxml', data: XML, method: 0 }]);
  assert.equal(decodeMusicXMLBytes(stored).xml, XML);
});

test('plain MusicXML bytes are read as UTF-8 text; the container is recognised by its bytes, not its name', () => {
  assert.equal(decodeMusicXMLBytes(encoder.encode(XML)).container, null);
  assert.throws(() => decodeMusicXMLBytes(new Uint8Array([0x3c, 0xff, 0xfe])), /UTF-8/);
  assert.throws(() => decodeMusicXMLBytes(encoder.encode(XML), { maxTextBytes: 10 }), /exceeds/);
});

test('the inflater matches zlib and refuses output beyond the declared size', () => {
  const data = encoder.encode(XML.repeat(50));
  assert.deepEqual(inflateRaw(new Uint8Array(deflateRawSync(data)), data.length), data);
  assert.throws(() => inflateRaw(new Uint8Array(deflateRawSync(data)), data.length - 1), error => error.code === 'MXL_ENTRY_SIZE_MISMATCH');
  assert.throws(() => inflateRaw(new Uint8Array(deflateRawSync(data)).subarray(0, 20), data.length), error => error.code === 'MXL_DEFLATE_TRUNCATED');
});

test('zip bombs stop at the cap: an honest huge size is refused before inflating, a lying one at the declared size', () => {
  const zeros = new Uint8Array(4 * 1024 * 1024);
  const honest = mxl([{ name: 'bomb.xml', data: zeros }], CONTAINER('bomb.xml'));
  refusedWith(honest, 'MXL_ENTRY_TOO_LARGE', { ...MXL_LIMITS, maxRootfileBytes: 1024 * 1024 });
  const lying = zip([
    { name: 'META-INF/container.xml', data: CONTAINER('bomb.xml') },
    { name: 'bomb.xml', data: zeros, size: 1000, crc: 0 },
  ]);
  refusedWith(lying, 'MXL_ENTRY_SIZE_MISMATCH');
  refusedWith(mxl(), 'MXL_ARCHIVE_TOO_LARGE', { ...MXL_LIMITS, maxArchiveBytes: 100 });
  refusedWith(mxl(Array.from({ length: 10 }, (_, index) => ({ name: `extra-${index}.bin`, data: 'x', method: 0 }))), 'MXL_TOO_MANY_ENTRIES', { ...MXL_LIMITS, maxEntries: 8 });
  refusedWith(mxl([], `${CONTAINER()}${' '.repeat(2000)}`), 'MXL_ENTRY_TOO_LARGE', { ...MXL_LIMITS, maxContainerXmlBytes: 1024 });
});

test('hostile or unsupported archives are refused by name', () => {
  refusedWith(mxl([{ name: '../evil.xml', data: 'x' }]), 'MXL_ENTRY_PATH_UNSAFE');
  refusedWith(mxl([{ name: '/etc/evil', data: 'x' }]), 'MXL_ENTRY_PATH_UNSAFE');
  refusedWith(mxl([{ name: 'dir\\evil.xml', data: 'x' }]), 'MXL_ENTRY_PATH_UNSAFE');
  refusedWith(mxl([{ name: 'C:/evil.xml', data: 'x' }]), 'MXL_ENTRY_PATH_UNSAFE');
  refusedWith(mxl([], CONTAINER('../score.xml')), 'MXL_ENTRY_PATH_UNSAFE');
  refusedWith(mxl([{ name: 'score.xml', data: XML }]), 'MXL_DUPLICATE_ENTRY');
  refusedWith(mxl([{ name: 'secret.xml', data: 'x', flags: 0x0801 }]), 'MXL_ENCRYPTED_UNSUPPORTED');
  refusedWith(mxl([{ name: 'big.bin', data: 'x', method: 0, size: 0xffffffff }]), 'MXL_ZIP64_UNSUPPORTED');
  refusedWith(zip([{ name: 'META-INF/container.xml', data: CONTAINER() }, { name: 'score.xml', data: XML }], { entryCount: 0xffff }), 'MXL_ZIP64_UNSUPPORTED');
});

test('unsupported compression, bad CRC, missing container or rootfile, and entity-bearing containers are refused', () => {
  refusedWith(zip([{ name: 'META-INF/container.xml', data: CONTAINER() }, { name: 'score.xml', data: XML, method: 12, body: encoder.encode('not bzip2') }]), 'MXL_METHOD_UNSUPPORTED');
  refusedWith(zip([{ name: 'META-INF/container.xml', data: CONTAINER() }, { name: 'score.xml', data: XML, crc: 1234 }]), 'MXL_CRC_MISMATCH');
  refusedWith(zip([{ name: 'score.xml', data: XML }]), 'MXL_CONTAINER_MISSING');
  refusedWith(zip([{ name: 'META-INF/container.xml', data: CONTAINER('other.xml') }, { name: 'score.xml', data: XML }]), 'MXL_ROOTFILE_MISSING');
  refusedWith(zip([{ name: 'META-INF/container.xml', data: '<!DOCTYPE c [<!ENTITY x "y">]><container/>' }]), 'MXL_CONTAINER_INVALID');
  refusedWith(zip([{ name: 'META-INF/container.xml', data: CONTAINER('score.pdf', 'application/pdf') }, { name: 'score.pdf', data: 'x' }]), 'MXL_ROOTFILE_NOT_MUSICXML');
  refusedWith(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), 'MXL_ARCHIVE_TRUNCATED');
});

test('the service intake reads an uploaded .mxl: the asset is the archive, the XML is derived and recorded', async () => {
  const service = createStudioApplication();
  const project = (await service.createProject('owner:mxl', { title: 'MXL intake' })).project;
  const bytes = mxl();
  const asset = (await service.uploadAsset('owner:mxl', project.project_id, {
    kind: 'third_party_musicxml', filename: 'fixture.mxl', mediaType: 'application/vnd.recordare.musicxml', bytes,
  })).asset;
  assert.equal(asset.sha256, sha256(bytes));
  const { baseline } = await service.analyzeSources('owner:mxl', project.project_id);
  assert.equal(baseline.formats[0].format, 'MusicXML (compressed .mxl)');
  assert.deepEqual(baseline.formats[0].container, { format: 'mxl', rootfile: 'score.xml', rootfile_sha256: sha256(encoder.encode(XML)), rootfile_bytes: encoder.encode(XML).length });
  // The backward repeat inside the archive was expanded like any other.
  assert.equal(baseline.source_complete, true);
  assert.equal(baseline.note_event_count, 4);

  // A damaged archive is refused as an unsupported source, with its reason.
  const second = (await service.createProject('owner:mxl', { title: 'MXL refused' })).project;
  await service.uploadAsset('owner:mxl', second.project_id, {
    kind: 'third_party_musicxml', filename: 'bad.mxl', mediaType: 'application/zip', bytes: mxl([{ name: '../evil', data: 'x' }]),
  });
  await assert.rejects(service.analyzeSources('owner:mxl', second.project_id), error => error.code === 'UNSUPPORTED_SOURCE' && /MXL_ENTRY_PATH_UNSAFE/.test(error.message));
});

test('the Studio Web reads the same .mxl through the same reader', () => {
  const asset = intakeMxl({ name: 'fixture.mxl', bytes: mxl(), id: 'web-src' });
  assert.equal(asset.format, 'MusicXML (compressed .mxl)');
  assert.equal(asset.container.rootfile, 'score.xml');
  assert.equal(asset.content, XML);
  const plain = intake({ name: 'fixture.musicxml', content: XML, id: 'web-src' });
  assert.deepEqual(asset.project.events, plain.project.events);
  assert.throws(() => intakeMxl({ name: 'fake.mxl', bytes: encoder.encode(XML), id: 'x' }), /not a compressed MusicXML/);
  assert.throws(() => intakeMxl({ name: 'bad.mxl', bytes: mxl([{ name: '../evil', data: 'x' }]), id: 'x' }), /MXL_ENTRY_PATH_UNSAFE/);
});
