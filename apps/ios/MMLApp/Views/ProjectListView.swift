import MMLProjects
import MMLWorkspace
import SwiftUI

struct ProjectListView: View {
    @Environment(Workspace.self) private var workspace
    @Binding var selection: UUID?
    @State private var isNaming = false
    @State private var newTitle = ""
    @State private var showingIdentity = false
    @State private var actionError: String?

    var body: some View {
        List(selection: $selection) {
            Section {
                ForEach(workspace.projects) { summary in
                    NavigationLink(value: summary.id) {
                        ProjectRow(summary: summary)
                    }
                }
                .onDelete(perform: delete)
            }
            if !workspace.unreadableProjects.isEmpty {
                Section {
                    ForEach(workspace.unreadableProjects) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.location.lastPathComponent).font(.callout.monospaced())
                            Text(item.reason).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                } header: {
                    Text("無法讀取的專案")
                } footer: {
                    Text("檔案保留原樣，不會被覆寫或刪除。")
                }
            }
            Section {
                Button {
                    showingIdentity = true
                } label: {
                    CoreStatusRow(state: workspace.coreState)
                }
                .buttonStyle(.plain)
            }
            if let error = actionError ?? workspace.libraryError {
                Section { Text(error).font(.caption).foregroundStyle(.red) }
            }
        }
        .navigationTitle("MML 專案")
        .overlay {
            if workspace.projects.isEmpty && workspace.unreadableProjects.isEmpty {
                ContentUnavailableView("還沒有專案", systemImage: "music.quarternote.3", description: Text("按 ＋ 建立第一個專案。"))
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    newTitle = ""
                    isNaming = true
                } label: {
                    Label("新增專案", systemImage: "plus")
                }
            }
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    showingIdentity = true
                } label: {
                    Label("核心與 Canonical", systemImage: "checkmark.seal")
                }
            }
        }
        .alert("新增專案", isPresented: $isNaming) {
            TextField("曲名", text: $newTitle)
            Button("建立") { Task { await create() } }
            Button("取消", role: .cancel) {}
        }
        .sheet(isPresented: $showingIdentity) {
            NavigationStack { CoreIdentityView() }
        }
        .refreshable { await workspace.refreshLibrary() }
    }

    private func create() async {
        do {
            let session = try await workspace.createProject(title: newTitle)
            actionError = nil
            selection = session.id
        } catch {
            actionError = String(describing: error)
        }
    }

    private func delete(at offsets: IndexSet) {
        let ids = offsets.map { workspace.projects[$0].id }
        Task {
            for id in ids {
                if selection == id { selection = nil }
                do {
                    try await workspace.deleteProject(id: id)
                } catch {
                    actionError = String(describing: error)
                }
            }
        }
    }
}

private struct ProjectRow: View {
    let summary: ProjectSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(summary.title).font(.headline)
            HStack(spacing: 8) {
                LastCheckBadge(summary: summary.lastCheck)
                Text(summary.updatedAt, format: .dateTime.year().month().day().hour().minute())
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// The stored verdict as the core stated it. Whether it is still current is
/// shown inside the project, against the running core.
struct LastCheckBadge: View {
    let summary: LastCheckSummary

    var body: some View {
        switch summary {
        case .none:
            Label("未檢查", systemImage: "circle.dashed").labelStyle(.titleAndIcon).font(.caption).foregroundStyle(.secondary)
        case .technicalPass:
            Label("技術 PASS", systemImage: "checkmark.seal.fill").font(.caption).foregroundStyle(.green)
        case .technicalFail:
            Label("技術 FAIL", systemImage: "xmark.octagon.fill").font(.caption).foregroundStyle(.red)
        case let .refused(code):
            Label("未判定 \(code)", systemImage: "questionmark.diamond").font(.caption).foregroundStyle(.orange)
        }
    }
}

struct CoreStatusRow: View {
    let state: CoreState

    var body: some View {
        switch state {
        case .loading:
            HStack {
                ProgressView()
                Text("載入本機 MML 核心…").font(.caption)
            }
        case let .failed(message):
            Label {
                VStack(alignment: .leading) {
                    Text("本機核心無法載入，暫停檢查").font(.caption.bold())
                    Text(message).font(.caption2).foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            }
        case let .ready(identity):
            Label {
                VStack(alignment: .leading) {
                    Text(identity.isCanonicalReady ? "Published Canonical \(identity.canonical.canonicalVersion ?? "")" : "Published Canonical 未載入，暫停檢查")
                        .font(.caption.bold())
                    Text("本機核心 · 離線可用").font(.caption2).foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: identity.isCanonicalReady ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(identity.isCanonicalReady ? .green : .red)
            }
        }
    }
}
