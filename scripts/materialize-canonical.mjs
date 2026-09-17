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
// than guessing -- and when it supplies something that is not a full commit SHA
// (abbreviated, upper-cased, padded), that is reported and dropped rather than
// failing the build. A field the module itself documents as selecting nothing
// must not be able to block a deployment.
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

const supplied = (values, name, variable) => (values[name] ?? process.env[variable] ?? '').trim();

try {
  const values = parseArguments(process.argv.slice(2));
  const rawBuildSourceHead = supplied(values, '--build-source-head', 'MML_BUILD_SOURCE_HEAD');
  const buildSourceHead = /^[0-9a-f]{40}$/.test(rawBuildSourceHead.toLowerCase()) ? rawBuildSourceHead.toLowerCase() : null;
  const summary = materializePublishedCanonical({
    root: values['--root'] ?? fileURLToPath(new URL('../', import.meta.url)),
    publishedSource: values['--published-source'] ?? PUBLISHED_SOURCE,
    buildSourceHead,
  });
  console.log(JSON.stringify({
    ...summary,
    ...(rawBuildSourceHead !== '' && buildSourceHead === null
      ? { build_source_head_ignored: 'the platform supplied a value that is not a full commit SHA; provenance reports null' }
      : {}),
  }, null, 2));
} catch (error) {
  // The reason, the underlying Git failure, and — when the published source
  // could not be reached — what to check first.
  //
  // Git's own stderr is the difference between a build an operator can fix and
  // one they can only guess at: a 401 from an expired token, a DNS failure, a
  // TLS failure and a proxy refusal all produce the same fixed reason above.
  // The token is not in the URL Git prints and not in the argument vector it
  // reports, so its stderr does not carry it; the redaction below is a belt on
  // top of that, not the reason it is safe.
  const token = process.env[SOURCE_TOKEN_VARIABLE] ?? '';
  const gitStderr = String(error?.cause?.stderr ?? '').trim();
  const reachability = /published source/.test(error.message);
  console.error(JSON.stringify({
    status: 'CANONICAL_NOT_LOADED',
    message: error.message,
    legacyFallbackAllowed: false,
    ...(gitStderr === '' ? {} : { gitError: (token === '' ? gitStderr : gitStderr.replaceAll(token, '<redacted>')).slice(0, 2000) }),
    ...(reachability
      ? {
        hint: token === ''
          ? `${PUBLISHED_SOURCE} is a private repository and $${SOURCE_TOKEN_VARIABLE} is not set; supply a read-only credential for it.`
          : `$${SOURCE_TOKEN_VARIABLE} is set; check that it has not expired and that it grants Contents: Read on ${PUBLISHED_SOURCE}.`,
      }
      : {}),
  }));
  process.exitCode = 1;
}
