# Mabinogi Mobile MML — native iPhone / iPad App

Status: Stage 1 foundation. Implementation notes, not a Canonical rule source.
Rules are loaded only through [docs/CANONICAL_MANIFEST.md](../../docs/CANONICAL_MANIFEST.md).
Architecture and decisions: [docs/architecture/](../../docs/architecture/MML_APP_ARCHITECTURE.md).

A SwiftUI App that keeps a local project library and runs the Published
Canonical technical check **on the device, offline**. The check is not
reimplemented in Swift: the App evaluates the repository's shared engines
(`studio/backend`) in JavaScriptCore, through the same technical service the MCP
`mml_validate` tool uses. Same request, same report.

```text
MMLApp (SwiftUI)                      apps/ios/MMLApp/
  └─ MMLWorkspace  observable models  apps/ios/MMLKit/Sources/MMLWorkspace
      ├─ MMLProjects  project files   …/MMLProjects   (Application Support/Projects/<id>.mmlproj/project.json)
      └─ MMLCore      engine contract …/MMLCore
          └─ MMLCoreJSC  JavaScriptCore host of the shared core
              └─ NativeCore/mml-core.js  ← npm run build:native-core (studio/native + studio/backend + dist/core.js)
```

No part of this path uses a network, Railway or MCP.

## Build and run

Requirements: Xcode 16 or newer (iOS 17 SDK or newer; App Store Connect uploads
need Xcode 26), Node.js 22, and a clone with the published `main` history (the
core build reads the Published Canonical Manifest and rules snapshot from Git;
see [studio/README.md](../../studio/README.md)).

```sh
# at the repository root
npm ci --ignore-scripts
npm run build:native-core        # writes studio/native-build/{mml-core.js,mml-core.json,conformance.json}
open apps/ios/MMLApp.xcodeproj   # then Run on a Simulator or device
```

The Xcode build copies `studio/native-build/mml-core.{js,json}` into the App
(`NativeCore/`) and fails with an explicit message if they were not built. Xcode
never runs Node. Rebuild the core after changing anything under `studio/backend`,
`studio/native` or `dist/core.js`, and after the Published Canonical Manifest
moves.

The project follows the same owner's `a91453/railway-game-ios`:
[`project.yml`](project.yml) is the XcodeGen spec and the source of every
project setting; `MMLApp.xcodeproj` is generated from it with the pinned XcodeGen
(2.46.0) and committed, and CI fails if the two differ. Change `project.yml`,
regenerate, commit both; never edit the project in Xcode's project editor. The
exact commands, including building XcodeGen on Linux, are in
[CLAUDE.md](CLAUDE.md). A signing team is not set: `DEVELOPMENT_TEAM` goes into
`project.yml` once the owner decides it.

The bundle identifier `io.github.a91453.MMLApp` (the pattern of
`io.github.a91453.RailwayGame`) and the project file format
`io.github.a91453.mml-tools.project` are placeholders in the owner's namespace
until an App Store identifier is registered. The App icon is the Studio icon
(`studio/web/icon.svg`) rendered full-bleed at 1024×1024 without alpha.

Debug builds launched with `-demo-project` create two sample projects in a
temporary library (never the user's) through the ordinary Workspace calls and
check them with the local core; Visual Smoke uses it for screenshots. Release
builds do not contain it.

## Tests and CI

```sh
# after npm run build:native-core, at the repository root
node --test tests/native-core.test.mjs
swift build --package-path apps/ios/MMLKit --build-tests -Xswiftc -warnings-as-errors
swift test --package-path apps/ios/MMLKit   # macOS (Apple JavaScriptCore) or Linux (WebKitGTK JavaScriptCore)
```

On Linux the package builds against WebKitGTK's JavaScriptCore, which exposes the
same C API: install `libjavascriptcoregtk-4.1-dev` and a Swift 6 toolchain. The
SwiftUI App itself builds only with Xcode. Tests fail instead of skipping when
the core is not built; `MML_NATIVE_CORE_DIR` points them at another build (on a
Simulator, pass it as `TEST_RUNNER_MML_NATIVE_CORE_DIR`).

What the tests establish:

- every case in `studio/native/conformance-cases.mjs` gives, on JavaScriptCore,
  the same JSON answer the Node server path gave when the core was built;
- every Canonical engine the server gate loads evaluates in a bare host, and MIDI
  and MusicXML intake there answers byte for byte as in Node (the ground for the
  next stages);
- a bundle that does not match its manifest is refused before evaluation, and a
  core whose Canonical package fails verification refuses every check with
  `CANONICAL_NOT_LOADED`;
- create → enter MML → check → save → close → relaunch → reopen gives the same
  project and the same result; an edit or another engine marks a stored result
  stale; a late check never writes an older score over newer edits; a project
  opened before the core loaded is checked once it loads; a deleted project
  stays deleted;
- no App source uses a network API.

| Workflow | When | What it runs |
| --- | --- | --- |
| [`ios-app-ci.yml`](../../.github/workflows/ios-app-ci.yml) | Changes to the App, the shared core, the Manifest or the build | MMLKit on Linux (Swift 6.0 and 6.4, warnings as errors); on `macos-26`: committed-project drift check, schemes and archivable products, native core regressions, MMLKit on macOS and the iOS Simulator, App builds for Simulator (Debug) and device (Release, unsigned) |
| [`ios-visual-smoke.yml`](../../.github/workflows/ios-visual-smoke.yml) | By hand (Actions → iOS Visual Smoke → Run workflow), and PRs that change it | iPhone and iPad Simulator screenshots, plain and `-demo-project`, in the `ios-visual-smoke` artifact: open it from the run's Summary page on a phone |
| [`ios-release-archive.yml`](../../.github/workflows/ios-release-archive.yml) | By hand, and PRs that change project settings or App resources | Unsigned Release archive for the iOS device SDK; checks bundle id, icon, no `DEBUG`, no demo argument, and that the archived core is the one built and matches its manifest |

None of these proves signing, upload to App Store Connect or TestFlight. The
TestFlight pipeline (railway-game-ios's `testflight.yml` and its scripts) is the
next step and needs the owner's Apple Developer team, bundle identifier and
App Store Connect app first; see
[MML_APP_STAGE_1.md](../../docs/architecture/MML_APP_STAGE_1.md).

## Stage 1 scope

In: project library, create / rename / delete, enter or import MML text, the
source-confirmed meter map, pickup and final partial bar, the Published
Canonical technical check with its diagnostics, Canonical identity, offline
reading of the published rule documents, autosave, export of the project file
and share of the MML text.

Not yet: sources (MIDI, MusicXML, audio), the Studio review pipeline, the
six-role editor, playback, Final generation and iCloud / Files document
integration. See [MML_APP_STAGE_1.md](../../docs/architecture/MML_APP_STAGE_1.md).
