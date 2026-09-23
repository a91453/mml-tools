// The GM sound bank the audio prescreen renders with.
//
// Status: IMPLEMENTATION NOTES. The bank is never stored in this repository or
// in the service image. The service downloads one pinned file on first need,
// verifies its SHA-256 and size, and caches it under the service data
// directory (MML_STUDIO_DATA_DIR, or /data when that is unset). Every later
// load re-verifies the cached bytes. Anything that does not verify is refused
// with a code, never used "close enough": a different bank would make two
// reports with the same inputs disagree, and the report names the bank it used.
//
// This is the only outbound request the Studio service makes, and it fetches a
// public, pinned, content-verified file; no project data leaves the service.
// An operator can pre-seed the cache (a file named <sha256>.sf3 in the cache
// directory) and turn downloading off with MML_STUDIO_AUDIO_BANK_FETCH=0.
//
// A free GM bank is not the game's timbre. Nothing rendered with it is player
// readback, original-audio evidence or in-game evidence.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FREE_GM_BANK = Object.freeze({
  id: 'fluidr3mono-gm-sf3@musescore-v2.3.2',
  name: 'FluidR3Mono GM (SF3)',
  url: 'https://raw.githubusercontent.com/musescore/MuseScore/v2.3.2/share/sound/FluidR3Mono_GM.sf3',
  sha256: 'cfcd66d89e8386823400eca64934b14fbea7bf48ba1f00d21189af1262794ec2',
  bytes: 14563174,
  format: 'sf3',
  license: 'MIT (FluidR3 GM, mono SF3 edition distributed with MuseScore v2.3.2); downloaded at run time, not redistributed by this repository',
  label: '免費通用音色（近似），不是遊戲音色',
});

export const AUDIO_BANK_ERROR = Object.freeze({
  UNAVAILABLE: 'AUDIO_BANK_UNAVAILABLE',
  HASH_MISMATCH: 'AUDIO_BANK_HASH_MISMATCH',
});

export class SoundBankError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SoundBankError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const repositoryRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

function validDescriptor(bank) {
  if (!bank || typeof bank !== 'object' || !HEX64.test(bank.sha256 ?? '') || !Number.isSafeInteger(bank.bytes) || bank.bytes <= 0
    || typeof bank.id !== 'string' || !/^[a-z0-9][a-z0-9.@_-]{0,80}$/.test(bank.id) || !['sf2', 'sf3'].includes(bank.format)) {
    throw Error('invalid sound bank descriptor');
  }
  return bank;
}

const insideRepository = directory => {
  const path = relative(repositoryRoot, resolve(directory));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

/** The cache directory for a service data directory, never inside this repository. */
export function bankCacheDirectory({ dataDirectory = null, env = process.env } = {}) {
  const base = dataDirectory ?? env.MML_STUDIO_DATA_DIR ?? '/data';
  return join(base, 'audio-banks');
}

/**
 * A lazily loading, verifying bank provider.
 *
 * `bytes` injects a bank directly (tests use a tiny synthetic bank and never
 * reach the network); it is verified against the descriptor like a download.
 * `fetchImpl` is the download function; `allowDownload: false` makes a missing
 * cache a refusal instead of a request.
 */
export function createSoundBankProvider({
  bank = FREE_GM_BANK,
  bytes = null,
  cacheDirectory = null,
  fetchImpl = globalThis.fetch,
  allowDownload = true,
  timeoutMs = 120000,
} = {}) {
  const descriptor = validDescriptor(bank);
  let pending = null;

  const identity = cache => Object.freeze({
    id: descriptor.id,
    name: descriptor.name ?? descriptor.id,
    sha256: descriptor.sha256,
    bytes: descriptor.bytes,
    format: descriptor.format,
    url: descriptor.url ?? null,
    license: descriptor.license ?? null,
    label: descriptor.label ?? '免費通用音色（近似），不是遊戲音色',
    cache,
  });

  const verify = (candidate, origin) => {
    if (candidate.byteLength !== descriptor.bytes) {
      throw new SoundBankError(AUDIO_BANK_ERROR.HASH_MISMATCH, 'The sound bank does not have the pinned size; it was not used.', { reason: 'SIZE_MISMATCH', origin, expected_bytes: descriptor.bytes, actual_bytes: candidate.byteLength });
    }
    const digest = sha256(candidate);
    if (digest !== descriptor.sha256) {
      throw new SoundBankError(AUDIO_BANK_ERROR.HASH_MISMATCH, 'The sound bank does not have the pinned SHA-256; it was not used.', { reason: 'SHA256_MISMATCH', origin, expected_sha256: descriptor.sha256, actual_sha256: digest });
    }
    return candidate;
  };

  const cachePath = () => (cacheDirectory && !insideRepository(cacheDirectory)
    ? join(cacheDirectory, `${descriptor.sha256}.${descriptor.format}`)
    : null);

  const readCache = path => {
    let cached;
    try { cached = new Uint8Array(readFileSync(path)); } catch { return null; }
    try { return verify(cached, 'cache'); }
    catch {
      // A cache file that does not verify is not a bank; drop it and fetch.
      try { rmSync(path, { force: true }); } catch { /* keep going to the download */ }
      return null;
    }
  };

  const writeCache = (path, downloaded) => {
    try {
      mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
      writeFileSync(temporary, downloaded, { mode: 0o600 });
      renameSync(temporary, path);
      return 'disk';
    } catch {
      return 'memory-only';
    }
  };

  async function download() {
    if (!allowDownload) {
      throw new SoundBankError(AUDIO_BANK_ERROR.UNAVAILABLE, 'The prescreen sound bank is not cached and downloading it is turned off.', { reason: 'DOWNLOAD_DISABLED', sha256: descriptor.sha256 });
    }
    if (typeof fetchImpl !== 'function' || !descriptor.url) {
      throw new SoundBankError(AUDIO_BANK_ERROR.UNAVAILABLE, 'The prescreen sound bank cannot be downloaded in this process.', { reason: 'NO_DOWNLOADER', sha256: descriptor.sha256 });
    }
    let response;
    try {
      response = await fetchImpl(descriptor.url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new SoundBankError(AUDIO_BANK_ERROR.UNAVAILABLE, 'The prescreen sound bank could not be downloaded.', { reason: 'DOWNLOAD_FAILED', url: descriptor.url });
    }
    if (!response?.ok) {
      throw new SoundBankError(AUDIO_BANK_ERROR.UNAVAILABLE, 'The prescreen sound bank download was refused by its host.', { reason: 'DOWNLOAD_FAILED', url: descriptor.url, status: response?.status ?? null });
    }
    let body;
    try { body = new Uint8Array(await response.arrayBuffer()); }
    catch {
      throw new SoundBankError(AUDIO_BANK_ERROR.UNAVAILABLE, 'The prescreen sound bank download was interrupted.', { reason: 'DOWNLOAD_FAILED', url: descriptor.url });
    }
    return verify(body, 'download');
  }

  async function loadOnce() {
    if (bytes) return { bytes: verify(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), 'injected'), identity: identity('injected') };
    const path = cachePath();
    const cached = path ? readCache(path) : null;
    if (cached) return { bytes: cached, identity: identity('disk') };
    const downloaded = await download();
    return { bytes: downloaded, identity: identity(path ? writeCache(path, downloaded) : 'memory-only') };
  }

  return Object.freeze({
    descriptor,
    /** Verified bank bytes and the identity a report names. Retries after a failure. */
    load() {
      if (!pending) pending = loadOnce().catch(error => { pending = null; throw error; });
      return pending;
    },
  });
}
