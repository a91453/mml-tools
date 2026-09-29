import Foundation
import MMLCore

/// Where projects live. The App uses ``FileProjectStore``; tests and future
/// stores (a document provider, a sync layer) implement the same contract.
public protocol ProjectStore: Sendable {
    func list() async throws -> ProjectListing
    func load(id: UUID) async throws -> MMLProject
    func save(_ project: MMLProject) async throws
    func delete(id: UUID) async throws
}

/// The library as found on disk. A project that cannot be read is listed as
/// unreadable with its reason instead of disappearing from the library.
public struct ProjectListing: Sendable, Equatable {
    public var projects: [ProjectSummary]
    public var unreadable: [UnreadableProject]

    public init(projects: [ProjectSummary] = [], unreadable: [UnreadableProject] = []) {
        self.projects = projects
        self.unreadable = unreadable
    }
}

public struct ProjectSummary: Sendable, Equatable, Identifiable {
    public var id: UUID
    public var title: String
    public var updatedAt: Date
    public var lastCheck: LastCheckSummary

    public init(_ project: MMLProject) {
        id = project.id
        title = project.title
        updatedAt = project.updatedAt
        lastCheck = LastCheckSummary(project.lastCheck)
    }
}

/// The stored check's verdict, as the core stated it, for the library list.
/// Whether it is still current depends on the running engine and is shown in
/// the project itself.
public enum LastCheckSummary: Sendable, Equatable {
    case none
    case technicalPass
    case technicalFail
    case refused(code: String)

    init(_ record: TechnicalCheckRecord?) {
        switch record?.outcome {
        case nil: self = .none
        case let .report(report)?: self = report.technicalOk == true ? .technicalPass : .technicalFail
        case let .refused(refusal)?: self = .refused(code: refusal.code)
        }
    }
}

public struct UnreadableProject: Sendable, Equatable, Identifiable {
    public var location: URL
    public var reason: String
    public var id: URL { location }
}

public enum ProjectStoreError: Error, Equatable, Sendable, CustomStringConvertible {
    case notFound(UUID)
    case unreadable(UUID, String)

    public var description: String {
        switch self {
        case let .notFound(id): return "Project \(id) does not exist"
        case let .unreadable(id, reason): return "Project \(id) cannot be read: \(reason)"
        }
    }
}
