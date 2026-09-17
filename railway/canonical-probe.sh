#!/bin/sh
# Published Canonical bootstrap probe for a built image.
#
# Status: IMPLEMENTATION NOTES. Deployment diagnostics only. This grants
# nothing and certifies nothing: the bootstrap re-establishes every one of
# these preconditions itself, from Git, on every load. What this script exists
# for is to put the answer somewhere an operator can see it.
#
# Why it exists at all. The bootstrap reads the Manifest from
# refs/remotes/origin/main and every rule document from the pinned rules
# snapshot, both out of Git history. A build context that arrived without that
# history still produces a working image -- the service starts, answers
# /healthz, and keeps serving the three legacy technical tools -- and reports
# CANONICAL_NOT_LOADED for everything Canonical-aware. That is the correct,
# fail-closed behaviour, but it is easy to miss, and the runtime capability
# endpoint that reports it is behind OAuth. A build log is not.
#
# Deliberately NON-FATAL: it always exits 0. Failing the build here would take
# a deployment that still serves its existing tools down over a degraded
# capability. Silence is the only outcome it rules out.
#
# Run from the image root (the directory holding .git and studio/).

set -u

ROOT="${1:-/app}"
SNAPSHOT="${MML_RULES_SNAPSHOT_SHA:-0a172900a01fdf39c2e9e84cf176961320b779ea}"
say() { echo "[canonical-bootstrap] $*"; }

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
  say "git-metadata: MISSING (this build context carried no .git)"
fi

if git -C "$ROOT" rev-parse --verify -q refs/remotes/origin/main >/dev/null 2>&1; then
  say "refs/remotes/origin/main: present"
else
  say "refs/remotes/origin/main: MISSING (the published ref the Manifest is read from)"
fi

if git -C "$ROOT" cat-file -e "$SNAPSHOT^{commit}" 2>/dev/null; then
  say "rules snapshot $SNAPSHOT: present"
else
  say "rules snapshot $SNAPSHOT: MISSING (history truncated before it; a shallow clone is not deep enough)"
fi

# The authoritative answer: the same capability path the runtime serves.
node -e "
import('./studio/backend/application/index.mjs').then(async m => {
  const c = await m.createStudioApplication({}).capabilities();
  const say = line => console.log('[canonical-bootstrap] ' + line);
  say('status=' + c.canonical.status);
  if (c.canonical.status === 'CANONICAL_LOADED') {
    for (const field of ['canonical_version', 'rules_snapshot_sha', 'manifest_commit', 'published_main_head', 'repository_head']) {
      say(field + '=' + c.canonical[field]);
    }
  } else {
    say('reason=' + c.canonical.reason);
    say('WARNING: Canonical-aware Studio operations will refuse in this image.');
    say('The legacy technical tools and /healthz are unaffected.');
  }
}).catch(error => console.log('[canonical-bootstrap] probe failed: ' + error.message));
" 2>&1 || say "probe could not run"

exit 0
