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

Requirements: Xcode 16 or newer (iOS 17 SDK or newer), Node.js 22, and a clone
with the published `main` history (the core build reads the Published Canonical
Manifest and rules snapshot from Git; see [studio/README.md](../../studio/README.md)).

```sh
# at the repository root
npm ci --ignore-scripts
npm run build:native-core        # writes studio/native-build/{mml-core.js,mml-core.json,conformance.json}
open apps/ios/MMLApp.xcodeproj   # choose a team under Signing & Capabilities, then Run
```

The Xcode build copies `studio/native-build/mml-core.{js,json}` into the App
(`NativeCore/`) and fails with an explicit message if they were not built. Xcode
never runs Node. Rebuild the core after changing anything under `studio/backend`,
`studio/native` or `dist/core.js`, and after the Published Canonical Manifest
moves.

The bundle identifier `io.github.a91453.mml-tools` and the project file format
`io.github.a91453.mml-tools.project` are placeholders in the repository owner's
namespace until an App Store identifier is registered.

## Tests

```sh
# after npm run build:native-core
swift test --package-path apps/ios/MMLKit              # macOS (Apple JavaScriptCore) or Linux (see below)
cd apps/ios/MMLKit && xcodebuild test -scheme MMLKit-Package -destination 'platform=iOS Simulator,name=iPhone 16'
xcodebuild build -project apps/ios/MMLApp.xcodeproj -scheme MMLApp -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
```

On Linux the package builds against WebKitGTK's JavaScriptCore, which exposes the
same C API: install `libjavascriptcoregtk-4.1-dev` and a Swift 6 toolchain. The
SwiftUI App itself builds only with Xcode.

Tests fail instead of skipping when the core is not built. `MML_NATIVE_CORE_DIR`
points them at another build (on a simulator, pass it as
`TEST_RUNNER_MML_NATIVE_CORE_DIR`).

What the tests establish:

- every case in `studio/native/conformance-cases.mjs` answers on JavaScriptCore
  exactly as the Node server path answered it when the core was built;
- a bundle that does not match its manifest is refused before evaluation, and a
  core whose Canonical package fails verification refuses every check with
  `CANONICAL_NOT_LOADED`;
- create → enter MML → check → save → close → relaunch → reopen gives the same
  project and the same result, and an edit or another engine marks a stored
  result stale;
- no App source uses a network API.

`.github/workflows/ios-app-ci.yml` runs all of this on macOS: the package tests
on macOS and on the iOS Simulator, and unsigned Simulator and device builds of
the App.

## Stage 1 scope

In: project library, create / rename / delete, enter or import MML text, the
source-confirmed meter map, pickup and final partial bar, the Published
Canonical technical check with its diagnostics, Canonical identity, offline
reading of the published rule documents, autosave, export of the project file
and share of the MML text.

Not yet: sources (MIDI, MusicXML, audio), the Studio review pipeline, the
six-role editor, playback, Final generation and iCloud / Files document
integration. See [MML_APP_STAGE_1.md](../../docs/architecture/MML_APP_STAGE_1.md).
