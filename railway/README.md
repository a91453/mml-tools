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

The image carries a Git object store and the `git` binary. This is not incidental: the Published Canonical bootstrap reads `docs/CANONICAL_MANIFEST.md` from `refs/remotes/origin/main` and every rule document from the pinned rules snapshot commit `0a172900a01fdf39c2e9e84cf176961320b779ea`, so without Git history no Canonical-aware operation can run.

### How the image gets that history

It used to depend entirely on the build context carrying `.git`, and Railway's GitHub source snapshot does not. The result was a deployment that was operationally green — `/healthz` PASS, container start PASS, Railway status SUCCESS — while its own build log read `git-metadata: MISSING` and `status=CANONICAL_NOT_LOADED`, and every Canonical-aware operation refused. The probe that noticed exited 0, so nothing stopped it.

The build now establishes the history itself, in two steps that run in this order:

1. **`node scripts/materialize-canonical.mjs`** captures the published `main` SHA from `https://github.com/a91453/mml-tools` with `git ls-remote`, fetches that history, points `refs/remotes/origin/main` at the **captured** commit, reads the Manifest from that same immutable commit, and requires the exact `rules_snapshot_sha` it pins to be present as a real object. It then runs the real loader and fails the build if the answer is not `CANONICAL_LOADED`.

   **This repository is private, so the step needs a read credential** — see [Build variable: read access to the published source](#build-variable-read-access-to-the-published-source) below. Without one it fails the build, which is the correct outcome.

   The capture happens before anything is read, so a `main` that advances mid-build changes nothing, and one rewritten past the captured commit fails closed rather than being followed. There is no fallback: an unreachable published source fails the build. It never reads a working-tree file as Canonical content, and it never manufactures the published ref out of the build context — see [the module header](../studio/backend/bootstrap/materialize.mjs) for why that substitution is the one thing it must not do.

2. **`sh railway/canonical-probe.sh`** proves the result on the same capability path the runtime serves, and **fails the build** if it cannot.

A build context that *does* carry `.git` keeps its own checkout identity, and no local branch is rewritten. What the step does write, in whatever repository it is pointed at, is `refs/remotes/origin/main` — set to the captured commit, which is the same ref `git fetch origin` moves — plus HEAD and the checkout attestation when there was no HEAD to keep. The published discovery ref is established the same way either way, so what the image loads never depends on whether `.git` was there.

Two properties are worth stating plainly. The runtime loader is unchanged and still offline — it reads local Git objects only and imports nothing from the build-time module, which is why the Canonical view stays pinned at image build. And a running container that somehow had no loadable Canonical would still start, answer `/healthz` and serve the three legacy technical tools, refusing only Canonical-aware operations with `CANONICAL_NOT_LOADED` and no fallback. That remains the correct runtime behaviour; what changed is that such an image no longer gets built.

### Build variable: read access to the published source

`a91453/mml-tools` is a **private** repository. A builder with no credential cannot resolve `refs/heads/main` on it at all, so the materialization step above cannot run and the build fails closed. This is the one setting the new mechanism requires.

Set **`MML_CANONICAL_SOURCE_TOKEN`** as a Railway **build** variable on `mml-tools-allen` / `mml-tools`:

- a GitHub fine-grained personal access token (or a GitHub App installation token) whose only permission is **Contents: Read** on **`a91453/mml-tools`** and nothing else;
- **build-time only.** The running service never reads it. It is not in `requiredVariables`, and nothing outside the materialization step touches it.

How the token is handled, so a review can check it rather than take it on trust:

- it is **never put in the published source URL**, so it cannot reach the bootstrap record, the build summary, a Git error message or the build log;
- it is **never written to a file** — no credential store, no askpass script, nothing in an image layer;
- it is **never in an argument vector.** Git receives `-c credential.helper=<shell snippet naming the variable>`; the shell expands `$MML_CANONICAL_SOURCE_TOKEN` from the inherited environment, so a process listing shows the variable name, not its value;
- it is carried only by the two calls that actually contact the published source (`ls-remote` and `fetch`), which is asserted in `studio/tests/bootstrap-materialize.test.mjs`;
- it is **cleared before the build gate runs**, since a Dockerfile `ARG` is otherwise exported into every later `RUN` and nothing in the gate needs it.

One caveat, and it is the real limit of the above: those properties hold below the `ARG`, not at it. **A Docker build argument can be recovered from an image's build history and appears in the builder's process list.** Railway passes build variables this way and offers no BuildKit secret mount, so this is the available channel rather than the ideal one. Treat the token as scoped and rotatable rather than as a long-lived secret — read-only on one repository is the point of the scope above — and rotate it if the image is ever shared outside the deployment. If the repository is ever made public, drop the variable entirely: the build works without it and nothing else changes.

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
[canonical-bootstrap] canonical_status=PUBLISHED
[canonical-bootstrap] manifest_version=2026-09-13-v1-manifest1
[canonical-bootstrap] rules_snapshot_sha=0a172900…
[canonical-bootstrap] manifest_commit=…
[canonical-bootstrap] published_main_head=…
[canonical-bootstrap] repository_head=…
[canonical-bootstrap] checkout_identity=materialized-published-main
[canonical-bootstrap] build_source_head=…
[canonical-bootstrap] published_source=https://github.com/a91453/mml-tools.git
[canonical-bootstrap] gate: PASS
```

The probe is a **gate**: anything other than `gate: PASS` fails the build. It used to exit 0 unconditionally, on the reasoning that a degraded context must still produce an image serving its existing tools. Production showed the cost: nothing downstream — not `/healthz`, not the Railway deployment status, not the restart policy — can tell a healthy service from one whose every Canonical-aware operation refuses, so the warning went unnoticed and the image deployed.

`checkout_identity` says how `repository_head` was established. `materialized-published-main` means the source tree arrived without Git metadata and HEAD was set to the captured published main head, which is why those two identities are equal here; `git-checkout` means the context carried a real checkout.

The claim itself is a ref in the image's object store (`refs/canonical-bootstrap/checkout-identity`), not the `.canonical-bootstrap.json` file beside it. A plain file would make its own deletion an upgrade — without it the answer falls back to `git-checkout`, exactly the independently-verified-looking claim it exists to prevent. The loader requires the ref and the record to agree and to name the published main it just resolved; either half alone fails closed.

`build_source_head` (Railway's record of the commit that produced the source tree, or `null`) and `published_source` (where the build obtained the published history) are **recorded by the build and not verified at load time**. The endpoint's `checkout_notice` says which fields are which, so a reader is not left inferring it.

**2. The public root endpoint.**

```
curl -s https://<public-origin>/ | jq .canonical
```

Expect `"status": "CANONICAL_LOADED"` and the distinct identities: `canonical_version`, `canonical_status`, `manifest_version`, `rules_snapshot_sha`, `manifest_commit`, `published_main_head` and `repository_head`, none standing in for another; `checkout_identity`, saying how the last of those was established; and `build_source_head` / `published_source`, which the build recorded and this load did not verify. `checkout_notice` states that split in the response itself. When it is not loaded, `canonical_notice` states the remedy.

`/healthz` is deliberately **not** coupled to the Canonical load: a Canonical problem must never fail Railway's healthcheck and roll back a deployment that is otherwise serving correctly.

## Post-merge operator actions (Agent Control Plane only)

Nothing in this repository changes a running Railway service. After the Studio Agent Interface work merges, apply these by hand in the **`mml-tools-allen` / `mml-tools`** service settings. Do not apply them to `studio-web-permanent`; that plane is configured separately and is not affected.

1. **Set the `MML_CANONICAL_SOURCE_TOKEN` build variable.** Required: this repository is private, and without it the build fails at the Canonical gate. See [Build variable: read access to the published source](#build-variable-read-access-to-the-published-source) for the exact scope and how the value is handled. This is the only new variable, it is build-time only, and it adds no recurring cost.

2. **Update the build watch patterns** to the set in [`service-settings.json`](service-settings.json). Three additions matter:
   - `/railway/canonical-probe.sh` — shipped in the image and previously unwatched.
   - `/scripts/materialize-canonical.mjs` — the build-time step that establishes the published history; shipped in the image, so a change to it must rebuild.
   - `/docs/CANONICAL_MANIFEST.md` — see below. Without it, a Canonical release does not reach this service.

   The Canonical rule sources are deliberately **not** watched: they are read from the immutable rules snapshot the Manifest pins, never from `main`, so editing one cannot change what this service loads.

3. **Optionally set the Studio storage variables.** Both are optional and the service starts without them:
   - `MML_STUDIO_DATA_DIR=/data/studio` (already the image default)
   - `MML_STUDIO_DURABILITY=persistent` — set this **only** if `/data` really is the mounted volume. Nothing detects a real mount; durability is reported from this declaration, so an inaccurate value makes the capability endpoint lie.

4. **Verify the deploy** using the two credential-free checks above.

5. **Re-verify after any Canonical release.** Because the Canonical view is pinned at image build, compare the `canonical.published_main_head` reported by this service's public root endpoint against the current `main`. If they differ, the service is serving an older Manifest view and needs a rebuild.

No variable rotation, volume change, bucket change, service creation or migration is required or implied by this work.

### If the build fails at the Canonical gate

A failing build is the gate working. The probe lines name what was missing, and the materialization step's own JSON names the step that could not be proven. The usual causes, in order of likelihood:

1. **`MML_CANONICAL_SOURCE_TOKEN` is unset, expired, or scoped to the wrong repository.** This repository is private; without read access there is nothing to capture. The step's JSON names the variable in its `hint` and carries Git's own error in `gitError`, so an expired token (401) reads differently from a DNS, TLS or proxy failure. The token is redacted from that output.
2. the builder cannot reach `https://github.com/a91453/mml-tools`;
3. published `main` pins a snapshot the fetch did not reach.

Do **not** work around it by creating `refs/remotes/origin/main` from `HEAD`, from the build source commit, or from a working-tree Manifest. That would let a build of any branch declare itself published Canonical, which is precisely the substitution the bootstrap contract forbids, and it is why the materialization captures the published SHA from the published repository and reads everything from that commit. Copying the working tree's Canonical documents into the image, or hard-coding the Manifest, is the same substitution wearing a different hat.

If it reports `CANONICAL_NOT_LOADED` at **runtime** instead — the service is up, `/healthz` answers, and the root endpoint says the rules are unavailable — the image was built before this gate existed, or `/app/.git` was lost after the build. Rebuild it.

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
