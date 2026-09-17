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
import { fileURLToPath } from 'node:url';

import { materializePublishedCanonical, PUBLISHED_SOURCE } from '../studio/backend/bootstrap/materialize.mjs';

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
  console.error(JSON.stringify({ status: 'CANONICAL_NOT_LOADED', message: error.message, legacyFallbackAllowed: false }));
  process.exitCode = 1;
}
