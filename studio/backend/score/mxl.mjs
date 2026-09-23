// Compressed MusicXML (.mxl) container reader.
//
// An .mxl file is a ZIP archive whose `META-INF/container.xml` names the
// MusicXML document to read (the first `<rootfile>`, per the MusicXML container
// specification). This module finds that entry and returns its XML text. It
// never writes anything anywhere: entries are addressed by their exact name in
// memory, so a path-traversal name cannot reach a filesystem, and one is still
// refused because an archive carrying one is not an honest score container.
//
// Dependency-free on purpose. The same module runs in the Node service and in
// the offline Studio Web bundle, which ships no `node:` import, so the inflate
// below is a small RFC 1951 decoder instead of `node:zlib`. It is bounded
// before it starts and while it runs:
//
//   * the archive, the entry count, the container document and the rootfile
//     each have a hard cap (MXL_LIMITS);
//   * an entry's declared uncompressed size is checked against its cap before
//     anything is inflated, and the output buffer is exactly that size, so a
//     stream that tries to produce one byte more than it declared fails at that
//     byte instead of after exhausting memory (a zip bomb stops at the cap);
//   * only the two entries that are needed are ever inflated;
//   * the CRC-32 and the exact size of every inflated entry are verified.
//
// Refused rather than guessed: encrypted entries, ZIP64, multi-disk archives,
// compression methods other than stored/deflate, duplicate names, names with
// `..`, absolute paths, drive letters or backslashes, a local header that
// disagrees with the central directory, and a missing or ambiguous container.

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { sha256Hex } from '../source/sha256.mjs';

export const MXL_LIMITS = Object.freeze({
  maxArchiveBytes: 16 * 1024 * 1024,
  maxEntries: 256,
  maxContainerXmlBytes: 64 * 1024,
  // Below the MusicXML adapter's own 20,000,000-character document cap.
  maxRootfileBytes: 16 * 1024 * 1024,
  maxNameBytes: 1024,
});

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

export class MxlError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'MxlError';
    this.code = code;
    this.details = details;
  }
}

const refuse = (code, message, details) => { throw new MxlError(code, message, details); };

