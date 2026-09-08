# Standalone MML OAuth service

This deployment uses the same MML core and tools as the Sites workbench. It does not trust Sites identity headers. The original workbench remains a separate browser application with its own Sites access policy.

## Required deployment settings

- Build context: repository root; Dockerfile: `railway/Dockerfile`.
- One service and **one replica**, with a persistent volume mounted at `/data`.
- `MML_PUBLIC_ORIGIN`: exact generated HTTPS origin, without a path.
- `MML_OWNER_PASSWORD`: a randomly generated 32–256 character service password; set only in Railway Variables, never in Git, a URL, a report, or the source ZIP.
- `MML_AUTH_DB`: `/data/mml-auth.sqlite`.
- `PORT`: Railway's supplied port, or 3000.
- Healthcheck: `/healthz`.

Configure these values through Railway service settings. `service-settings.json` is a non-executable reference snapshot, not a Railway Config as Code file. New services cannot opt into the deprecated `railway.toml` / `railway.json` mechanism; do not set a config-file override or point Nixpacks at such a file. See [Railway's migration notice](https://docs.railway.com/config-as-code). The source-controlled Dockerfile remains portable to other Docker-capable hosts.

The official Node image runs as root so it can write the root-mounted Railway volume. The application sets a restrictive file creation mask. No request can select a file path, run a shell command, install packages, or access other services. A non-root deployment needs the volume's ownership configured separately.

The image installs no npm packages and runs no package install scripts. Build from the root of the same source commit that passed the tests. A GitHub source must be explicitly selected for Railway's GitHub deployment tool; alternatively `railway up` requires its own authenticated CLI session.

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

## Authorization lifecycle

The service implements a limited, single-owner authorization-code flow, not a general identity provider. It uses server-side opaque tokens and Node cryptography. Access tokens expire after 15 minutes; authorizations and rotating refresh tokens expire after 30 days. Reusing a redeemed code or refresh token revokes its authorization family. Password rotation revokes existing grants while preserving client registrations. SQL parameters are bound, tokens/codes are stored only as hashes, and the mounted SQLite database preserves registrations and grants across service restarts.

The volume contains OAuth authorization records only. It does not contain MML, uploaded music or conversation history. Keep it private and back it up only within the same access policy. Never include it in downloadable source.

## Verification scope

Run `node --test tests/core.test.mjs tests/player.test.mjs tests/mcp.test.mjs tests/railway.test.mjs` before deployment. OAuth tests cover metadata discovery, DCR, exact callback validation, PKCE, CSRF, replay revocation, scope/resource binding, password rotation, persistence, and a real loopback HTTP flow through the MCP transport. Test credentials and callback URLs are synthetic.

Passing local tests is not a completed Railway deployment or ChatGPT account connection. Record live health, unauthenticated 401 challenge, metadata, authorized initialize/tools/list/tools/call, and the user's actual ChatGPT connection separately. No technical test proves original-audio listening or Mobile game acceptance.
