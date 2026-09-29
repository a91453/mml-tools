# Native core host

Status: implementation notes, not a Canonical rule source. Rules load only
through [docs/CANONICAL_MANIFEST.md](../../docs/CANONICAL_MANIFEST.md).
Decision record: [ADR-001](../../docs/architecture/ADR-001-core-portability.md).

This directory lets a native App run the shared Studio engines offline in a bare
JavaScript engine (JavaScriptCore on iOS). It adds no MML logic: it is a
transport adapter like `server/mcp.mjs`.

| File | Role |
| --- | --- |
| `entry.mjs` | Bundle entry. Installs `globalThis.MMLNativeCore`. |
| `core-facade.mjs` | Composes the MCP technical service and the Canonical gate. The gate's loader verifies the bundled runtime package with Studio Web's verifier before first use and refuses with `CANONICAL_NOT_LOADED` otherwise. JSON text in, JSON text out. |
| `host-globals.mjs` | WHATWG UTF-8 `TextEncoder` / `TextDecoder` and a data-value `structuredClone`, installed only where the host lacks them. |
| `conformance-cases.mjs` | Requests only. The build answers them on the Node server path; hosts must reproduce those answers. |

Build with `npm run build:native-core` (needs the published `main` history).
Output goes to `studio/native-build/` (gitignored):

- `mml-core.js`: one reproducible classic script (esbuild, target `safari17`).
  The Git-backed loader is replaced by the Canonical runtime package from
  `scripts/canonical-runtime-package.mjs`, the same package Studio Web ships.
- `mml-core.json`: bundle SHA-256 and size, Canonical release, runtime package
  digest, every compiled module with its SHA-256, and Git provenance as audit only.
- `conformance.json`: the Node server path's answer to every conformance case.

## Host protocol

```js
const ticket = MMLNativeCore.submit('validate', JSON.stringify({ mml, meter_text }));
// JavaScriptCore drains microtasks when the outer API call returns.
const envelope = JSON.parse(MMLNativeCore.collect(ticket));
// { ok: true, result } | { ok: false, error: { code, message, details } }
```

Operations: `identity`, `validate` (MCP `mml_validate`), `overlapDetails`
(MCP `mml_overlap_details`), `canonicalDocument` (`{ path }`). Host faults use
the codes `INTERNAL_ERROR`, `NOT_SETTLED` and `UNKNOWN_TICKET`; every other
code is the Application Service's own refusal.

Tests: `tests/native-core.test.mjs` (bare context, MCP parity, tamper refusal,
reproducibility, shim fidelity) and the Swift package in `apps/ios/MMLKit`
(the same cases on a real JavaScriptCore).
