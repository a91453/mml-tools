#!/bin/sh
# Published Canonical bootstrap gate for the Agent backend image.
#
# Scope: the Agent Control Plane only -- Railway project `mml-tools-allen`,
# service `mml-tools`. This checks the Agent backend's v1 Canonical LOADING
# implementation. It is not the Permanent Studio Web release architecture, and
# says nothing about `studio-web-permanent`, its pinned artifact, its trust
# bundle or `/studio-cache`.
#
# Status: IMPLEMENTATION NOTES. This grants nothing and certifies nothing: the
# runtime bootstrap re-establishes every one of these preconditions itself, from
# Git objects, on every load. What this script exists for is to prove, while the
# image is still being built, that it will.
#
# FATAL by design, and this is a deliberate reversal.
# --------------------------------------------------
# It used to exit 0 unconditionally, on the reasoning that a degraded build
# context must still produce an image that serves /healthz and the three legacy
# technical tools, and that a warning in the build log was enough. Production
# proved the second half wrong. The merged deployment succeeded -- /healthz PASS,
# container start PASS, Railway status SUCCESS -- while its own build log said:
#
#   [canonical-bootstrap] git-metadata: MISSING
#   [canonical-bootstrap] refs/remotes/origin/main: MISSING
#   [canonical-bootstrap] rules snapshot 0a172900...: MISSING
#   [canonical-bootstrap] status=CANONICAL_NOT_LOADED
#
# A green deployment whose every Canonical-aware operation refuses is worse than
# a failed build: nothing downstream of it -- not the healthcheck, not the
# deployment status, not the restart policy -- can tell the difference. So this
# is now a gate. `scripts/materialize-canonical.mjs` runs before it and is what
# actually makes the published history available; this proves the result, on the
# same capability path the runtime serves.
#
# Two distinct failures, never merged into one exit:
#   * status != CANONICAL_LOADED -- the published rules were not loaded.
#   * engine_status=ENGINE_UNAVAILABLE -- the rules loaded, the published
#     identity is real, and a Canonical-aware engine module could not be
#     imported in this image. Shipping that is shipping a service whose
#     Canonical operations all refuse, so it also fails the build, but it is a
#     different defect and is reported as one.
#
# Run from the Agent backend image root (the directory holding .git and studio/).

set -u

ROOT="${1:-/app}"
SNAPSHOT="${MML_RULES_SNAPSHOT_SHA:-0a172900a01fdf39c2e9e84cf176961320b779ea}"
say() { echo "[canonical-bootstrap] $*"; }

cd "$ROOT" || { say "image root $ROOT is not readable"; exit 1; }

# Preconditions, reported for the operator. None of them is the verdict: the
# capability path below is. They exist so a failure names what was missing
# instead of only that something was.
if [ -d "$ROOT/.git" ]; then
  say "git-metadata: present"
  if [ -f "$ROOT/.git/shallow" ]; then
    # Shallow is not fatal by itself. What decides the load is whether the
    # snapshot commit survived the truncation, which the next check answers.
    say "clone depth: SHALLOW (not fatal by itself; the snapshot check below decides)"
  else
    say "clone depth: complete"
  fi
else
  say "git-metadata: MISSING (neither the build context nor the materialization produced one)"
fi

if git -C "$ROOT" rev-parse --verify -q refs/remotes/origin/main >/dev/null 2>&1; then
  say "refs/remotes/origin/main: present"
else
  say "refs/remotes/origin/main: MISSING (the published ref the Manifest is read from)"
fi

if git -C "$ROOT" cat-file -e "$SNAPSHOT^{commit}" 2>/dev/null; then
  say "rules snapshot $SNAPSHOT: present"
else
  # Informational: the authority for which snapshot to load is the Manifest on
  # published main, never this default. A published release that moves the
  # snapshot makes this line read MISSING while the gate below still passes.
  say "rules snapshot $SNAPSHOT: not present (the Manifest on published main decides which snapshot is required)"
fi

# The verdict: the same capability path the runtime serves.
node -e "
import('./studio/backend/application/index.mjs').then(async m => {
  const c = await m.createStudioApplication({}).capabilities();
  const say = line => console.log('[canonical-bootstrap] ' + line);
  say('status=' + c.canonical.status);
  if (c.canonical.status !== 'CANONICAL_LOADED') {
    say('reason=' + c.canonical.reason);
    say('FATAL: Canonical-aware Studio operations would refuse in this image.');
    process.exit(2);
  }
  for (const field of ['canonical_version', 'canonical_status', 'manifest_version', 'rules_snapshot_sha', 'manifest_commit', 'published_main_head', 'repository_head', 'checkout_identity', 'build_source_head']) {
    say(field + '=' + c.canonical[field]);
  }
  if (c.canonical.engine_status) {
    say('engine_status=' + c.canonical.engine_status);
    say('FATAL: the published rules loaded, but a Canonical-aware engine module could not be imported in this image.');
    process.exit(3);
  }
  say('gate: PASS');
}).catch(error => { console.log('[canonical-bootstrap] gate could not run: ' + error.message); process.exit(4); });
" 2>&1
status=$?

if [ "$status" -ne 0 ]; then
  say "build refused: this image would deploy successfully and serve an unusable Canonical-aware service."
  say "The legacy technical tools and /healthz would be unaffected, which is exactly why this must not ship silently."
  exit 1
fi

exit 0
