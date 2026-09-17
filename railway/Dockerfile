# Agent Control Plane image: Railway project `mml-tools-allen`, service
# `mml-tools`. Serves OAuth, MCP `/mcp` and the Application API `/api/v1/*`.
#
# This is NOT the Permanent Studio Web deployment. That plane
# (`mml-tools-studio-permanent` / `studio-web-permanent`) serves a pinned,
# SHA256-verified release artifact from its own durable `/studio-cache`, and is
# neither built nor affected by this Dockerfile.
FROM node:24-bookworm-slim

# The deploying platform's own record of which commit produced the source tree.
# Railway supplies it as a build argument; it is carried into provenance and
# never acted on -- it selects no Manifest, no snapshot and no rule document.
# When it is absent, provenance reports null rather than guessing.
ARG RAILWAY_GIT_COMMIT_SHA=

# Read access to the published source. `a91453/mml-tools` is a private
# repository, so the build cannot resolve its published main without a
# credential; without one the build fails closed rather than producing an image
# whose Canonical-aware operations all refuse. Set it as a Railway build
# variable, scoped read-only to this repository's contents and nothing else --
# see railway/README.md.
#
# Below this line the token is never put in a URL, never written to a file,
# never placed in an argument vector and never printed: Git receives a
# credential-helper snippet naming the variable and the shell expands it from
# the environment. The `ARG` itself is a different matter and is not covered by
# that claim -- a build argument can be recovered from an image's build history
# and appears in the builder's process list, which is why railway/README.md says
# to scope this token to one repository's contents and to rotate it rather than
# treat it as long-lived. Railway passes build variables this way and offers no
# BuildKit secret mount, so this is the available channel, not the ideal one.
ARG MML_CANONICAL_SOURCE_TOKEN=

# The Published Canonical bootstrap shells out to git to read the Manifest from
# the published main ref and every rule document from the pinned rules snapshot.
# No git, no Canonical-aware operation -- the service would start and then
# report CANONICAL_NOT_LOADED for everything.
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
# `.git`, so `COPY . ./` above cannot carry an object store however the
# allowlist is written, and the merged #35 deployment proved it: a SUCCESS
# deployment whose build log read `git-metadata: MISSING` and
# `status=CANONICAL_NOT_LOADED`. This step builds the object store instead, from
# the published GitHub repository: it captures the published main SHA first,
# fetches that history, points `refs/remotes/origin/main` at the captured commit,
# reads the Manifest from that same commit and requires the exact
# `rules_snapshot_sha` it pins to be present. It fails the build if any of that
# cannot be proven, and it takes no fallback -- see
# studio/backend/bootstrap/materialize.mjs for why forging the published ref out
# of the build context is the one thing it must never do.
#
# No argument is passed for the published source, so the published GitHub
# repository is always what is used.
RUN MML_BUILD_SOURCE_HEAD="$RAILWAY_GIT_COMMIT_SHA" \
    MML_CANONICAL_SOURCE_TOKEN="$MML_CANONICAL_SOURCE_TOKEN" \
    node scripts/materialize-canonical.mjs

# Prove, on the same capability path the runtime serves, that this image loads
# the Published Canonical. FATAL: a build that cannot prove it must not become a
# deployment, because nothing downstream -- not /healthz, not the Railway
# deployment status, not the restart policy -- can tell a healthy service from
# one whose every Canonical-aware operation refuses. See the script header for
# the production failure that made this a gate rather than a warning.
#
# Note the Agent backend's Canonical view is pinned at build: the history is
# materialized here and nothing fetches at runtime, so publishing a new
# Canonical release does not reach this service until the image is rebuilt. The
# deployment watch patterns must include the Manifest for that reason. The rule
# sources stay unwatched on purpose -- they are read from the immutable snapshot
# the Manifest pins, never from main, so a change to one cannot alter what this
# image loads. See railway/README.md.
# The token is cleared here: an ARG is exported into every later RUN in the
# stage, and nothing in the gate needs read access to the published source.
RUN MML_CANONICAL_SOURCE_TOKEN= sh railway/canonical-probe.sh /app

ENV NODE_ENV=production \
    PORT=3000 \
    MML_AUTH_DB=/data/mml-auth.sqlite \
    MML_STUDIO_DATA_DIR=/data/studio
EXPOSE 3000
CMD ["node", "railway/server.mjs"]
