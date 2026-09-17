// Build-time entry point for the Published Canonical materialization.
//
// Run once while the Agent Control Plane image is built, before the build probe.
// It makes the image's Git object store carry the published history that
// `loadPublishedCanonical` reads at runtime, and fails the build if it cannot.
//
//   node scripts/materialize-canonical.mjs
//     [--root <path>]                  default: this checkout
//     [--published-source <url>]       default: the published GitHub repository
//     [--build-source-head <sha>]      default: $MML_BUILD_SOURCE_HEAD
//
// `--published-source` exists so regressions can point the materialization at a
// deterministic local fixture instead of depending on live GitHub. The image
// build passes it nothing and therefore always uses the published repository.
//
// `--build-source-head` is the deploying platform's own record of which commit
// produced the source tree (on Railway, `RAILWAY_GIT_COMMIT_SHA`). It is carried
// into provenance and never acted on: it selects no Manifest, no snapshot and no
// rule document. When the platform supplies none, provenance says `null` rather
// than guessing.
//
// `a91453/mml-tools` is private, so reaching the published source needs a
// read-only credential in `$MML_CANONICAL_SOURCE_TOKEN`. Without one the build
// fails here rather than producing an image whose Canonical-aware operations all
// refuse. The token is never printed, never written and never put in a URL.
import { fileURLToPath } from 'node:url';

import { materializePublishedCanonical, PUBLISHED_SOURCE, SOURCE_TOKEN_VARIABLE } from '../studio/backend/bootstrap/materialize.mjs';

const OPTIONS = new Set(['--root', '--published-source', '--build-source-head']);

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!OPTIONS.has(name) || argv[index + 1] === undefined) {
      throw Error(`Usage: node scripts/materialize-canonical.mjs [${[...OPTIONS].join(' <value>] [')} <value>]`);
    }
    values[name] = argv[index + 1];
  }
  return values;
}

try {
  const values = parseArguments(process.argv.slice(2));
  const buildSourceHead = values['--build-source-head'] ?? process.env.MML_BUILD_SOURCE_HEAD ?? '';
  const summary = materializePublishedCanonical({
    root: values['--root'] ?? fileURLToPath(new URL('../', import.meta.url)),
    publishedSource: values['--published-source'] ?? PUBLISHED_SOURCE,
    buildSourceHead: buildSourceHead === '' ? null : buildSourceHead,
  });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  // The reason, plus — when the published source could not be reached and no
  // credential was supplied — the one thing an operator most likely needs to
  // set. The token's value is never read here, only whether one exists.
  const missingCredential = /published source/.test(error.message)
    && !(process.env[SOURCE_TOKEN_VARIABLE] ?? '');
  console.error(JSON.stringify({
    status: 'CANONICAL_NOT_LOADED',
    message: error.message,
    legacyFallbackAllowed: false,
    ...(missingCredential
      ? { hint: `${PUBLISHED_SOURCE} is a private repository and $${SOURCE_TOKEN_VARIABLE} is not set; supply a read-only credential for it.` }
      : {}),
  }));
  process.exitCode = 1;
}
