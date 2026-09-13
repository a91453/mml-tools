# mabinogi-mobile-mml Bootstrap

[SKILL.md](SKILL.md) is a thin workflow consumer. Every Mabinogi Mobile MML task
starts at [docs/CANONICAL_MANIFEST.md](../../docs/CANONICAL_MANIFEST.md), then loads
the Published Canonical from the Manifest's pinned snapshot. This directory is
not a rule authority and contains no independent Canonical rule copy.

The shared loader is `studio/backend/bootstrap/index.mjs`; invoke it with
`node scripts/bootstrap-canonical.mjs` in a refreshed repository checkout.
Loading failure is `CANONICAL_NOT_LOADED`, with no legacy fallback.

The former 2026-09-10 Lead Role extensions are preserved verbatim in
[the historical archive](../../docs/history/lead-role-2026-09-10/README.md).
They are not current instructions or an alternate load path.

This repository change does not install or overwrite an external ChatGPT Skill.
