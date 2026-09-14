# mml.mabi.tw frontend snapshot

Status: `THIRD_PARTY_REFERENCE` only.
Not Canonical. Not an implementer. Not a Studio module.

- Site: https://mml.mabi.tw/
- Author: 梅文．夜光 / sakuraakira
- Captured: 2026-09-14
- Site version observed: v1.1.0
- Purpose: local comparison against `a91453/mml-tools` behaviour
- Authority: `docs/SOURCE_POLICY.md` class F / tool evidence
- Source archive SHA-256: `a3c152d8f2a0e94303ae80f82ffc096a3b3c585ef9d0e3efd6e2edeadf7abcb3`

Do not load this tree as rules, do not copy files into `studio/`,
and do not treat parse/export/play success here as source truth
or in-game acceptance.

## Included

This directory now mirrors the complete first-party/public frontend payload
present in the user-supplied capture, subject only to the explicit third-party
binary/dependency exclusions below.

- `js/` site ES modules and i18n
- `css/` first-party editor/legal/waterfall styles
- `pages/` public HTML (guides, FAQ, terms, privacy, locales)
- locale and default offline shells
- PWA icons and favicon
- `sw.js`, `worklet-boot.js`, web manifests
- `Fury_Sound_Pack_v150.def` instrument whitelist
- `FETCH_MANIFEST.tsv`: 101 mirrored files with source path, byte length and SHA-256
- `SNAPSHOT_PROVENANCE.md`: archive identity and exclusion boundary
- `UPSTREAM_README.md`: README that accompanied the captured frontend archive

The mirrored files were downloaded from the public site on the work branch and
accepted only when both byte length and SHA-256 matched the uploaded ZIP. The
same run then passed JavaScript syntax checks for the mirrored site modules,
`sw.js`, and `worklet-boot.js` before committing the snapshot.

## Excluded on purpose / unavailable

- `Fury_Sound_Pack_v150.dls` (~15.3 MB third-party bank; redistribution/licensing risk)
- `vendor/**` dependency copies (use upstream projects and their licenses instead)
- environment-audio MP3 assets referenced by `js/envaudio.js` (not present in the uploaded ZIP)
- `/login` Google-hosted HTML
- `/api/*` ASP.NET backend, database, shared user scores
- server Razor / C# / `.resx` (not public)

These exclusions mean this is a complete captured **public first-party frontend
reference**, not a claim that the entire production site/backend can be rebuilt
offline from this directory alone.

## Comparison notes

Official six-role / 2400-character limits already live in Published
Canonical `2026-09-13-v1`. This snapshot may show community-tool
conventions that disagree with Final policy (`c48`, `c64.`, 15-track
editor, GM channel map). Record disagreements; do not silently
promote them into rules.
