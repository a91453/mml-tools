// Minimal repository for Application Service records.
//
// Status: IMPLEMENTATION NOTES. Deliberately the smallest durable thing that
// satisfies the contract: a directory of JSON records plus a flat blob store,
// or the same shape in memory when no directory is configured.
//
// Zero additional recurring cost is a requirement, not a preference. This
// introduces no database, no object storage, no queue and no cache service. On
// the existing deployment it reuses the volume that is already mounted and
// already paid for; with no directory configured it stays in memory, and the
// capability record says `ephemeral` rather than implying a durability nobody
// provisioned.
//
// Path safety is structural rather than checked. No caller-supplied string ever
// becomes part of a path: every record id is generated here and matched against
// an exact `[0-9a-f]` pattern before use, and every other key (a candidate
// revision id, an artifact key) is hashed to a hex filename. An upload filename
// is stored as metadata and is never opened, joined, resolved or served from.

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ERROR_CODES, ID_PREFIX, LIMITS, fail } from './contracts.mjs';

const HEX_ID = /^[0-9a-f]{32}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');

export const newId = prefix => `${prefix}${randomBytes(16).toString('hex')}`;
export const sha256Of = bytes => createHash('sha256').update(bytes).digest('hex');

const suffixOf = id => {
  const suffix = String(id).slice(-32);
  if (!HEX_ID.test(suffix)) fail(ERROR_CODES.INVALID_REQUEST, 'Malformed record identifier');
  return suffix;
};

// A stable, filesystem-safe name for a key that is not itself a generated id
// (a `g11d:rev:` candidate id, a `bas:` baseline id, an artifact key).
const blobName = key => sha256(String(key));

function memoryBackend() {
  const records = new Map();
  const blobs = new Map();
  return {
    durability: 'ephemeral',
    backend: 'memory',
    notice: 'No data directory is configured, so records live in this process only and are lost when it restarts.',
    listRecordIds: () => [...records.keys()],
    readRecord: id => (records.has(id) ? structuredClone(records.get(id)) : null),
    writeRecord: (id, value) => { records.set(id, structuredClone(value)); },
    deleteRecord: id => { records.delete(id); },
    readBlob: key => {
      const bytes = blobs.get(blobName(key));
      return bytes ? Uint8Array.from(bytes) : null;
    },
    blobSize: key => blobs.get(blobName(key))?.byteLength ?? 0,
    writeBlob: (key, bytes) => { blobs.set(blobName(key), Uint8Array.from(bytes)); },
    deleteBlob: key => { blobs.delete(blobName(key)); },
    usedBytes: () => [...blobs.values()].reduce((total, bytes) => total + bytes.byteLength, 0),
  };
}

function filesystemBackend(directory, { durability, notice }) {
  const recordsDir = join(directory, 'records');
  const blobsDir = join(directory, 'blobs');
  mkdirSync(recordsDir, { recursive: true, mode: 0o700 });
  mkdirSync(blobsDir, { recursive: true, mode: 0o700 });

  // Temp-then-rename: a reader never observes a partially written record, and a
  // crash mid-write leaves the previous record intact.
  const writeAtomic = (path, bytes) => {
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    writeFileSync(temporary, bytes, { mode: 0o600 });
    renameSync(temporary, path);
  };

  const recordPath = id => join(recordsDir, `${suffixOf(id)}.json`);
  const blobPath = key => join(blobsDir, `${blobName(key)}.bin`);

  return {
    durability,
    backend: 'filesystem',
    notice,
    listRecordIds() {
      return readdirSync(recordsDir)
        .filter(name => name.endsWith('.json'))
        .map(name => {
          try { return JSON.parse(readFileSync(join(recordsDir, name), 'utf8')).project_id; }
          catch { return null; }
        })
        .filter(Boolean);
    },
    readRecord(id) {
      try { return JSON.parse(readFileSync(recordPath(id), 'utf8')); }
      catch { return null; }
    },
    writeRecord(id, value) {
      writeAtomic(recordPath(id), Buffer.from(JSON.stringify(value), 'utf8'));
    },
    deleteRecord(id) {
      rmSync(recordPath(id), { force: true });
    },
    readBlob(key) {
      try { return new Uint8Array(readFileSync(blobPath(key))); }
      catch { return null; }
    },
    blobSize(key) {
      try { return statSync(blobPath(key)).size; }
      catch (error) {
        if (error.code === 'ENOENT') return 0;
        throw error;
      }
    },
    writeBlob(key, bytes) {
      writeAtomic(blobPath(key), Buffer.from(bytes));
    },
    deleteBlob(key) {
      rmSync(blobPath(key), { force: true });
    },
    usedBytes() {
      let total = 0;
      for (const name of readdirSync(blobsDir)) {
        try { total += statSync(join(blobsDir, name)).size; } catch { /* removed between listing and stat */ }
      }
      return total;
    },
  };
}

/**
 * Create the repository.
 *
 * `directory` is an operator decision, never a client one. `durability` is
 * reported, not assumed: an operator who has mounted a persistent volume says
 * so explicitly, because a service that claims durability it does not have is
 * worse than one that admits it is ephemeral.
 */
export function createStore({ directory = null, durability = 'unknown', maxBytes = LIMITS.maxStoreBytes } = {}) {
  const backend = directory
    ? filesystemBackend(directory, {
      durability: durability === 'persistent' ? 'persistent' : 'ephemeral',
      notice: durability === 'persistent'
        ? 'Records are written to an operator-declared persistent volume.'
        : 'Records are written to a filesystem the operator has not declared persistent; a container restart may discard them.',
    })
    : memoryBackend();

  const describe = () => Object.freeze({
    durability: backend.durability,
    backend: backend.backend,
    notice: backend.notice,
  });

  const requireCapacity = (key, byteLength) => {
    // Re-analyzing a baseline and updating review/audio evidence replace an
    // existing key. Charge the resulting store size, not old + new bytes.
    const resultingBytes = backend.usedBytes() - backend.blobSize(key) + byteLength;
    if (resultingBytes > maxBytes) {
      fail(ERROR_CODES.STORAGE_FULL, 'The configured Studio asset store is full; remove a project before uploading more.', { max_bytes: maxBytes });
    }
  };

  return Object.freeze({
    describe,

    createProjectRecord(record) {
      backend.writeRecord(record.project_id, record);
      return structuredClone(record);
    },

    readProjectRecord(projectId) {
      return backend.readRecord(projectId);
    },

    writeProjectRecord(record) {
      backend.writeRecord(record.project_id, record);
      return structuredClone(record);
    },

    listProjectRecords(owner) {
      return backend.listRecordIds()
        .map(id => backend.readRecord(id))
        .filter(record => record && record.owner === owner);
    },

    deleteProjectRecord(projectId) {
      backend.deleteRecord(projectId);
    },

    putBytes(key, bytes) {
      requireCapacity(key, bytes.byteLength);
      backend.writeBlob(key, bytes);
    },

    getBytes(key) {
      return backend.readBlob(key);
    },

    deleteBytes(key) {
      backend.deleteBlob(key);
    },

    putJson(key, value) {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      requireCapacity(key, bytes.byteLength);
      backend.writeBlob(key, bytes);
      return bytes.byteLength;
    },

    getJson(key) {
      const bytes = backend.readBlob(key);
      if (!bytes) return null;
      try { return JSON.parse(new TextDecoder().decode(bytes)); }
      catch { return null; }
    },

    usedBytes: () => backend.usedBytes(),
    maxBytes,
  });
}

export { ID_PREFIX, blobName };
