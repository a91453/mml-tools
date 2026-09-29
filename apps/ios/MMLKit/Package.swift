// swift-tools-version: 6.0
//
// MMLKit: the App's Swift layers around the shared MML core.
//
//   MMLCore       the engine contract and its value types. No engine, no I/O.
//   MMLCoreJSC    the shared JavaScript core (studio/native, built by
//                 scripts/build-native-core.mjs) hosted in JavaScriptCore.
//   MMLProjects   the project model and its local file persistence.
//   MMLWorkspace  the observable models the SwiftUI App binds to.
//
// JavaScriptCore is a system framework on Apple platforms. On Linux the same C
// API comes from WebKitGTK's javascriptcoregtk-4.1, so the bridge and every
// test also build and run there.
import PackageDescription

let package = Package(
    name: "MMLKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "MMLCore", targets: ["MMLCore"]),
        .library(name: "MMLCoreJSC", targets: ["MMLCoreJSC"]),
        .library(name: "MMLProjects", targets: ["MMLProjects"]),
        .library(name: "MMLWorkspace", targets: ["MMLWorkspace"]),
    ],
    targets: [
        .target(name: "MMLCore"),
        .systemLibrary(
            name: "CJavaScriptCore",
            path: "Sources/CJavaScriptCore",
            pkgConfig: "javascriptcoregtk-4.1",
            providers: [.apt(["libjavascriptcoregtk-4.1-dev"])]
        ),
        .target(
            name: "MMLCoreJSC",
            dependencies: [
                "MMLCore",
                .target(name: "CJavaScriptCore", condition: .when(platforms: [.linux])),
            ]
        ),
        .target(name: "MMLProjects", dependencies: ["MMLCore"]),
        .target(name: "MMLWorkspace", dependencies: ["MMLCore", "MMLProjects"]),
        .target(
            name: "MMLTestSupport",
            dependencies: ["MMLCore", "MMLCoreJSC"],
            path: "Tests/Support"
        ),
        .testTarget(name: "MMLCoreTests", dependencies: ["MMLCore"]),
        .testTarget(name: "MMLCoreJSCTests", dependencies: ["MMLCoreJSC", "MMLTestSupport"]),
        .testTarget(name: "MMLProjectsTests", dependencies: ["MMLProjects"]),
        .testTarget(name: "MMLWorkspaceTests", dependencies: ["MMLWorkspace", "MMLCoreJSC", "MMLTestSupport"]),
    ]
)
