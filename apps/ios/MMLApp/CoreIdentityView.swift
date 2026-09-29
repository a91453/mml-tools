import MMLCore
import MMLWorkspace
import SwiftUI

/// What the App runs: the Published Canonical release inside the local core,
/// the validation profile, the core bundle and the published documents it
/// carries, readable offline.
struct CoreIdentityView: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            switch workspace.coreState {
            case .loading:
                ProgressView("載入本機 MML 核心…")
            case let .failed(message):
                Section("本機核心無法載入") {
                    Text(message).font(.callout)
                    Text("檢查暫停；專案仍可開啟、編輯與儲存。").font(.caption).foregroundStyle(.secondary)
                }
            case let .ready(identity):
                Section {
                    Field("狀態", identity.canonical.status)
                    Field("canonical_version", identity.canonical.canonicalVersion)
                    Field("canonical_status", identity.canonical.canonicalStatus)
                    Field("manifest_version", identity.canonical.manifestVersion)
                    Field("rules_snapshot_sha", identity.canonical.rulesSnapshotSHA)
                    Field("machine_delivery_schema", identity.canonical.machineDeliverySchema)
                    if let reason = identity.canonical.reason { Field("原因", reason) }
                } header: {
                    Text("Published Canonical")
                } footer: {
                    Text("唯一規則來源是 a91453/mml-tools 的 docs/CANONICAL_MANIFEST.md 指定的快照。本 App 只執行，不定義規則。")
                }

                Section("驗證") {
                    Field("Canonical 驗證", identity.validation.canonicalValidation)
                    Field("profile", identity.validation.profile)
                    Field("legacy core（僅標示）", [identity.validation.legacyCoreVersion, identity.validation.legacyProfile].compactMap { $0 }.joined(separator: " · "))
                }

                Section("本機核心") {
                    Field("格式", identity.coreFormat)
                    Field("service_version", identity.serviceVersion)
                    Field("runtime package", identity.runtimePackageDigest)
                    if let bundle = identity.bundle {
                        Field("bundle SHA-256", bundle.sha256)
                        Field("大小", "\(bundle.bytes) bytes · \(bundle.moduleCount) modules")
                        Field("建置工具", "\(bundle.bundler) → \(bundle.target)")
                    }
                    Field("主機補齊的 API", identity.hostShims.isEmpty ? "無" : identity.hostShims.joined(separator: "、"))
                }

                if let audit = identity.bundle?.audit {
                    Section {
                        Field("manifest_commit", audit.manifestCommit)
                        Field("published_main_head", audit.publishedMainHead)
                        Field("repository_head", audit.repositoryHead)
                        Field("pr_head", audit.prHead)
                        Field("checkout_identity", audit.checkoutIdentity)
                    } header: {
                        Text("建置紀錄（僅供稽核）")
                    } footer: {
                        Text("建置時記錄的 Git 資訊；裝置上不重新驗證，也不決定載入哪一版規則。")
                    }
                }

                Section("規則文件（離線閱讀）") {
                    ForEach(identity.documents) { document in
                        NavigationLink {
                            CanonicalDocumentView(reference: document)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(document.path).font(.callout.monospaced())
                                Text(document.authority).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("核心與 Canonical")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("完成") { dismiss() }
            }
        }
    }
}

private struct Field: View {
    let label: String
    let value: String?

    init(_ label: String, _ value: String?) {
        self.label = label
        self.value = value
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value ?? "—").font(.callout.monospaced()).textSelection(.enabled)
        }
    }
}

private struct CanonicalDocumentView: View {
    @Environment(Workspace.self) private var workspace
    let reference: CanonicalDocumentReference
    @State private var content: String?
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("blob \(reference.blobSHA)").font(.caption2.monospaced()).foregroundStyle(.secondary)
                if let content {
                    Text(content).font(.footnote.monospaced()).textSelection(.enabled)
                } else if let error {
                    Text(error).foregroundStyle(.red)
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .navigationTitle(reference.path)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do {
                content = try await workspace.canonicalDocument(path: reference.path).content
            } catch {
                self.error = String(describing: error)
            }
        }
    }
}
