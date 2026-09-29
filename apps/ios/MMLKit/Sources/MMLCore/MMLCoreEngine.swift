import Foundation

/// The App's boundary to the shared MML core.
///
/// Every MML meaning the App shows comes through this protocol: parsing,
/// validation, Canonical identity. The App never interprets MML itself, so it
/// cannot grow a second set of rules. The production engine
/// (`MMLCoreJSC.JavaScriptCoreEngine`) runs the repository's shared engines
/// on the device; a future engine (another runtime, or an explicit remote
/// service for server-only work) plugs in here without touching the App.
public protocol MMLCoreEngine: Sendable {
    /// What this engine runs: the Published Canonical release, validation
    /// availability, the runtime package and bundle it was built from.
    func identity() async throws -> CoreIdentity

    /// The Published Canonical technical check (the MCP `mml_validate`
    /// operation). A refusal is an answer, not an error; `throws` is kept for
    /// host faults.
    func technicalCheck(_ request: TechnicalCheckRequest) async throws -> TechnicalCheckOutcome

    /// One published Canonical document carried by the engine.
    func canonicalDocument(path: String) async throws -> CanonicalDocument
}

/// A technical-check request, in the shared core's field names.
///
/// `meterText` is the source-confirmed meter map ("0 4/4", one "beat meter"
/// per line). The core refuses to assume one, and so does the App. Optional
/// fields are omitted from the request when blank, exactly as a caller that
/// never set them.
public struct TechnicalCheckRequest: Codable, Sendable, Hashable {
    public var mml: String
    public var meterText: String
    public var pickup: String?
    public var finalPartial: String?

    public init(mml: String, meterText: String, pickup: String? = nil, finalPartial: String? = nil) {
        self.mml = mml
        self.meterText = meterText
        self.pickup = Self.presence(pickup)
        self.finalPartial = Self.presence(finalPartial)
    }

    private static func presence(_ value: String?) -> String? {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return value
    }

    enum CodingKeys: String, CodingKey {
        case mml
        case meterText = "meter_text"
        case pickup
        case finalPartial = "final_partial"
    }
}

/// What the core answered to a technical check.
public enum TechnicalCheckOutcome: Sendable, Equatable {
    /// A report under the Published Canonical profile, PASS or FAIL.
    case report(TechnicalReport)
    /// The core declined to judge the request, with its reason: a malformed
    /// request, or `CANONICAL_NOT_LOADED` when the rules are unavailable.
    case refused(CoreRefusal)
}

/// A structured refusal from the shared core (`{ code, message, details }`).
public struct CoreRefusal: Codable, Sendable, Hashable, Error {
    public var code: String
    public var message: String
    public var details: JSONValue

    public init(code: String, message: String, details: JSONValue = .object([:])) {
        self.code = code
        self.message = message
        self.details = details
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        code = try container.decode(String.self, forKey: .code)
        message = try container.decodeIfPresent(String.self, forKey: .message) ?? ""
        details = try container.decodeIfPresent(JSONValue.self, forKey: .details) ?? .object([:])
    }

    enum CodingKeys: String, CodingKey { case code, message, details }

    public static let canonicalNotLoaded = "CANONICAL_NOT_LOADED"
}

/// One published document the core carries (read offline).
public struct CanonicalDocument: Codable, Sendable, Hashable {
    public var path: String
    public var authority: String
    public var blobSHA: String
    public var url: String
    public var content: String

    enum CodingKeys: String, CodingKey {
        case path, authority, url, content
        case blobSHA = "blob_sha"
    }
}

/// Faults of the host running the core. None of them is a verdict about MML.
public enum MMLCoreError: Error, Sendable, Equatable, CustomStringConvertible {
    case bundleMissing(String)
    case bundleCorrupt(String)
    case incompatibleCore(String)
    case javaScriptException(String)
    case hostFault(code: String, message: String)
    case malformedResponse(String)

    public var description: String {
        switch self {
        case let .bundleMissing(detail): return "Native core bundle missing: \(detail)"
        case let .bundleCorrupt(detail): return "Native core bundle does not match its manifest: \(detail)"
        case let .incompatibleCore(detail): return "Native core is incompatible with this App: \(detail)"
        case let .javaScriptException(detail): return "Native core raised: \(detail)"
        case let .hostFault(code, message): return "Native core host fault \(code): \(message)"
        case let .malformedResponse(detail): return "Native core answered in an unexpected shape: \(detail)"
        }
    }
}
