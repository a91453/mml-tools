import Foundation
import MMLCore
import MMLProjects
import Observation

/// The shared core as the App sees it.
public enum CoreState: Sendable, Equatable {
    case loading
    case ready(CoreIdentity)
    case failed(String)

    public var identity: CoreIdentity? {
        if case let .ready(identity) = self { return identity }
        return nil
    }
}

/// The App's root model: the core it runs and the project library.
///
/// Everything here is local. The core is evaluated on the device and projects
/// are files in the App's container; no step needs a network, Railway or MCP.
@MainActor
@Observable
public final class Workspace {
    public private(set) var coreState: CoreState = .loading
    public private(set) var projects: [ProjectSummary] = []
    public private(set) var unreadableProjects: [UnreadableProject] = []
    public private(set) var libraryError: String?

    @ObservationIgnored public let store: any ProjectStore
    @ObservationIgnored let clock: ProjectClock
    @ObservationIgnored let autosaveDelay: Duration?
    @ObservationIgnored private var engine: (any MMLCoreEngine)?
    // The one live session of each open project. Opening a project that still
    // has one returns it, so two sessions never hold diverging copies (a late
    // check from an earlier session would otherwise write an older score over
    // newer edits), and deleting a project can stop it from writing the
    // project back. Weak: a session closes by going away.
    @ObservationIgnored private var openSessions: [UUID: WeakSession] = [:]
    @ObservationIgnored private var coreStart: Task<Void, Never>?

    /// `autosaveDelay` is how long after an edit a session saves by itself;
    /// `nil` leaves saving to explicit calls.
    public init(store: any ProjectStore, clock: ProjectClock = .system, autosaveDelay: Duration? = .seconds(1)) {
        self.store = store
        self.clock = clock
        self.autosaveDelay = autosaveDelay
    }

    /// Starts the core off the main actor and records what it runs. A core
    /// that fails to start leaves the library usable: projects still open,
    /// edit and save, and only checking waits for a working core.
    ///
    /// The core starts once. A later call (another window's scene, for
    /// example) waits for that start instead of building a second core; only
    /// a start that failed is attempted again.
    public func startCore(_ makeEngine: @escaping @Sendable () throws -> any MMLCoreEngine) async {
        if let coreStart {
            await coreStart.value
            guard case .failed = coreState else { return }
        }
        let start = Task { await self.loadCore(makeEngine) }
        coreStart = start
        await start.value
    }

    private func loadCore(_ makeEngine: @escaping @Sendable () throws -> any MMLCoreEngine) async {
        coreState = .loading
        do {
            let engine = try await Task.detached(priority: .userInitiated) { try makeEngine() }.value
            let identity = try await engine.identity()
            self.engine = engine
            coreState = .ready(identity)
        } catch {
            engine = nil
            coreState = .failed(String(describing: error))
        }
    }

    public func refreshLibrary() async {
        do {
            let listing = try await store.list()
            projects = listing.projects
            unreadableProjects = listing.unreadable
            libraryError = nil
        } catch {
            libraryError = String(describing: error)
        }
    }

    /// Creates and saves an empty project. Nothing is filled in for the user:
    /// in particular no meter, which must come from the source.
    public func createProject(title: String) async throws -> ProjectSession {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let project = MMLProject(title: trimmed.isEmpty ? "未命名專案" : trimmed, createdAt: clock.now())
        try await store.save(project)
        await refreshLibrary()
        return makeSession(project)
    }

    /// The project's live session if it has one, otherwise a new session over
    /// the project as saved.
    public func openProject(id: UUID) async throws -> ProjectSession {
        if let open = liveSession(for: id) { return open }
        let project = try await store.load(id: id)
        return liveSession(for: id) ?? makeSession(project)
    }

    /// Deletes a project. Any session still open on it is discarded first, so
    /// neither its autosave nor its close can write the project back.
    public func deleteProject(id: UUID) async throws {
        openSessions.removeValue(forKey: id)?.session?.discard()
        try await store.delete(id: id)
        await refreshLibrary()
    }

    /// A published Canonical document from the running core, for reading the
    /// rules offline.
    public func canonicalDocument(path: String) async throws -> CanonicalDocument {
        guard let engine else { throw MMLCoreError.bundleMissing("the core is not running") }
        return try await engine.canonicalDocument(path: path)
    }

    private func makeSession(_ project: MMLProject) -> ProjectSession {
        let session = ProjectSession(
            project: project,
            store: store,
            core: { [weak self] in self?.coreState ?? .loading },
            engine: { [weak self] in self?.engine },
            clock: clock,
            autosaveDelay: autosaveDelay
        ) { [weak self] in
            await self?.refreshLibrary()
        }
        openSessions = openSessions.filter { $0.value.session != nil }
        openSessions[project.id] = WeakSession(session)
        return session
    }

    private func liveSession(for id: UUID) -> ProjectSession? {
        guard let session = openSessions[id]?.session, !session.isDiscarded else { return nil }
        return session
    }
}

@MainActor
private final class WeakSession {
    weak var session: ProjectSession?
    init(_ session: ProjectSession) { self.session = session }
}
