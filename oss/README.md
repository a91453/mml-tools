# Public OSS export

This directory contains templates for a clean public distribution of MML Tools. The private development repository remains the full working source; the public repository is generated from an explicit allowlist.

## Why export instead of changing repository visibility

The development repository contains private operational material, deployment history, and song-specific working context that should not become public merely because the tooling is open-sourced. The export process therefore starts from an empty directory, copies only approved source paths, vendors the currently published Canonical package, and then runs a leak audit.

## Generate

```sh
node scripts/export-oss.mjs .oss-export
node scripts/audit-oss-export.mjs .oss-export
```

The generated tree is suitable for a fresh public repository with no private Git history.

## Public-only files

`oss/public/` is overlaid at the root of the generated repository. It contains the MIT license, public README, contribution/security notices, package metadata, ignore rules, and public CI workflow.

## Deliberately excluded

The export rejects deployment/operations directories, private or song-specific directories, commercial audio and score formats, MIDI/MusicXML source files, archives/databases, known credential patterns, and the private repository's Git history.

A successful leak audit is necessary but not a legal guarantee. Before a public release, review the generated file inventory and CI results as a final human checkpoint.
