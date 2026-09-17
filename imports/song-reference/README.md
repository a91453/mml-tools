# Song Reference Packages

`imports/song-reference/<song_id>/` holds imported, read-only Song Reference
Packages: the accepted MML for one song, selected historical versions, and the
song-specific context (sources, decisions, Mobile adaptations, device feedback,
validation history) that explains them.

These packages are **song context, not rules**. They are not indexed by
`docs/CANONICAL_MANIFEST.md`, hold no Canonical authority, and must not be
loaded as a substitute for the Published rule sources. A `canonical_context`
inside a package records which release the package was validated under; it is
provenance, not a snapshot to load.

Each package carries a `package-manifest.json` listing every file with its
SHA-256, byte length and Git blob SHA-1, and an `import-record.md` stating what
was verified when the package entered the repository and what was not re-run.
`studio/tests/song-reference-packages.test.mjs` checks every package on each
run: manifest integrity, no unlisted or prohibited-binary files, and that the
accepted and historical MML still split into six tracks and parse without
track-level errors under the current parser. Editing any package file requires
regenerating its manifest.

| song_id | Current accepted | Imported |
| --- | --- | --- |
| `back-number-mabataki` | `v29R` | 2026-09-17, see its `import-record.md` |
