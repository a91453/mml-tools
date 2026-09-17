// Asset intake and identity.
//
// Status: IMPLEMENTATION NOTES. An asset is bytes plus the metadata needed to
// say what those bytes are and where they came from. It is the binary data
// plane: a 30 MB recording is uploaded once over HTTP, gets an `asset_id`, and
// from then on agents pass that id. Nothing here ever base64-encodes an asset
// into a tool response, and the MCP surface has no way to carry one.
//
// Three properties are load-bearing:
//
//   * the upload filename is metadata and nothing else. It is stored, echoed
//     back, and never used to choose a parser, build a path, or identify an
//     asset. The stored name is derived from the generated `asset_id`;
//   * the byte identity is SHA-256 over the exact bytes received, computed
//     here. A caller cannot assert a digest;
//   * an asset belongs to exactly one project. An `asset_id` from another
//     project is not found, whoever owns it.

import {
  ASSET_KIND_INTAKE,
  ERROR_CODES,
  LIMITS,
  isAssetId,
  isAssetKind,
  fail,
  requireString,
} from './contracts.mjs';
import { ID_PREFIX, newId, sha256Of } from './store.mjs';

const now = () => new Date().toISOString();

// Media types accepted for upload. An unrecognized type is refused rather than
// guessed: choosing a parser from a caller-supplied label is how a MusicXML
// document ends up in a MIDI decoder.
const MEDIA_TYPES = Object.freeze({
  'audio/mp4': true,
  'audio/m4a': true,
  'audio/x-m4a': true,
  'audio/mpeg': true,
  'audio/flac': true,
  'audio/x-flac': true,
  'audio/wav': true,
  'audio/x-wav': true,
  'audio/midi': true,
  'audio/x-midi': true,
  'application/octet-stream': true,
  'application/xml': true,
  'text/xml': true,
  'application/json': true,
  'text/plain': true,
});

export const ACCEPTED_MEDIA_TYPES = Object.freeze(Object.keys(MEDIA_TYPES));

export function createAssetService({ store, projects }) {
  const blobKey = (projectId, assetId) => `asset:${projectId}:${assetId}`;

  const findAsset = (record, assetId) => {
    if (!isAssetId(assetId)) fail(ERROR_CODES.ASSET_NOT_FOUND, 'Unknown asset', { asset_id: String(assetId).slice(0, 64) });
    // Scoped to this project's own list, so an id that exists elsewhere is
    // simply not here. Cross-project reference needs no separate check.
    const asset = record.assets.find(entry => entry.asset_id === assetId);
    if (!asset) fail(ERROR_CODES.ASSET_NOT_FOUND, 'Unknown asset', { asset_id: assetId, project_id: record.project_id });
    return asset;
  };

  return Object.freeze({
    /**
     * Store bytes as a project asset.
     *
     * `filename` and `mediaType` are declarations by the uploader. `kind` is the
     * only one of the three that changes behaviour, and it must be an exact
     * member of the asset vocabulary.
     */
    upload(owner, projectId, { kind, filename, mediaType = 'application/octet-stream', bytes }) {
      const record = projects.load(owner, projectId);
      if (!isAssetKind(kind)) {
        fail(ERROR_CODES.INVALID_ASSET_KIND, `Unknown asset kind: ${String(kind).slice(0, 64)}`, { accepted: Object.keys(ASSET_KIND_INTAKE) });
      }
      if (!(bytes instanceof Uint8Array)) fail(ERROR_CODES.INVALID_REQUEST, 'Asset bytes are required');
      if (bytes.byteLength === 0) fail(ERROR_CODES.INVALID_REQUEST, 'Asset is empty');
      if (bytes.byteLength > LIMITS.maxAssetBytes) {
        fail(ERROR_CODES.PAYLOAD_TOO_LARGE, 'Asset exceeds the configured upload limit', { max_bytes: LIMITS.maxAssetBytes, received_bytes: bytes.byteLength });
      }
      if (record.assets.length >= LIMITS.maxAssetsPerProject) {
        fail(ERROR_CODES.STORAGE_FULL, 'This project already holds the maximum number of assets.', { max_assets: LIMITS.maxAssetsPerProject });
      }
      const declaredType = requireString(mediaType, 'media_type', { max: 120 }).toLowerCase();
      if (!Object.hasOwn(MEDIA_TYPES, declaredType)) {
        fail(ERROR_CODES.INVALID_REQUEST, `Unsupported media type: ${declaredType}`, { accepted: ACCEPTED_MEDIA_TYPES });
      }

      const asset = {
        asset_id: newId(ID_PREFIX.asset),
        project_id: record.project_id,
        kind,
        // Kept for a human reading a report. It never reaches a filesystem
        // path, a parser selection or an identity comparison.
        filename: filename === undefined || filename === null || filename === ''
          ? null
          : requireString(filename, 'filename', { max: LIMITS.maxFilenameLength }),
        sha256: sha256Of(bytes),
        size: bytes.byteLength,
        media_type: declaredType,
        uploaded_at: now(),
      };
      store.putBytes(blobKey(record.project_id, asset.asset_id), bytes);
      projects.save({ ...record, assets: [...record.assets, asset] });
      return Object.freeze({ ...asset });
    },

    list(owner, projectId) {
      const record = projects.load(owner, projectId);
      return Object.freeze(record.assets.map(asset => Object.freeze({ ...asset })));
    },

    metadata(owner, projectId, assetId) {
      return Object.freeze({ ...findAsset(projects.load(owner, projectId), assetId) });
    },

    /**
     * The exact bytes an asset was uploaded with, for server-side use.
     *
     * The digest is re-checked on read. A blob that no longer matches the
     * metadata it is filed under is refused rather than parsed: an intake that
     * silently consumed different bytes than the ones its report names would
     * make every downstream provenance claim false.
     */
    read(owner, projectId, assetId) {
      const record = projects.load(owner, projectId);
      const asset = findAsset(record, assetId);
      const bytes = store.getBytes(blobKey(record.project_id, asset.asset_id));
      if (!bytes) fail(ERROR_CODES.ASSET_NOT_FOUND, 'Asset bytes are no longer available', { asset_id: assetId, project_id: record.project_id });
      if (bytes.byteLength !== asset.size || sha256Of(bytes) !== asset.sha256) {
        fail(ERROR_CODES.ASSET_NOT_FOUND, 'Stored asset bytes do not match the recorded asset identity', { asset_id: assetId, project_id: record.project_id });
      }
      return { asset: Object.freeze({ ...asset }), bytes };
    },

    text(owner, projectId, assetId) {
      const { asset, bytes } = this.read(owner, projectId, assetId);
      if (bytes.byteLength > LIMITS.maxInlineTextBytes) {
        fail(ERROR_CODES.PAYLOAD_TOO_LARGE, 'Asset is too large to read as text', { max_bytes: LIMITS.maxInlineTextBytes });
      }
      try {
        return { asset, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
      } catch {
        return fail(ERROR_CODES.UNSUPPORTED_SOURCE, 'Asset is not valid UTF-8 text', { asset_id: assetId });
      }
    },

    find: findAsset,
  });
}
