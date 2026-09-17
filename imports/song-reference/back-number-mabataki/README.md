# Song Reference Package — back number〈瞬き〉

**song_id:** `back-number-mabataki`  
**Current accepted:** `v29R`  
**Package status:** `READY_FOR_GIT_IMPORT`

This is a portable, read-only Song Reference Package assembled from the current conversation and locally retained artifacts. It does **not** modify GitHub and it does **not** redefine Canonical rules.

## What the future importing agent should do

1. Re-load `a91453/mml-tools` Published Canonical from `docs/CANONICAL_MANIFEST.md`.
2. Inspect the repository's current Song Reference schema.
3. Map this portable package into that schema without changing the accepted MML.
4. Preserve provenance distinctions: source facts, song-specific decisions, Mobile adaptations, user device feedback, derived analysis, reusable-insight candidates.
5. Keep `v29R` as current accepted unless new source or target-client evidence explicitly supersedes it.

## Package contents

- `song-context.json` — primary machine-readable export.
- `source-inventory.json` — source metadata only; no source binaries.
- `history-audit.md` — curated version/feedback history.
- `arrangement-notes.md` — song-specific arrangement decisions and interpretation.
- `validation-summary.md` — historical recorded results vs checks newly run during package assembly.
- `current-accepted.mml` — exact accepted v29R text.
- `historical/` — only selected milestones: v13, SF6R, TL1.
- `package-manifest.json` — package file hashes/integrity metadata.

## Important boundaries

- `v29R` is current accepted because the user ultimately preferred its cleaner presentation over fuller same/similar-instrument layering.
- SF6R and TL1 are important A/B references, not current Final.
- Third-party material is supporting arrangement evidence only.
- No `.m4a`, `.mp3`, `.wav`, `.flac`, commercial score PDF, purchased MIDI, or third-party MIDI binary is included.
- The detailed Source-Faithful event map is also omitted because it may reproduce too much source MIDI content.
- Reusable insights remain **candidates** only; none are promoted to `CANONICAL_RULE` or `ARTIST_RULE_CONFIRMED`.

## Canonical context read for export

- canonical_version: `2026-09-13-v1`
- canonical_status: `PUBLISHED`
- manifest_version: `2026-09-13-v1-manifest1`
- rules_snapshot_sha: `0a172900a01fdf39c2e9e84cf176961320b779ea`
- manifest_commit: `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14`
- main HEAD at export: `d47f64c3413b96eccf13423e90c75993152828d2`

No GitHub write action was performed.
