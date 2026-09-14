# mml.mabi.tw frontend snapshot

Status: `THIRD_PARTY_REFERENCE` only.
Not Canonical. Not an implementer. Not a Studio module.

- Site: https://mml.mabi.tw/
- Author: 梅文．夜光 / sakuraakira
- Captured: 2026-09-14
- Site version observed: v1.1.0
- Purpose: local comparison against `a91453/mml-tools` behaviour
- Authority: `docs/SOURCE_POLICY.md` class F / tool evidence

Do not load this tree as rules, do not copy files into `studio/`,
and do not treat parse/export/play success here as source truth
or in-game acceptance.

## Included

- `js/` site ES modules and i18n
- `css/editor.css`
- `pages/` public HTML (guides, FAQ, terms, locales)
- `sw.js`, `worklet-boot.js`, web manifests
- `Fury_Sound_Pack_v150.def` instrument whitelist

## Excluded on purpose

- `Fury_Sound_Pack_v150.dls` (~15.3 MB third-party bank)
- `vendor/spessasynth_*` (get upstream: SpessaSynth, Apache-2.0)
- `/login` Google-hosted HTML
- `/api/*` ASP.NET backend, database, shared user scores
- server Razor / C# / .resx (not public)

## Comparison notes

Official six-role / 2400-character limits already live in Published
Canonical `2026-09-13-v1`. This snapshot may show community-tool
conventions that disagree with Final policy (`c48`, `c64.`, 15-track
editor, GM channel map). Record disagreements; do not silently
promote them into rules.
