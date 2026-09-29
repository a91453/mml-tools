import Foundation
import MMLCore
import MMLProjects
import Observation

/// One open project: editing, saving, importing and the technical check.
///
/// The session judges nothing itself. A check sends the score to the shared
/// core and stores the core's answer with the engine that gave it; whether a
/// stored answer still applies is decided by comparing the request and the
/// engine, never by re-reading the MML here.
@MainActor
@Observable
public final class ProjectSession: Identifiable {
    public private(set) var project: MMLProject
    public private(set) var hasUnsavedChanges = false
    public private(set) var isChecking = false
    /// A host fault from the last check (the core could not answer at all).
    public private(set) var checkError: String?
    /// The last save failure. The edits stay in memory, marked unsaved, and
    /// are written by the next save: the next edit's autosave, a check, or
    /// closing the project.
    public private(set) var saveError: String?

    @ObservationIgnored private let store: any ProjectStore
    // The running core, read when it is needed rather than when the session
    // was created: a project opened while the core was still loading can be
    // checked as soon as it loads.
    @ObservationIgnored private let currentCore: @MainActor () -> CoreState
    @ObservationIgnored private let currentEngine: @MainActor () -> (any MMLCoreEngine)?
    @ObservationIgnored private let clock: ProjectClock
    @ObservationIgnored private let autosaveDelay: Duration?
    @ObservationIgnored private let onSaved: @MainActor () async -> Void
    @ObservationIgnored private var autosaveTask: Task<Void, Never>?
    /// Set when the project was deleted: nothing may write it again.
    public private(set) var isDiscarded = false

    public nonisolated var id: UUID { projectID }
    @ObservationIgnored private nonisolated let projectID: UUID

    init(project: MMLProject, store: any ProjectStore, core: @escaping @MainActor () -> CoreState, engine: @escaping @MainActor () -> (any MMLCoreEngine)?, clock: ProjectClock, autosaveDelay: Duration?, onSaved: @escaping @MainActor () async -> Void) {
        self.project = project
        projectID = project.id
        self.store = store
        currentCore = core
        currentEngine = engine
        self.clock = clock
        self.autosaveDelay = autosaveDelay
        self.onSaved = onSaved
    }

    // MARK: - Editing

    public var title: String {
        get { project.title }
        set {
            guard newValue != project.title else { return }
            project.title = newValue
            edited()
        }
    }

    public var score: ScoreInput {
        get { project.score }
        set {
            guard newValue != project.score else { return }
            project.score = newValue
            edited()
        }
    }

    /// Largest file accepted by ``importMML(data:)``. A complete six-role
    /// string is at most 40,000 characters; the core refuses anything longer.
    public static let maximumImportBytes = 1 << 20

    /// Replaces the score's MML with the text of an imported file, exactly as
    /// read. Meter, pickup and final bar are left as they are: a text file
    /// does not carry source-confirmed timing.
    public func importMML(data: Data) throws {
        guard data.count <= Self.maximumImportBytes else { throw ImportError.tooLarge(data.count) }
        var bytes = data
        if bytes.starts(with: [0xef, 0xbb, 0xbf]) { bytes.removeFirst(3) }
        guard let text = String(data: bytes, encoding: .utf8) else { throw ImportError.notUTF8 }
        score.mml = text
    }

    public enum ImportError: Error, Equatable, Sendable {
        case tooLarge(Int)
        case notUTF8
    }

    // MARK: - Checking

    /// What the running core reports, or `nil` while it loads or after it failed.
    public var identity: CoreIdentity? { currentCore().identity }

    /// The core, only when it loaded Published Canonical.
    private var engine: (any MMLCoreEngine)? {
        identity?.isCanonicalReady == true ? currentEngine() : nil
    }

    /// Whether a check can run: the core loaded Published Canonical.
    public var canCheck: Bool { engine != nil && !isChecking }

    /// The stored check against the score as it is now and the running core.
    /// `nil` when nothing was checked, or when no core with Published Canonical
    /// is running to compare with: an unloaded core cannot say a result is stale.
    public var freshness: CheckFreshness? {
        guard let identity, identity.isCanonicalReady else { return nil }
        return project.checkFreshness(under: identity.stamp)
    }

    /// Runs the Published Canonical technical check on the current score and
    /// stores the answer. The project is saved with it.
    public func runTechnicalCheck() async {
        guard let engine, let identity, !isChecking else {
            checkError = engine == nil ? "The core has not loaded Published Canonical; checking is unavailable." : nil
            return
        }
        isChecking = true
        defer { isChecking = false }
        let request = project.score.checkRequest
        do {
            let outcome = try await engine.technicalCheck(request)
            project.lastCheck = TechnicalCheckRecord(request: request, engine: identity.stamp, checkedAt: clock.now(), outcome: outcome)
            checkError = nil
            hasUnsavedChanges = true
            await saveReportingErrors()
        } catch {
            checkError = String(describing: error)
        }
    }

    // MARK: - Saving

    /// Writes the project now. Edits made while the write is in flight stay
    /// unsaved and are written by the next save.
    public func save() async throws {
        autosaveTask?.cancel()
        autosaveTask = nil
        guard !isDiscarded else { return }
        let snapshot = project
        try await store.save(snapshot)
        if project == snapshot { hasUnsavedChanges = false }
        saveError = nil
        await onSaved()
    }

    /// Saves pending edits, for closing the project or leaving the App.
    public func close() async {
        if hasUnsavedChanges { await saveReportingErrors() }
        autosaveTask?.cancel()
        autosaveTask = nil
    }

    /// Stops this session from writing its project again, because the project
    /// was deleted. Pending edits are dropped with it.
    func discard() {
        isDiscarded = true
        hasUnsavedChanges = false
        autosaveTask?.cancel()
        autosaveTask = nil
    }

    /// The project file as it is saved, for export.
    public func exportData() throws -> Data {
        try ProjectCoding.encoder().encode(project)
    }

    private func edited() {
        project.updatedAt = clock.now()
        guard !isDiscarded else { return }
        hasUnsavedChanges = true
        guard let autosaveDelay else { return }
        autosaveTask?.cancel()
        autosaveTask = Task { [weak self] in
            try? await Task.sleep(for: autosaveDelay)
            guard !Task.isCancelled else { return }
            await self?.saveReportingErrors()
        }
    }

    private func saveReportingErrors() async {
        do {
            try await save()
        } catch {
            saveError = String(describing: error)
        }
    }
}
