#if DEBUG
import Foundation
import MMLProjects
import MMLWorkspace

/// Sample projects for Simulator screenshots, opened only by Debug builds
/// launched with ``launchArgument`` (see .github/workflows/ios-visual-smoke.yml).
///
/// Not a shortcut: the library lives in a fresh temporary directory, never the
/// user's, and every project is created, filled in and checked through the same
/// `Workspace` and `ProjectSession` calls the screens use. Every verdict shown
/// is the local core's own; nothing here states what the rules say.
enum DemoProject {
    static let launchArgument = "-demo-project"

    static var isRequested: Bool {
        ProcessInfo.processInfo.arguments.contains(launchArgument)
    }

    static func makeStore() -> FileProjectStore {
        FileProjectStore(root: FileManager.default.temporaryDirectory.appending(path: "MMLDemo-\(UUID().uuidString)", directoryHint: .isDirectory))
    }

    /// Creates and checks the sample projects; returns the one to open.
    @MainActor
    static func prepare(in workspace: Workspace) async -> UUID? {
        do {
            let failing = try await workspace.createProject(title: "示範：Tempo 256")
            failing.score = ScoreInput(mml: "MML@t256o4l4cdefgab>c,t256o3l2cegc,,,,;", meterText: "0 4/4")
            await failing.runTechnicalCheck()
            await failing.close()

            let opened = try await workspace.createProject(title: "示範：兩軌練習")
            opened.score = ScoreInput(mml: "MML@t120o4l4cdefgab>c<bag,t120o3l2cegcfg,,,,;", meterText: "0 4/4")
            await opened.runTechnicalCheck()
            await opened.close()
            return opened.id
        } catch {
            return nil
        }
    }
}
#endif
