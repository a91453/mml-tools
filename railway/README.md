# Agent Control Plane — MML OAuth, MCP and Application API service

Railway project `mml-tools-allen`, service `mml-tools`. This deployment serves OAuth, the MCP endpoint at `/mcp`, and the Application HTTP API at `/api/v1/*`. It does not trust Sites identity headers. The original Sites workbench remains a separate browser application with its own Sites access policy.

## This is not the Studio Web deployment

There are two Railway planes, and this README describes only the second:

| | Permanent Studio Web plane | Agent Control Plane (this one) |
| --- | --- | --- |
| Railway project | `mml-tools-studio-permanent` | `mml-tools-allen` |
| Service | `studio-web-permanent` | `mml-tools` |
| Serves | the Studio PWA | OAuth, `/mcp`, `/api/v1/*` |
| Release model | pinned artifact + trust bundle, SHA256-verified, atomically published to a durable cache | container image built from this repository |
| Volume | `/studio-cache` — verified runtime-release bytes | `/data` — project, asset, artifact and job records |

`/studio-cache` and `/data` are never interchangeable. `/studio-cache` holds release bytes for the Web plane and never user song data; `/data` holds this service's working storage and is never the Web plane's release cache. The private `studio-release-artifacts` bucket belongs to the release mechanism and is **not** this service's upload store.

The Permanent Studio Web deployment, its pinned artifact, its trust bundle and its verification mechanism are documented in [ops/permanent/](../ops/permanent/MIGRATION_RESULT.md) and are not changed, replaced or bypassed by anything here. Studio Web does not call the Application Service; it reaches the same `studio/backend/**` engines directly in the browser. Migrating it is possible later and is follow-up work.

## Required deployment settings

- Build context: repository root; Dockerfile: `railway/Dockerfile`.
- One service and **one replica**, with a persistent volume mounted at `/data`.
- `MML_PUBLIC_ORIGIN`: exact generated HTTPS origin, without a path.
- `MML_OWNER_PASSWORD`: a randomly generated 32–256 character service password; set only in Railway Variables, never in Git, a URL, a report, or the source ZIP.
- `MML_AUTH_DB`: `/data/mml-auth.sqlite`.
- `MML_STUDIO_DATA_DIR`: `/data/studio` for the Studio Agent Interface's project, asset and artifact records. Unset, those records stay in memory and the capability endpoint reports `asset_storage.durability: "ephemeral"`.
- `MML_STUDIO_DURABILITY`: `persistent` only when `/data` really is a mounted volume. Nothing in the service detects a real mount, so durability is reported from this declaration rather than assumed.
- `PORT`: Railway's supplied port, or 3000.
- Healthcheck: `/healthz`.

Both Studio variables are optional: the service starts, serves `/healthz` and answers `GET /api/v1/capabilities` without them.

