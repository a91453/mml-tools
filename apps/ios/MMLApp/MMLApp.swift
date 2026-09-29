import MMLCore
import MMLCoreJSC
import MMLProjects
import MMLWorkspace
import SwiftUI

/// Mabinogi Mobile MML — the native App.
///
/// Offline by construction: the shared MML core runs on the device in
/// JavaScriptCore (resources `NativeCore/`, built by `npm run build:native-core`)
/// and projects are files in the App's own container. No screen needs a
/// network, Railway or MCP.
@main
struct MMLApp: App {
    @State private var workspace: Workspace

    init() {
        let store = (try? FileProjectStore.applicationSupport())
            ?? FileProjectStore(root: URL.documentsDirectory.appending(path: "Projects", directoryHint: .isDirectory))
        _workspace = State(initialValue: Workspace(store: store))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(workspace)
                .task {
                    await workspace.refreshLibrary()
                    await workspace.startCore { try JavaScriptCoreEngine.bundled() }
                }
        }
    }
}