/** True when the bytes begin with a ZIP local file header ("PK\x03\x04"). */
export function isZipContainer(bytes) {
  return bytes instanceof Uint8Array
    && bytes.length >= 4
    && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

// ─── CRC-32 ─────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── raw DEFLATE (RFC 1951) ────────────────────────────────────────────────
//
// Canonical-Huffman decoding in the style of zlib's reference `puff.c`: codes
// are decoded bit by bit against per-length counts, which is short, has no
// table-building edge cases, and is fast enough for the capped sizes above.

const MAXBITS = 15;
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function huffman(lengths, count) {
  const counts = new Uint16Array(MAXBITS + 1);
  const symbols = new Uint16Array(count);
  for (let symbol = 0; symbol < count; symbol += 1) counts[lengths[symbol]] += 1;
  // Over-subscribed sets are malformed; incomplete sets are reported to the
  // caller, which decides whether the one permitted exception applies.
  let left = 1;
  for (let len = 1; len <= MAXBITS; len += 1) {
    left = (left << 1) - counts[len];
    if (left < 0) refuse('MXL_DEFLATE_INVALID', 'over-subscribed Huffman code');
  }
  const offsets = new Uint16Array(MAXBITS + 2);
  for (let len = 1; len < MAXBITS; len += 1) offsets[len + 1] = offsets[len] + counts[len];
  for (let symbol = 0; symbol < count; symbol += 1) if (lengths[symbol]) symbols[offsets[lengths[symbol]]++] = symbol;
  return { counts, symbols, incomplete: left > 0 };
}

let FIXED = null;
function fixedTables() {
  if (FIXED) return FIXED;
  const lengths = new Uint8Array(288);
  for (let i = 0; i < 144; i += 1) lengths[i] = 8;
  for (let i = 144; i < 256; i += 1) lengths[i] = 9;
  for (let i = 256; i < 280; i += 1) lengths[i] = 7;
  for (let i = 280; i < 288; i += 1) lengths[i] = 8;
  const distances = new Uint8Array(30).fill(5);
  FIXED = { literal: huffman(lengths, 288), distance: huffman(distances, 30) };
  return FIXED;
}

/**
 * Inflate a raw DEFLATE stream into exactly `expectedSize` bytes.
 *
 * Producing more than `expectedSize` bytes, ending early, or any malformed
 * construct is refused. The output buffer is allocated once at the declared
 * size, so memory use is bounded by the caller's cap, not by the stream.
 */
export function inflateRaw(input, expectedSize) {
  if (!(input instanceof Uint8Array)) throw TypeError('inflateRaw needs a Uint8Array');
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw TypeError('inflateRaw needs a non-negative expected size');
  const out = new Uint8Array(expectedSize);
  let outPos = 0;
  let inPos = 0;
  let bitBuf = 0;
  let bitCount = 0;

  const need = n => {
    while (bitCount < n) {
      if (inPos >= input.length) refuse('MXL_DEFLATE_TRUNCATED', 'compressed data ended early');
      bitBuf |= input[inPos++] << bitCount;
      bitCount += 8;
    }
  };
  const bits = n => {
    if (n === 0) return 0;
    need(n);
    const value = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCount -= n;
    return value;
  };
  const decode = table => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= MAXBITS; len += 1) {
      code |= bits(1);
      const count = table.counts[len];
      if (code - count < first) return table.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    return refuse('MXL_DEFLATE_INVALID', 'invalid Huffman code');
  };
  const put = byte => {
    if (outPos >= expectedSize) refuse('MXL_ENTRY_SIZE_MISMATCH', 'entry inflates beyond its declared size');
    out[outPos++] = byte;
  };

  const codes = (literal, distance) => {
    for (;;) {
      const symbol = decode(literal);
      if (symbol < 256) { put(symbol); continue; }
      if (symbol === 256) return;
      const lengthIndex = symbol - 257;
      if (lengthIndex >= 29) refuse('MXL_DEFLATE_INVALID', 'invalid length symbol');
      const length = LEN_BASE[lengthIndex] + bits(LEN_EXTRA[lengthIndex]);
      const distanceSymbol = decode(distance);
      if (distanceSymbol >= 30) refuse('MXL_DEFLATE_INVALID', 'invalid distance symbol');
      const dist = DIST_BASE[distanceSymbol] + bits(DIST_EXTRA[distanceSymbol]);
      if (dist > outPos) refuse('MXL_DEFLATE_INVALID', 'distance reaches before the start of the entry');
      if (outPos + length > expectedSize) refuse('MXL_ENTRY_SIZE_MISMATCH', 'entry inflates beyond its declared size');
      for (let k = 0; k < length; k += 1) { out[outPos] = out[outPos - dist]; outPos += 1; }
    }
  };

  const dynamicTables = () => {
    const nlen = bits(5) + 257;
    const ndist = bits(5) + 1;
    const ncode = bits(4) + 4;
    if (nlen > 286 || ndist > 30) refuse('MXL_DEFLATE_INVALID', 'too many length or distance codes');
    const lengths = new Uint8Array(nlen + ndist);
    const codeLengths = new Uint8Array(19);
    for (let i = 0; i < ncode; i += 1) codeLengths[CODE_LENGTH_ORDER[i]] = bits(3);
    const lengthCode = huffman(codeLengths, 19);
    if (lengthCode.incomplete) refuse('MXL_DEFLATE_INVALID', 'incomplete code-length code');
    for (let index = 0; index < nlen + ndist;) {
      const symbol = decode(lengthCode);
      if (symbol < 16) { lengths[index++] = symbol; continue; }
      let repeat;
      let value = 0;
      if (symbol === 16) {
        if (index === 0) refuse('MXL_DEFLATE_INVALID', 'repeat with no previous length');
        value = lengths[index - 1];
        repeat = 3 + bits(2);
      } else if (symbol === 17) repeat = 3 + bits(3);
      else repeat = 11 + bits(7);
      if (index + repeat > nlen + ndist) refuse('MXL_DEFLATE_INVALID', 'code lengths overflow');
      while (repeat--) lengths[index++] = value;
    }
    if (!lengths[256]) refuse('MXL_DEFLATE_INVALID', 'no end-of-block code');
    // An incomplete code is only valid when every length is 0 or 1 (a single
    // one-bit code, or no distance code at all) -- zlib's reference decoder
    // `puff.c` draws the same line.
    const literal = huffman(lengths.subarray(0, nlen), nlen);
    if (literal.incomplete && literal.counts[0] + literal.counts[1] !== nlen) refuse('MXL_DEFLATE_INVALID', 'incomplete literal/length code');
    const distance = huffman(lengths.subarray(nlen), ndist);
    if (distance.incomplete && distance.counts[0] + distance.counts[1] !== ndist) refuse('MXL_DEFLATE_INVALID', 'incomplete distance code');
    return { literal, distance };
  };

  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0;
      bitCount = 0;
      if (inPos + 4 > input.length) refuse('MXL_DEFLATE_TRUNCATED', 'stored block header ended early');
      const length = input[inPos] | (input[inPos + 1] << 8);
      const inverse = input[inPos + 2] | (input[inPos + 3] << 8);
      inPos += 4;
      if (length !== (~inverse & 0xffff)) refuse('MXL_DEFLATE_INVALID', 'stored block length check failed');
      if (inPos + length > input.length) refuse('MXL_DEFLATE_TRUNCATED', 'stored block ended early');
      if (outPos + length > expectedSize) refuse('MXL_ENTRY_SIZE_MISMATCH', 'entry inflates beyond its declared size');
      out.set(input.subarray(inPos, inPos + length), outPos);
      inPos += length;
      outPos += length;
    } else if (type === 1) {
      const fixed = fixedTables();
      codes(fixed.literal, fixed.distance);
    } else if (type === 2) {
      const tables = dynamicTables();
      codes(tables.literal, tables.distance);
    } else refuse('MXL_DEFLATE_INVALID', 'reserved block type');
  }
  if (outPos !== expectedSize) refuse('MXL_ENTRY_SIZE_MISMATCH', `entry inflated to ${outPos} bytes, declared ${expectedSize}`);
  return out;
}

