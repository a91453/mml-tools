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
- `MML_OAUTH_REDIRECT_HOSTS` (optional): comma-separated bare hostnames whose exact HTTPS callbacks may register. Unset, the default is `chatgpt.com,chat.openai.com,claude.ai,claude.com`. A value that is not a bare hostname list refuses to start.
- `MML_OAUTH_LOOPBACK_REDIRECTS` (optional): `false` to refuse RFC 8252 loopback callbacks from native clients. Unset or `true`, they are accepted.
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

`a91453/mml-tools` is a **private** repository. A builder with no credential cannot resolve `refs/heads/main` on it at all, so the materialization step cannot run and the build fails closed. This is the one setting the new mechanism requires.

Set **`MML_CANONICAL_SOURCE_TOKEN`** on `mml-tools-allen` / `mml-tools`:

- a GitHub fine-grained personal access token (or a GitHub App installation token) whose only permission is **Contents: Read** on **`a91453/mml-tools`** and nothing else, with the shortest expiry you are willing to rotate on;
- **seal it.** Railway's [Sealed variables](https://docs.railway.com/variables#sealed-variables) are provided to builds and deployments like any other variable but can never be read back from the dashboard or the API. That closes the read-back vector; per Railway's own wording, sealing "changes visibility, not availability", so it does *not* change anything below.

#### There is no build-only variable scope on Railway

Earlier revisions of this document called the token "build-time only". That was wrong, and it matters. (The code once carried the same mistake in its names — `BUILD_ONLY_VARIABLES`, `scrubBuildOnlyVariables()` — which made the runtime removal look like belt-and-braces rather than the necessary step it is. They are now `BUILD_CREDENTIAL_VARIABLES` and `scrubBuildCredentialVariables()`: credentials the *build consumes*, not variables the platform scopes to it.) Railway's documentation states that a variable is made available "for the build process for each service deployment" **and** "the running service deployment". A Dockerfile build only sees it if an `ARG` opts in, but the *running container* receives every service variable regardless.

So the credential arrives in the running service's environment even though nothing there needs it — the Canonical view is pinned at image build and the runtime loader reads local Git objects only. The service therefore removes it, in two independent places, because either alone is a single point of failure:

- `railway/server.mjs` calls `scrubBuildCredentialVariables()` at module scope, before it serves anything, which also keeps the value out of every child process spawned from `process.env`;
- the runtime Git adapter in `studio/backend/bootstrap/index.mjs` strips it from every `git` child it spawns, even if some other entry point skipped the first step.

Measured in the built container: `process.env` carries it before `railway/server.mjs` is imported and not after, and a child process spawned afterwards does not see it. One honest limit — `/proc/<pid>/environ` is a snapshot taken at `exec` and still contains it, as it does for every variable the platform injects. Nothing in the process can change that.

#### How the token is handled during the build, and what that does not cover

Verified by building this Dockerfile's exact structure on BuildKit 29.3.1 with a canary token, then scanning the build log, `docker history`, every blob of the exported image, and the running container's filesystem:

| Vector | Result |
| --- | --- |
| Build log (`--progress=plain`, `--no-cache`) | **0 occurrences** of the value. Only the variable *name* appears, in Docker's own lint warning. |
| `docker history` of the shipping image | **0 occurrences** (single-stage: 4). |
| Every blob, manifest and layer of the exported image | **0 occurrences** (single-stage: 1). |
| Files in the shipping container's `/app` (388 scanned) | **0 occurrences**. |
| Running service's `process.env` after startup | **absent**; absent in child processes too. |

Two design choices earn those zeros, and both are one line away from being undone:

- **The credential `ARG` is declared only in the `canonical` builder stage.** The stage that ships never names it, so it is in neither that stage's environment nor the final image's history. Adding `ARG MML_CANONICAL_SOURCE_TOKEN` to the second stage would put the value straight back into `docker history` for anyone who can pull the image.
- **The `RUN` assigns nothing inline.** BuildKit prints the *expanded* `RUN` command as the step title, so `RUN MML_CANONICAL_SOURCE_TOKEN="$MML_CANONICAL_SOURCE_TOKEN" node …` publishes the value to the build log on every build — measured, before this was changed. An `ARG` is already exported into the command's environment, so the step names neither variable and reads both itself.

`tests/railway-canonical-image.test.mjs` pins both.

#### Residual risk — this needs owner acceptance

**Railway provides no BuildKit secret mount.** Its documentation supports `--mount=type=cache` and documents `ARG` as the only way to get a variable into a Dockerfile build; there is no documented `--secret` mechanism, so `RUN --mount=type=secret` cannot be supplied a value. `ARG` is therefore the available channel, not an equivalent one, and Docker's own linter says so on every build of this file:

