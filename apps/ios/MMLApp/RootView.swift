import MMLWorkspace
import SwiftUI

/// Library beside the open project. A split view on iPad and in wide windows;
/// on iPhone the same view collapses to a navigation stack.
struct RootView: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.scenePhase) private var scenePhase
    @State private var selection: UUID?
    @State private var session: ProjectSession?
    @State private var openError: String?

    var body: some View {
        NavigationSplitView {
            ProjectListView(selection: $selection)
        } detail: {
            if let session {
                ProjectEditorView(session: session)
                    .id(session.id)
            } else if let openError {
                ContentUnavailableView("無法開啟專案", systemImage: "exclamationmark.triangle", description: Text(openError))
            } else {
                ContentUnavailableView("選擇或建立專案", systemImage: "music.note.list", description: Text("專案只存在這台裝置上；檢查在裝置上執行，不需要網路。"))
            }
        }
        .task(id: selection) { await open(selection) }
        .onChange(of: scenePhase) { _, phase in
            // Leaving the foreground writes pending edits now rather than
            // trusting the autosave timer to run in the background.
            if phase != .active, let session { Task { await session.close() } }
        }
    }

    private func open(_ id: UUID?) async {
        if let current = session, current.id != id {
            await current.close()
            session = nil
        }
        guard let id, session?.id != id else {
            if id == nil { openError = nil }
            return
        }
        openError = nil
        do {
            let opened = try await workspace.openProject(id: id)
            // The user may have chosen another project while this one loaded;
            // `.task(id:)` cancels this task then, and a late load is dropped.
            guard !Task.isCancelled, selection == id else { return }
            session = opened
            openError = nil
        } catch {
            guard !Task.isCancelled, selection == id else { return }
            openError = String(describing: error)
        }
    }
}