// ─── ZIP directory ─────────────────────────────────────────────────────────

const utf8 = new TextDecoder('utf-8', { fatal: true });

function entryName(bytes, flags) {
  // Names are ASCII in every real MusicXML container. Bit 11 declares UTF-8;
  // without it the legacy code page is not guessed at, only ASCII is accepted.
  if (flags & 0x0800) {
    try { return utf8.decode(bytes); } catch { return refuse('MXL_ENTRY_NAME_INVALID', 'entry name is not valid UTF-8'); }
  }
  for (const byte of bytes) if (byte > 0x7e || byte < 0x20) refuse('MXL_ENTRY_NAME_INVALID', 'entry name is not ASCII and is not flagged UTF-8');
  return String.fromCharCode(...bytes);
}

function assertSafeName(name) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    refuse('MXL_ENTRY_PATH_UNSAFE', `entry name is not a relative archive path: ${JSON.stringify(name.slice(0, 120))}`);
  }
  if (name.split('/').some(segment => segment === '..' || segment === '.')) {
    refuse('MXL_ENTRY_PATH_UNSAFE', `entry name contains a dot segment: ${JSON.stringify(name.slice(0, 120))}`);
  }
}

/**
 * List the central directory of a ZIP archive, strictly.
 *
 * Returns `[{ name, method, flags, crc, compressedSize, size, dataStart }]`.
 */