```
WARN: SecretsUsedInArgOrEnv: Do not use ARG or ENV instructions for sensitive data (ARG "MML_CANONICAL_SOURCE_TOKEN")
```

What the two-stage design does **not** eliminate:

1. **BuildKit provenance attestations.** A build run with `--provenance=mode=max` records build arguments in its SLSA predicate; the canary was recovered from that attestation in testing. `mode=min` and provenance-disabled builds did not contain it. **Whether Railway's builder emits provenance attestations, at which mode, and whether they are retrievable, could not be determined** — Railway documents neither. This is unresolved, not ruled out.
2. **The builder host.** The value exists in the build environment and in the builder's process state while the build runs. Nothing in this repository can affect that.
3. **Railway's own storage.** The value is held by Railway. Sealing prevents read-back through the dashboard and API; it does not remove the value from the platform.

Given those, treat this token as **scoped and rotatable, never long-lived**: Contents: Read on one repository, short expiry, rotated on a schedule and immediately if the image is ever shared outside the deployment. The blast radius of the worst case is read access to this repository's contents.

**The alternative that removes the requirement entirely is to make the repository public.** The Published Canonical Manifest already publishes `github.com/a91453/mml-tools/blob/<snapshot>/…` URLs as its authority map, so its contents are already written as though readers can open them. If that happens, delete the variable: the build works without it and nothing else changes.

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

If it reports `CANONICAL_NOT_LOADED`, `canonical_notice` names the current remedy: the image did not complete the Canonical materialization and build gate, so read the `[canonical-bootstrap]` lines in that deployment's build log, confirm the build can reach the published source with its configured read access, and rebuild. The notice is public and unauthenticated, so it never names a credential, a value or a container path.

Expect `"status": "CANONICAL_LOADED"` and the distinct identities: `canonical_version`, `canonical_status`, `manifest_version`, `rules_snapshot_sha`, `manifest_commit`, `published_main_head` and `repository_head`, none standing in for another; `checkout_identity`, saying how the last of those was established; and `build_source_head` / `published_source`, which the build recorded and this load did not verify. `checkout_notice` states that split in the response itself. When it is not loaded, `canonical_notice` states the remedy.

`/healthz` is deliberately **not** coupled to the Canonical load: a Canonical problem must never fail Railway's healthcheck and roll back a deployment that is otherwise serving correctly.

## Post-merge operator actions (Agent Control Plane only)

Nothing in this repository changes a running Railway service. After the Studio Agent Interface work merges, apply these by hand in the **`mml-tools-allen` / `mml-tools`** service settings. Do not apply them to `studio-web-permanent`; that plane is configured separately and is not affected.

1. **Set the `MML_CANONICAL_SOURCE_TOKEN` variable, sealed.** Required: this repository is private, and without it the build fails at the Canonical gate. Scope it to Contents: Read on this repository and nothing else. Read [Build variable: read access to the published source](#build-variable-read-access-to-the-published-source) in full before setting it — it records what is measured, what is not covered, and the residual risk that needs your acceptance. Railway has no build-only scope, so the running service receives it too and removes it at startup. It adds no recurring cost.

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

1. **`MML_CANONICAL_SOURCE_TOKEN` is unset, expired, or scoped to the wrong repository.** (Also check it exists in the environment being deployed: sealed variables are not copied into PR environments or duplicated environments, so a build there fails closed rather than leaking.) This repository is private; without read access there is nothing to capture. The step's JSON names the variable in its `hint` and carries Git's own error in `gitError`, so an expired token (401) reads differently from a DNS, TLS or proxy failure. The token is redacted from that output.
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

Initial metadata and the password form are public; tool requests require an OAuth token. Registered callbacks are restricted to exact HTTPS URLs, with no custom ports, userinfo or fragments, on the approved connector hosts — by default `chatgpt.com`, `chat.openai.com`, `claude.ai` and `claude.com` — plus RFC 8252 loopback redirects (`http://127.0.0.1`, `http://[::1]`, `http://localhost`, any port) for native clients such as a local agent. `MML_OAUTH_REDIRECT_HOSTS` (comma-separated bare hostnames) replaces the default host list, and `MML_OAUTH_LOOPBACK_REDIRECTS=false` switches loopback off; the MCP `Origin` allowlist follows the same hosts. The same flow — exact registered URI, PKCE S256, CSRF, the owner password — applies to every client, and a regression walks it for each default host and for loopback.

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
