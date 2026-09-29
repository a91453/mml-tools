import MMLProjects
import MMLWorkspace
import SwiftUI
import UniformTypeIdentifiers

struct ProjectEditorView: View {
    @Bindable var session: ProjectSession
    @State private var importing = false
    @State private var exporting = false
    @State private var exportDocument: ProjectFileDocument?
    @State private var fileError: String?

    var body: some View {
        Form {
            Section("專案") {
                TextField("曲名", text: $session.title)
            }

            Section {
                TextField("拍號圖（每行「起拍 拍號」，例：0 4/4）", text: $session.score.meterText, axis: .vertical)
                    .lineLimit(1...6)
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("弱起拍長（沒有則留空）", text: $session.score.pickup)
                    .font(.body.monospaced())
                    .keyboardType(.numbersAndPunctuation)
                TextField("末小節拍長（沒有則留空）", text: $session.score.finalPartial)
                    .font(.body.monospaced())
                    .keyboardType(.numbersAndPunctuation)
            } header: {
                Text("來源確認的時間結構")
            } footer: {
                Text("依來源填寫。檢查不會假設 4/4，也不會補休止、延長音符或裁尾。")
            }

            Section {
                TextEditor(text: $session.score.mml)
                    .font(.callout.monospaced())
                    .frame(minHeight: 180)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("六軌 MML（MML@…;）")
            } footer: {
                Text("\(session.score.mml.count) 字")
            }

            Section {
                CheckResultView(record: session.project.lastCheck, freshness: session.freshness)
                if let checkError = session.checkError {
                    Label(checkError, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.red)
                }
            } header: {
                Text("技術檢查")
            } footer: {
                Text("在這台裝置上以 Published Canonical 執行，與 MCP 的 mml_validate 是同一份實作。技術 PASS 不代表來源、聽驗、播放器回讀或實機驗收。")
            }

            if let error = fileError ?? session.saveError {
                Section { Text(error).font(.caption).foregroundStyle(.red) }
            }
        }
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await session.runTechnicalCheck() }
                } label: {
                    if session.isChecking {
                        ProgressView()
                    } else {
                        Label("檢查", systemImage: "checkmark.circle")
                    }
                }
                .disabled(!session.canCheck)
            }
            ToolbarItem(placement: .secondaryAction) {
                Button {
                    importing = true
                } label: {
                    Label("匯入 MML 文字檔", systemImage: "square.and.arrow.down")
                }
            }
            ToolbarItem(placement: .secondaryAction) {
                ShareLink(item: session.score.mml) {
                    Label("分享 MML 文字", systemImage: "square.and.arrow.up")
                }
                .disabled(session.score.mml.isEmpty)
            }
            ToolbarItem(placement: .secondaryAction) {
                Button {
                    do {
                        exportDocument = ProjectFileDocument(data: try session.exportData())
                        exporting = true
                    } catch {
                        fileError = error.localizedDescription
                    }
                } label: {
                    Label("匯出專案檔", systemImage: "doc.badge.arrow.up")
                }
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: Self.importTypes, allowsMultipleSelection: false) { result in
            importFile(result)
        }
        .fileExporter(isPresented: $exporting, document: exportDocument, contentType: .json, defaultFilename: "\(session.title).mmlproj.json") { result in
            if case let .failure(error) = result { fileError = error.localizedDescription }
            exportDocument = nil
        }
        .onDisappear {
            Task { await session.close() }
        }
    }

    // Plain text, and `.mml` files declared as plain text. The core decides
    // what the text is; the importer only refuses what is not UTF-8.
    private static let importTypes: [UTType] = [UTType.plainText] + [UTType(filenameExtension: "mml", conformingTo: .plainText)].compactMap { $0 }

    private func importFile(_ result: Result<[URL], Error>) {
        do {
            guard let url = try result.get().first else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > ProjectSession.maximumImportBytes {
                throw ProjectSession.ImportError.tooLarge(size)
            }
            try session.importMML(data: Data(contentsOf: url))
            fileError = nil
        } catch ProjectSession.ImportError.notUTF8 {
            fileError = "檔案不是 UTF-8 文字，未匯入。"
        } catch ProjectSession.ImportError.tooLarge {
            fileError = "檔案過大，未匯入。"
        } catch {
            fileError = error.localizedDescription
        }
    }
}

/// The saved project file, for the system exporter.
struct ProjectFileDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.json]

    var data: Data

    init(data: Data) {
        self.data = data
    }

    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}
