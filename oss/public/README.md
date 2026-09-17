# Mabinogi Mobile MML Tools

Open-source tooling for building, analyzing, validating, and reviewing six-role MML arrangements for **Mabinogi Mobile**.

This repository focuses on reproducible source handling rather than one-click conversion. Its core design keeps symbolic source evidence, audio evidence, arrangement decisions, Mobile adaptation, technical validation, and in-game acceptance as separate stages.

## What is included

- MML parsing and Canonical IR with exact-rational timing.
- MIDI and MusicXML source intake with event-level provenance.
- Lossless source-voice decomposition and six-role arrangement analysis.
- Lead/Core3 and cross-source harmony review helpers.
- Source-aware micro-timing checks.
- Canonical Final MML emission with semantic emit → parse round-trip verification.
- Offline-first Studio Web/PWA tooling.
- Synthetic regression fixtures and browser tests.

No commercial song audio, score PDFs, third-party MIDI files, user song packages, deployment credentials, or private operational records are included in this public export.

## Canonical rules provenance

The public package vendors one immutable Canonical rules snapshot so it can build and test without access to the private development repository or its Git history.

- Canonical version: `{{CANONICAL_VERSION}}`
- Rules snapshot SHA in the upstream development repository: `{{RULES_SNAPSHOT_SHA}}`
- Export source commit: `{{SOURCE_HEAD}}`

The vendored snapshot is provenance data for this release. Executable contracts and tests implement or verify the documented rules; they do not redefine them. See `PUBLIC_EXPORT.json` and `docs/UPSTREAM_CANONICAL_PROVENANCE.json`.

## Requirements

- Node.js 22+
- npm
- Python 3.12 + FFmpeg only for the optional audio-alignment worker tests

## Install

```sh
npm install --ignore-scripts --package-lock=false
```

## Test

```sh
npm test
```

## Build the Studio PWA

```sh
npm run build
```

The static build is written to `studio/web-build/`.

## Browser regression suite

Install the Playwright browsers once:

```sh
npx playwright install --with-deps chromium webkit
npm run test:browser
```

## Project scope

This repository is developer tooling. Parser, CI, browser, or round-trip success does **not** establish that a song is musically correct or accepted by the Mabinogi Mobile client. Song-specific source review and target-client acceptance remain separate.

## Contributing

See `CONTRIBUTING.md`. Synthetic or freely redistributable fixtures are preferred. Do not submit copyrighted commercial recordings, score scans, or third-party song files unless redistribution rights are clear.

## License

Code and project-authored documentation in this public repository are licensed under the MIT License. See `LICENSE` and `NOTICE.md`.

Mabinogi and related names are the property of their respective owners. This project is not affiliated with or endorsed by Nexon.
