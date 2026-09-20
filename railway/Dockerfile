# Agent Control Plane image: Railway project `mml-tools-allen`, service
# `mml-tools`. Serves OAuth, MCP `/mcp`, the Application API `/api/v1/*`
# and its service project workspace `/studio/`.
#
# This is NOT the Permanent Studio Web deployment. That plane
# (`mml-tools-studio-permanent` / `studio-web-permanent`) serves a pinned,
# SHA256-verified release artifact from its own durable `/studio-cache`, and is
# neither built nor affected by this Dockerfile.
#
# Two stages, and the split is a security boundary rather than a size
# optimisation. `a91453/mml-tools` is private, so obtaining the published Git
# history needs a read credential, and Railway's only documented way to give a
# Dockerfile build a variable is `ARG` -- it supports `--mount=type=cache` but
# documents no `--mount=type=secret`, and provides no way to supply one. A build
# argument consumed in a `RUN` is recorded in the image's own metadata, which was
# measured on BuildKit 29.3.1 for exactly the pattern below: in one stage the
# value appears in two `docker history` entries and in the image config blob of
# the exported image; with the `ARG` confined to a first stage, zero occurrences
# anywhere in it. See railway/README.md for the measurements, for what this still
# does not fix, and for the residual risk that needs owner acceptance.
#
# So: the credential is declared in the `canonical` stage and nowhere else. The
# runtime stage never names it, so it enters neither that stage's environment nor
# the final image's history.

# --- stage 1: obtain and verify the published Canonical history --------------
FROM node:24-bookworm-slim AS canonical

# Read access to the published source. Set it as a Railway build variable, scoped
# read-only to this repository's contents and nothing else, and prefer a Sealed
# variable so it cannot be read back from the dashboard or the API. The build
# fails closed without it, which is correct: an image that cannot reach the
# published source must not become a deployment.
ARG MML_CANONICAL_SOURCE_TOKEN=

# The deploying platform's own record of which commit produced the source tree.
# Not a secret. It is carried into provenance and never acted on -- it selects no
# Manifest, no snapshot and no rule document -- and a value that is not a full
# commit SHA is reported and dropped rather than failing the build.
ARG RAILWAY_GIT_COMMIT_SHA=

# The Published Canonical bootstrap shells out to git to read the Manifest from
# the published main ref and every rule document from the pinned rules snapshot.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a source-only change does not re-resolve them. The
# single runtime dependency is exactly pinned in package.json, install scripts
# stay disabled, and nothing here contacts a paid service.
COPY package.json ./package.json
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

# The .dockerignore allowlist decides what this copies.
COPY . ./

# The bootstrap binds git to this directory and refuses to walk outward, and the
# image's checkout is owned by a different uid than the build's. Declaring it
# safe here is the one configuration git needs to read its own objects.
RUN git config --system --add safe.directory /app || true

# Make the published history available to the runtime bootstrap.
#
# Railway's GitHub source snapshot delivers this repository's files without
# `.git`, so `COPY . ./` above cannot carry an object store however the allowlist
# is written, and the merged #35 deployment proved it: a SUCCESS deployment whose
# build log read `git-metadata: MISSING` and `status=CANONICAL_NOT_LOADED`. This
# step builds the object store instead, from the published GitHub repository: it
# captures the published main SHA first, fetches that history, points
# `refs/remotes/origin/main` at the captured commit, reads the Manifest from that
# same commit and requires the exact `rules_snapshot_sha` it pins to be present.
# It fails the build if any of that cannot be proven, and it takes no fallback --
# see studio/backend/bootstrap/materialize.mjs for why forging the published ref
# out of the build context is the one thing it must never do.
#
# No argument is passed for the published source, so the published GitHub
# repository is always what is used. The credential never enters a URL, a file or
# an argument vector: Git receives a credential-helper snippet naming the
# variable and the shell expands it from this command's environment.
#
# Nothing is assigned inline here either, and that is deliberate. A build
# argument is already exported into this command's environment, while BuildKit
# prints the *expanded* RUN command as the step title -- so writing
# `MML_CANONICAL_SOURCE_TOKEN="$MML_CANONICAL_SOURCE_TOKEN"` would publish the
# value to the build log on every build. Naming neither variable here keeps both
# out of it; the step reads them from the environment itself.
RUN node scripts/materialize-canonical.mjs

# --- stage 2: the image that actually ships ----------------------------------
#
# No `ARG MML_CANONICAL_SOURCE_TOKEN` here, deliberately. An undeclared build
# argument is not injected into a stage, so the credential is absent from this
# stage's environment, from every layer it produces and from the final image's
# history. Do not add one: that single line would put the value back into
# `docker history` for anyone who can pull the image.
FROM node:24-bookworm-slim

# The runtime bootstrap reads the Manifest and every rule document out of the Git
# objects stage 1 materialized, so the binary has to be here too.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies, sources, the materialized object store and the bootstrap record,
# exactly as stage 1 left them. Nothing is re-fetched and nothing is re-resolved.
COPY --from=canonical /app /app

RUN git config --system --add safe.directory /app || true

# Prove, on the same capability path the runtime serves, that this image loads
# the Published Canonical. FATAL: a build that cannot prove it must not become a
# deployment, because nothing downstream -- not /healthz, not the Railway
# deployment status, not the restart policy -- can tell a healthy service from
# one whose every Canonical-aware operation refuses. See the script header for
# the production failure that made this a gate rather than a warning.
#
# It runs in this stage rather than the first so that what is proven is the image
# that ships, after the copy, rather than the one the copy came from.
#
# Note the Agent backend's Canonical view is pinned at build: the history is
# materialized in stage 1 and nothing fetches at runtime, so publishing a new
# Canonical release does not reach this service until the image is rebuilt. The
# deployment watch patterns must include the Manifest for that reason. The rule
# sources stay unwatched on purpose -- they are read from the immutable snapshot
# the Manifest pins, never from main, so a change to one cannot alter what this
# image loads. See railway/README.md.
RUN sh railway/canonical-probe.sh /app

ENV NODE_ENV=production \
    PORT=3000 \
    MML_AUTH_DB=/data/mml-auth.sqlite \
    MML_STUDIO_DATA_DIR=/data/studio
EXPOSE 3000

# Railway injects service variables into the running deployment as well as into
# the build, so the read credential arrives here even though this stage never
# declared it as a build argument. `railway/server.mjs` removes it before the
# service handles anything, and the runtime Git adapter strips it from every
# child process it spawns. See studio/backend/bootstrap/index.mjs.
CMD ["node", "railway/server.mjs"]
