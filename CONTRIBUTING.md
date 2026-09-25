# Contributing

Contributions are welcome when they keep the project reproducible, source-aware, and legally redistributable.

## Development

1. Use Node.js 22 or newer.
2. Run `npm install --ignore-scripts --package-lock=false`.
3. Run `npm test` before submitting changes.
4. For Studio Web/PWA changes, also run `npm run build:studio-web` and the browser suite (`npm run test:studio-web`) when available.

## Fixtures and source material

Prefer synthetic fixtures or material with clear redistribution permission. Do not commit commercial recordings, score scans, extracted game assets, third-party song MIDI files, or user song packages without documented rights.

Tests and executable contracts verify implementation behavior. They do not become rule authority merely because they pass. Changes that affect musical policy should keep the documented Canonical rules and implementation behavior clearly separated.

## Pull requests

Keep changes focused, explain the invariant being changed or protected, and add a regression for bug fixes where practical. Avoid silently normalizing source timing, provenance, attacks, or role assignments merely to make a candidate pass validation.
