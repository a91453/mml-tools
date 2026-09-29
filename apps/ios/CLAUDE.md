# CLAUDE.md — apps/ios

Instructions for Claude Code sessions working on the native App. The root
[CLAUDE.md](../../CLAUDE.md) (Railway Agent and Copilot prohibition) applies
here too. This file is an engineering instruction, not a Mabinogi Mobile MML
Canonical rule source. The workflow follows the same owner's
`a91453/railway-game-ios`.

## Project

- `MMLKit/` — Swift package: `MMLCore` (engine contract), `MMLCoreJSC`
  (JavaScriptCore host of the shared core), `MMLProjects` (project files),
  `MMLWorkspace` (observable models). Tests in `MMLKit/Tests/`.
- `MMLApp/` — SwiftUI App (`App/`, `Views/`, `Resources/`).
- `project.yml` — XcodeGen spec, the source of all project settings.
  `MMLApp.xcodeproj` is generated from it and **committed**. Never hand-edit
  the `.xcodeproj` or change settings in Xcode's project editor.
- Architecture and decisions: `docs/architecture/`.

## Architecture rules

- **The shared core is the only MML authority.** Swift never parses,
  validates, normalizes or rewrites MML, and never restates a verdict: it sends
  requests to `MMLCoreEngine` and shows the answer. A new MML capability is
  added to `studio/backend` and exposed through `studio/native/core-facade.mjs`,
  never reimplemented in Swift.
- **Published Canonical** is loaded only through `docs/CANONICAL_MANIFEST.md`,
  at core build time. The App never downloads rules or code.
- **Offline.** No App source may use a network API (a test scans for them).
  Railway and MCP are not App dependencies (ADR-002).
- Do not raise `swift-tools-version` (6.0) or drop Swift 6.0 compatibility
  without a concrete reason. Keep `MMLCore`, `MMLCoreJSC`, `MMLProjects` and
  `MMLWorkspace` free of SwiftUI and UIKit so they build and test on Linux.
- Tests of main-actor types hop onto the main actor inside the test
  (`onMainActor` in `VerticalSliceTests`) instead of isolating the XCTestCase
  subclass, which Swift 6.0's test discovery on Linux rejects.

## Environments and validation

Claude Code cloud sessions run on **Linux**. Xcode, `xcodebuild`, the iOS
Simulator, SwiftUI and UIKit are not available there.

```sh
# at the repository root
npm ci --ignore-scripts
npm run build:native-core      # the core bundle every Swift test runs
node --test tests/native-core.test.mjs
# Swift 6 toolchain from swift.org, plus: apt-get install libjavascriptcoregtk-4.1-dev
swift build --package-path apps/ios/MMLKit --build-tests -Xswiftc -warnings-as-errors
swift test --package-path apps/ios/MMLKit
```

Apple-only checks run in GitHub Actions on macOS:

| Workflow | When | Verifies |
| --- | --- | --- |
| `ios-app-ci.yml` | App, core, Manifest or build changes | MMLKit on Linux (Swift 6.0, 6.4); committed-project drift; schemes and archivable products; MMLKit on macOS and the iOS Simulator; App builds for Simulator and device (unsigned) |
| `ios-visual-smoke.yml` | By hand, and PRs that change it | iPhone and iPad Simulator screenshots (`-demo-project` included) as the `ios-visual-smoke` artifact |
| `ios-release-archive.yml` | By hand, and PRs that change project settings or App resources | Unsigned Release archive for the iOS device SDK and inspection of the archived App, including the core it carries |

None of these proves signing, upload or TestFlight. There is no TestFlight
workflow yet. When one is added (port `a91453/railway-game-ios`'s
`testflight.yml` and scripts), it runs only by hand from `main`, its secrets
live only in a GitHub environment, and agents never trigger it.

Whenever `project.yml` or the App's file layout changes, regenerate the project
with the XcodeGen release pinned in `.github/actions/setup-xcodegen/action.yml`
(2.46.0) and commit the result. On Linux, build that release from source, from
a checkout directory named `mml-tools` (the directory name ends up in the
project):

```sh
git clone --depth 1 --branch 2.46.0 https://github.com/yonaskolb/XcodeGen /tmp/xcodegen
test "$(git -C /tmp/xcodegen rev-parse HEAD)" = 8445e778451c7e44237b90281bde622d764b0084
swift build -c release --package-path /tmp/xcodegen --product xcodegen
USER="${USER:-ci}" /tmp/xcodegen/.build/release/xcodegen generate --spec apps/ios/project.yml
```

The drift check in `ios-app-ci.yml` (the official macOS binary) is
authoritative. When upgrading XcodeGen, update the action and these lines
together.

Never claim a check passed unless it actually ran. Report results as
**VERIFIED** (ran, with where) or **UNVERIFIED** (for example "UNVERIFIED
LOCALLY — requires macOS/Xcode CI"). Static inspection is not runtime
verification.

## Workflow

- Work on a task branch and open a pull request. Never commit to `main`,
  never merge a PR, never enable auto-merge, never force-push `main`.
- Prefer small changes; no speculative abstractions, new dependencies or
  unrelated refactors.
- Never commit secrets: API keys, `.p8`/`.p12`, certificates, provisioning
  profiles, tokens or `.env` files. Signing identities (Team ID, App Store
  Connect app) are the owner's decision; never ask for passwords, 2FA codes or
  private keys.