Configure these values through Railway service settings. `service-settings.json` is a non-executable reference snapshot, not a Railway Config as Code file. New services cannot opt into the deprecated `railway.toml` / `railway.json` mechanism; do not set a config-file override or point Nixpacks at such a file. See [Railway's migration notice](https://docs.railway.com/config-as-code). The source-controlled Dockerfile remains portable to other Docker-capable hosts.

The official Node image runs as root so it can write the root-mounted Railway volume. The application sets a restrictive file creation mask. No request can select a file path, run a shell command, install packages, or access other services. A non-root deployment needs the volume's ownership configured separately.

The image installs exactly one npm package — `fast-xml-parser`, already pinned to an exact version in `package.json` and already required by the MusicXML adapter the Studio backend uses — with `--omit=dev --ignore-scripts`, so no package install script runs. It installs nothing else and contacts no paid service. Build from the root of the same source commit that passed the tests.

The image also carries the repository's Git metadata and the `git` binary. This is not incidental: the Published Canonical bootstrap reads `docs/CANONICAL_MANIFEST.md` from `refs/remotes/origin/main` and every rule document from the pinned rules snapshot commit `0a172900a01fdf39c2e9e84cf176961320b779ea`, so without Git history no Canonical-aware operation can run.

Three things must all be true of the **build context**, not just of the Dockerfile:

1. `.git` is present;
2. `refs/remotes/origin/main` exists — a checkout with no remote-tracking ref for the published branch fails even with full history;
3. the pinned rules snapshot commit is a reachable object. A shallow clone is the trap here: `--depth 1` *does* create `refs/remotes/origin/main` and still fails, because the snapshot commit was truncated away. Shallowness alone is not the test — a shallow clone deep enough to retain the snapshot loads fine.

A context missing any of these still produces a working image. The service starts, `/healthz` answers, and the three legacy technical tools keep working; only the Canonical-aware Studio operations refuse, reporting `CANONICAL_NOT_LOADED` with no fallback.

## Verifying a deployment

Two checks, in order. **Neither needs the service password.**

**1. The build log.** Every build runs `railway/canonical-probe.sh`, which prints one line per precondition and then the real capability answer:

```
[canonical-bootstrap] git-metadata: present
[canonical-bootstrap] clone depth: complete
[canonical-bootstrap] refs/remotes/origin/main: present
[canonical-bootstrap] rules snapshot 0a172900…: present
[canonical-bootstrap] status=CANONICAL_LOADED
[canonical-bootstrap] canonical_version=2026-09-13-v1
[canonical-bootstrap] rules_snapshot_sha=0a172900…
[canonical-bootstrap] manifest_commit=…
[canonical-bootstrap] published_main_head=…
[canonical-bootstrap] repository_head=…
```

The probe is non-fatal and always exits 0. Failing the build would take a deployment that still serves its existing tools down over a degraded capability; silence is the only outcome it rules out.

**2. The public root endpoint.**

```
curl -s https://<public-origin>/ | jq .canonical
```

Expect `"status": "CANONICAL_LOADED"` and five distinct identities: `canonical_version`, `rules_snapshot_sha`, `manifest_commit`, `published_main_head`, `repository_head`. When it is not loaded, `canonical_notice` states the remedy.

`/healthz` is deliberately **not** coupled to the Canonical load: a Canonical problem must never fail Railway's healthcheck and roll back a deployment that is otherwise serving correctly.

## Post-merge operator actions (Agent Control Plane only)

Nothing in this repository changes a running Railway service. After the Studio Agent Interface work merges, apply these by hand in the **`mml-tools-allen` / `mml-tools`** service settings. Do not apply them to `studio-web-permanent`; that plane is configured separately and is not affected.

1. **Update the build watch patterns** to the set in [`service-settings.json`](service-settings.json). Two additions matter:
   - `/railway/canonical-probe.sh` — shipped in the image and previously unwatched.
   - `/docs/CANONICAL_MANIFEST.md` — see below. Without it, a Canonical release does not reach this service.

   The Canonical rule sources are deliberately **not** watched: they are read from the immutable rules snapshot the Manifest pins, never from `main`, so editing one cannot change what this service loads.

2. **Optionally set the Studio storage variables.** Both are optional and the service starts without them:
   - `MML_STUDIO_DATA_DIR=/data/studio` (already the image default)
   - `MML_STUDIO_DURABILITY=persistent` — set this **only** if `/data` really is the mounted volume. Nothing detects a real mount; durability is reported from this declaration, so an inaccurate value makes the capability endpoint lie.

3. **Verify the deploy** using the two credential-free checks above.

4. **Re-verify after any Canonical release.** Because the Canonical view is pinned at image build, compare the `canonical.published_main_head` reported by this service's public root endpoint against the current `main`. If they differ, the service is serving an older Manifest view and needs a rebuild.

No variable rotation, volume change, bucket change, service creation or migration is required or implied by this work.

### If it reports `CANONICAL_NOT_LOADED`

The probe line names which precondition failed, and all three remedies are deployment-side rather than code: the image needs a source checkout carrying this repository's history and its published ref.

Do **not** work around it by creating `refs/remotes/origin/main` from `HEAD` at build time. That would let a build of any branch declare itself published Canonical, which is precisely the substitution the bootstrap contract forbids. If Railway cannot supply the history, see §20 of [docs/STUDIO_AGENT_INTERFACE.md](../docs/STUDIO_AGENT_INTERFACE.md) for the vendored-package follow-up, which is a project-owner decision rather than a silent change. A GitHub source must be explicitly selected for Railway's GitHub deployment tool; alternatively `railway up` requires its own authenticated CLI session.

## ChatGPT connection

Only after a successful deploy and HTTPS verification:

- Server URL: the confirmed public origin followed by `/mcp`.
- Authentication: OAuth.
- Client registration: Dynamic Client Registration (DCR), public client (`none`), PKCE S256. Do not choose CIMD for this version.
- The service login form requests the generated MML service password from Railway Variables. It never requests a ChatGPT, GitHub, or Railway account password.
- OAuth resource: the same complete `/mcp` URL.

Initial metadata and the password form are public; tool requests require an OAuth token. Registered callbacks are restricted to exact HTTPS URLs on `chatgpt.com` or `chat.openai.com`, with no custom ports or fragments. An additional client requires explicit configuration and tests for its callback host.

### Login form origin compatibility

Only the login HTML sends `Referrer-Policy: same-origin`. A normal browser form submission uses navigation mode; `no-referrer` on that document turns the POST's `Origin` into `null`, which the server correctly rejects as `Invalid form origin`. See the [Fetch Standard](https://fetch.spec.whatwg.org/#append-a-request-origin-header). Same-origin policy preserves the form's origin without sending referrers to other origins. Metadata, token responses, errors and authorization redirects retain `no-referrer`.

Do not fix this by allowing `null`, missing or arbitrary Origins, by trusting proxy/Referer hints, or by removing the CSRF cookie and token checks. Node fetch tests that inject an Origin header do not emulate browser document-policy behavior; regression tests separately check the HTML policy and all Origin rejection cases.

After an update, start a fresh connection flow from ChatGPT, not by resubmitting an old error page. Pending login forms expire after five minutes and are invalidated by a process restart. If no volume was mounted, a redeploy also loses registered OAuth clients: an `Unknown client` error requires a fresh DCR registration, normally by recreating the custom connection. Mount `/data` before relying on persistent authorizations.

### Returning to ChatGPT after consent

The login page's CSP `form-action` permits only `'self'` plus the selected, exactly registered callback's validated HTTPS origin. Some browsers enforce this policy on redirects after form submission, so a self-only policy can block the return to ChatGPT even after the password and CSRF checks pass. The raw callback URL and its query are never inserted into CSP; arbitrary origins and wildcard destinations remain forbidden. See [MDN's redirect compatibility note](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/form-action).

Successful consent responds with HTTP **303**, explicitly converting the credential POST to a GET before returning to the client, as recommended by [RFC 9700 section 4.12](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.12). The response contains no password or CSRF token. The login ticket remains one-use: resubmitting a completed form is rejected. Expired or mismatched browser requests show a short recovery page; API callers still receive the original JSON error. Do not extend or replay completed tickets to hide a failed browser redirect.

Tests check both approved callback hosts, the selected-origin-only CSP allowlist, query isolation, 303 responses, repeated consent rejection, recovery HTML, and unchanged API errors. These checks supplement the synthetic OAuth/MCP flow; they do not replace the owner's actual browser return and token exchange.

## Authorization lifecycle

The service implements a limited, single-owner authorization-code flow, not a general identity provider. It uses server-side opaque tokens and Node cryptography. Access tokens expire after 15 minutes; authorizations and rotating refresh tokens expire after 30 days. Reusing a redeemed code or refresh token revokes its authorization family. Password rotation revokes existing grants while preserving client registrations. SQL parameters are bound, tokens/codes are stored only as hashes, and the mounted SQLite database preserves registrations and grants across service restarts.

The volume contains OAuth authorization records only. It does not contain MML, uploaded music or conversation history. Keep it private and back it up only within the same access policy. Never include it in downloadable source.

## Verification scope

Run `node --test tests/core.test.mjs tests/player.test.mjs tests/mcp.test.mjs tests/railway.test.mjs` before deployment. OAuth tests cover metadata discovery, DCR, exact callback validation, PKCE, CSRF, replay revocation, scope/resource binding, password rotation, persistence, and a real loopback HTTP flow through the MCP transport. Test credentials and callback URLs are synthetic.

Passing local tests is not a completed Railway deployment or ChatGPT account connection. Record live health, unauthenticated 401 challenge, metadata, authorized initialize/tools/list/tools/call, and the user's actual ChatGPT connection separately. No technical test proves original-audio listening or Mobile game acceptance.