export function readZipDirectory(bytes, limits = MXL_LIMITS) {
  if (!(bytes instanceof Uint8Array)) throw TypeError('readZipDirectory needs a Uint8Array');
  if (bytes.length > limits.maxArchiveBytes) refuse('MXL_ARCHIVE_TOO_LARGE', `archive is ${bytes.length} bytes; the limit is ${limits.maxArchiveBytes}`, { bytes: bytes.length, max: limits.maxArchiveBytes });
  if (!isZipContainer(bytes)) refuse('MXL_NOT_ZIP', 'input does not start with a ZIP local file header');
  if (bytes.length < 22) refuse('MXL_ARCHIVE_TRUNCATED', 'archive is shorter than an end-of-central-directory record');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (view.getUint32(at, true) === SIG_EOCD && at + 22 + view.getUint16(at + 20, true) === bytes.length) { eocd = at; break; }
  }
  if (eocd < 0) refuse('MXL_ARCHIVE_TRUNCATED', 'no end-of-central-directory record');
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === SIG_ZIP64_LOCATOR) refuse('MXL_ZIP64_UNSUPPORTED', 'ZIP64 archives are not supported');
  const disk = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) refuse('MXL_ZIP64_UNSUPPORTED', 'ZIP64 archives are not supported');
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) refuse('MXL_MULTIDISK_UNSUPPORTED', 'multi-disk archives are not supported');
  if (entryCount > limits.maxEntries) refuse('MXL_TOO_MANY_ENTRIES', `archive has ${entryCount} entries; the limit is ${limits.maxEntries}`, { entries: entryCount, max: limits.maxEntries });
  if (directoryOffset + directorySize > eocd) refuse('MXL_ARCHIVE_TRUNCATED', 'central directory lies outside the archive');

  const entries = [];
  const seen = new Set();
  let at = directoryOffset;
  for (let n = 0; n < entryCount; n += 1) {
    if (at + 46 > eocd || view.getUint32(at, true) !== SIG_CENTRAL) refuse('MXL_ARCHIVE_CORRUPT', 'central directory entry is damaged');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    if (nameLength > limits.maxNameBytes) refuse('MXL_ENTRY_NAME_INVALID', 'entry name is too long');
    if (at + 46 + nameLength + extraLength + commentLength > eocd) refuse('MXL_ARCHIVE_CORRUPT', 'central directory entry overruns the directory');
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    const name = entryName(nameBytes, flags);
    at += 46 + nameLength + extraLength + commentLength;

    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) refuse('MXL_ZIP64_UNSUPPORTED', `entry ${name} uses ZIP64 sizes`);
    if (flags & 0x0001 || flags & 0x0040) refuse('MXL_ENCRYPTED_UNSUPPORTED', `entry ${name} is encrypted`);
    assertSafeName(name);
    if (seen.has(name)) refuse('MXL_DUPLICATE_ENTRY', `archive holds two entries named ${name}`);
    seen.add(name);

    if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== SIG_LOCAL) refuse('MXL_ARCHIVE_CORRUPT', `local header of ${name} is damaged`);
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (localMethod !== method || (localFlags & 0x0001) !== (flags & 0x0001)
      || localName.length !== nameBytes.length || localName.some((byte, index) => byte !== nameBytes[index])) {
      refuse('MXL_ARCHIVE_CORRUPT', `local header of ${name} disagrees with the central directory`);
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > directoryOffset) refuse('MXL_ARCHIVE_CORRUPT', `data of ${name} lies outside the archive`);
    entries.push(Object.freeze({ name, method, flags, crc, compressedSize, size, dataStart }));
  }
  return Object.freeze(entries);
}

function readEntry(bytes, entry, maxBytes, label) {
  if (entry.name.endsWith('/')) refuse('MXL_ENTRY_NOT_A_FILE', `${label} ${entry.name} is a directory`);
  if (entry.size > maxBytes) refuse('MXL_ENTRY_TOO_LARGE', `${label} ${entry.name} declares ${entry.size} bytes; the limit is ${maxBytes}`, { entry: entry.name, bytes: entry.size, max: maxBytes });
  const packed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  let data;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) refuse('MXL_ENTRY_SIZE_MISMATCH', `stored entry ${entry.name} has different packed and unpacked sizes`);
    data = packed;
  } else if (entry.method === 8) {
    data = inflateRaw(packed, entry.size);
  } else refuse('MXL_METHOD_UNSUPPORTED', `entry ${entry.name} uses compression method ${entry.method}; only stored (0) and deflate (8) are supported`, { entry: entry.name, method: entry.method });
  if (crc32(data) !== entry.crc) refuse('MXL_CRC_MISMATCH', `entry ${entry.name} failed its CRC-32 check`);
  return data;
}

const containerParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, processEntities: false });
const asList = value => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);

function decodeUtf8(data, label) {
  try {
    return utf8.decode(data);
  } catch {
    return refuse('MXL_ROOTFILE_NOT_UTF8', `${label} is not valid UTF-8 text`);
  }
}

/**
 * The rootfile path named by `META-INF/container.xml`.
 *
 * The MusicXML container specification makes the first `<rootfile>` the
 * document to read; later rootfiles are alternates (a PDF, another rendering).
 * A first rootfile whose media type is declared and is not MusicXML is refused
 * rather than skipped past.
 */
export function rootfilePath(containerXml) {
  if (/<!ENTITY\b/i.test(containerXml) || /<!DOCTYPE[^>]*\[/i.test(containerXml)) refuse('MXL_CONTAINER_INVALID', 'container.xml carries a DTD subset or entities');
  if (XMLValidator.validate(containerXml) !== true) refuse('MXL_CONTAINER_INVALID', 'container.xml is not well-formed XML');
  const parsed = containerParser.parse(containerXml);
  const rootfiles = asList(parsed?.container?.rootfiles?.rootfile);
  if (!rootfiles.length) refuse('MXL_CONTAINER_INVALID', 'container.xml names no rootfile');
  const first = rootfiles[0];
  const path = typeof first?.['@_full-path'] === 'string' ? first['@_full-path'].trim() : '';
  if (!path) refuse('MXL_CONTAINER_INVALID', 'the first rootfile has no full-path');
  const mediaType = typeof first['@_media-type'] === 'string' ? first['@_media-type'].trim() : null;
  if (mediaType && !/^application\/vnd\.recordare\.musicxml(\+xml)?$/i.test(mediaType)) {
    refuse('MXL_ROOTFILE_NOT_MUSICXML', `the first rootfile is declared ${mediaType}, not MusicXML`);
  }
  assertSafeName(path);
  return { path, mediaType, rootfileCount: rootfiles.length };
}

/**
 * Extract the MusicXML document from .mxl bytes.
 *
 * Returns the XML text plus a provenance record. The archive bytes stay the
 * source of identity (their digest is the asset's); the XML is derived, and the
 * record says exactly which entry it was derived from and what that entry's
 * digest is, so a reader can re-derive and compare.
 */
export function extractMusicXmlFromMxl(bytes, limits = MXL_LIMITS) {
  const entries = readZipDirectory(bytes, limits);
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  const containerEntry = byName.get('META-INF/container.xml');
  if (!containerEntry) refuse('MXL_CONTAINER_MISSING', 'archive has no META-INF/container.xml');
  const containerXml = decodeUtf8(readEntry(bytes, containerEntry, limits.maxContainerXmlBytes, 'container'), 'META-INF/container.xml');
  const rootfile = rootfilePath(containerXml);
  const entry = byName.get(rootfile.path);
  if (!entry) refuse('MXL_ROOTFILE_MISSING', `container.xml names ${rootfile.path}, which the archive does not hold`);
  const data = readEntry(bytes, entry, limits.maxRootfileBytes, 'rootfile');
  const xml = decodeUtf8(data, rootfile.path);
  return Object.freeze({
    xml,
    container: Object.freeze({
      format: 'mxl',
      archiveBytes: bytes.length,
      entryCount: entries.length,
      rootfile: rootfile.path,
      rootfileMediaType: rootfile.mediaType,
      rootfileCount: rootfile.rootfileCount,
      rootfileBytes: data.length,
      rootfileCompressedBytes: entry.compressedSize,
      rootfileMethod: entry.method === 8 ? 'deflate' : 'stored',
      rootfileSha256: sha256Hex(data),
    }),
  });
}
