# Agent Control Plane image: Railway project `mml-tools-allen`, service
# `mml-tools`. Serves OAuth, MCP `/mcp` and the Application API `/api/v1/*`.
#
# This is NOT the Permanent Studio Web deployment. That plane
# (`mml-tools-studio-permanent` / `studio-web-permanent`) serves a pinned,
# SHA256-verified release artifact from its own durable `/studio-cache`, and is
# neither built nor affected by this Dockerfile.
FROM node:24-bookworm-slim

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

# Record in the build log whether this build context actually carried what the
# Agent backend's Canonical bootstrap needs. Non-fatal by design: see the script
# header for why a degraded context must still produce a working image, and why
# silence is the one outcome that is not acceptable.
#
# Note the Agent backend's Canonical view is pinned at build: `.git` is copied
# here and nothing fetches at runtime, so publishing a new Canonical release
# does not reach this service until the image is rebuilt. The deployment watch
# patterns must include the Manifest for that reason. The rule sources stay
# unwatched on purpose -- they are read from the immutable snapshot the Manifest
# pins, never from main, so a change to one cannot alter what this image loads.
# See railway/README.md.
RUN sh railway/canonical-probe.sh /app

ENV NODE_ENV=production \
    PORT=3000 \
    MML_AUTH_DB=/data/mml-auth.sqlite \
    MML_STUDIO_DATA_DIR=/data/studio
EXPOSE 3000
CMD ["node", "railway/server.mjs"]
