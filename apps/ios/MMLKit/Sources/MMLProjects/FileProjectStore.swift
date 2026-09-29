import Foundation
import MMLCore

/// Projects as directory packages on the device: `<root>/<id>.mmlproj/project.json`.
///
/// Local only. Every write replaces the whole file atomically, so a crash or a
/// full disk leaves the previous version, never half of one. Nothing here
/// touches the network; exporting or sharing a project is an explicit user
/// action in the App.
public actor FileProjectStore: ProjectStore {
    public static let packageExtension = "mmlproj"
    public static let projectFileName = "project.json"

    public nonisolated let root: URL

    public init(root: URL) {
        self.root = root
    }

    /// The App's library: `Application Support/Projects`, private to the App
    /// and included in device backups.
    public static func applicationSupport(fileManager: FileManager = .default) throws -> FileProjectStore {
        let support = try fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return FileProjectStore(root: support.appendingPathComponent("Projects", isDirectory: true))
    }

    public func list() async throws -> ProjectListing {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: root.path) else { return ProjectListing() }
        let entries = try fileManager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
        var listing = ProjectListing()
        for package in entries where package.pathExtension == Self.packageExtension {
            guard let id = UUID(uuidString: package.deletingPathExtension().lastPathComponent) else {
                listing.unreadable.append(UnreadableProject(location: package, reason: "the package name is not a project id"))
                continue
            }
            do {
                listing.projects.append(ProjectSummary(try read(id: id)))
            } catch {
                listing.unreadable.append(UnreadableProject(location: package, reason: String(describing: error)))
            }
        }
        listing.projects.sort { ($0.updatedAt, $0.id.uuidString) > ($1.updatedAt, $1.id.uuidString) }
        listing.unreadable.sort { $0.location.path < $1.location.path }
        return listing
    }

    public func load(id: UUID) async throws -> MMLProject {
        try read(id: id)
    }

    public func save(_ project: MMLProject) async throws {
        let package = packageURL(for: project.id)
        try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
        let data = try ProjectCoding.encoder().encode(project)
        try data.write(to: package.appendingPathComponent(Self.projectFileName), options: .atomic)
    }

    public func delete(id: UUID) async throws {
        let package = packageURL(for: id)
        guard FileManager.default.fileExists(atPath: package.path) else { throw ProjectStoreError.notFound(id) }
        try FileManager.default.removeItem(at: package)
    }

    nonisolated func packageURL(for id: UUID) -> URL {
        root.appendingPathComponent("\(id.uuidString).\(Self.packageExtension)", isDirectory: true)
    }

    private func read(id: UUID) throws -> MMLProject {
        let file = packageURL(for: id).appendingPathComponent(Self.projectFileName)
        guard FileManager.default.fileExists(atPath: file.path) else { throw ProjectStoreError.notFound(id) }
        let project: MMLProject
        do {
            project = try ProjectCoding.decoder().decode(MMLProject.self, from: Data(contentsOf: file))
        } catch {
            throw ProjectStoreError.unreadable(id, String(describing: error))
        }
        guard project.id == id else { throw ProjectStoreError.unreadable(id, "the file belongs to project \(project.id)") }
        return project
    }
}

/// The JSON form of a project, shared by the store and export.
public enum ProjectCoding {
    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(timestamp(date))
        }
        return encoder
    }

    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            guard let date = date(timestamp: text) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not a UTC ISO 8601 timestamp: \(text)")
            }
            return date
        }
        return decoder
    }

    // UTC ISO 8601 with exactly three fractional digits, through integer
    // milliseconds in both directions: a formatter's own fractional handling
    // may truncate where the clock rounded, and the round trip must be exact.
    static func timestamp(_ date: Date) -> String {
        let milliseconds = Int64((date.timeIntervalSince1970 * 1000).rounded())
        let seconds = milliseconds >= 0 ? milliseconds / 1000 : (milliseconds - 999) / 1000
        let base = wholeSecondFormatter().string(from: Date(timeIntervalSince1970: Double(seconds)))
        return "\(base.dropLast()).\(String(format: "%03lld", milliseconds - seconds * 1000))Z"
    }

    static func date(timestamp text: String) -> Date? {
        guard text.hasSuffix("Z") else { return nil }
        let body = text.dropLast()
        let parts = body.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count <= 2 else { return nil }
        guard let whole = wholeSecondFormatter().date(from: "\(parts[0])Z") else { return nil }
        var milliseconds = Int64(whole.timeIntervalSince1970.rounded()) * 1000
        if parts.count == 2 {
            let fraction = parts[1]
            guard (1...9).contains(fraction.count), fraction.allSatisfy(\.isASCII), let value = Int64(fraction) else { return nil }
            let scale = pow(10.0, Double(fraction.count - 3))
            milliseconds += Int64((Double(value) / scale).rounded())
        }
        return Date(timeIntervalSince1970: Double(milliseconds) / 1000)
    }

    private static func wholeSecondFormatter() -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }
}

/// Time for project records, at the millisecond precision they are stored
/// with, so a project reads back equal to the one that was saved.
public struct ProjectClock: Sendable {
    private let source: @Sendable () -> Date

    public init(_ source: @escaping @Sendable () -> Date) {
        self.source = source
    }

    public static let system = ProjectClock { Date() }

    public func now() -> Date {
        Self.millisecondPrecision(source())
    }

    public static func millisecondPrecision(_ date: Date) -> Date {
        Date(timeIntervalSince1970: (date.timeIntervalSince1970 * 1000).rounded() / 1000)
    }
}
