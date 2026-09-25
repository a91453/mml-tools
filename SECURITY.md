# Security Policy

Please report security issues privately rather than opening a public issue when the report could expose credentials, authentication weaknesses, or deployment-sensitive information.

This repository, Git history included, is public, so it must never contain production secrets. Credentials belong in deployment environment variables or secret stores. `scripts/scan-secrets.mjs` checks every tracked file on each pull request and push; keep GitHub secret scanning and push protection enabled in the repository settings as a second line.

When reporting a vulnerability, include the affected commit, a minimal reproduction, expected versus observed behavior, and whether exploitation requires a configured external service.
