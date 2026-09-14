# Snapshot provenance

Source archive: `mml.mabi.tw-frontend-complete-2026-09-14.zip`
Source archive SHA-256: `a3c152d8f2a0e94303ae80f82ffc096a3b3c585ef9d0e3efd6e2edeadf7abcb3`
Captured: 2026-09-14
Observed site version: v1.1.0
Authority: THIRD_PARTY_REFERENCE only.

This repository copy intentionally excludes:
- `Fury_Sound_Pack_v150.dls` (third-party binary sound bank; redistribution/licensing risk)
- `vendor/**` (upstream dependencies; keep version/license references instead of vendoring copies)

`FETCH_MANIFEST.tsv` records the SHA-256 and byte length of every mirrored first-party/public frontend file.
The one-shot importer refused to commit unless every downloaded byte matched the user-supplied ZIP.

The uploaded ZIP itself also did not contain the environment-audio MP3 assets referenced by `js/envaudio.js`; those are therefore not claimed as part of this captured snapshot.
