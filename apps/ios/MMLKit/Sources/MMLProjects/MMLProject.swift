import Foundation
import MMLCore

/// One App project: a six-role MML score, the source-confirmed timing it is
/// checked under, and the last technical check with the engine that ran it.
///
/// Stage 1 holds one score. The on-disk form is a directory package so later
/// stages can add source files (MIDI, MusicXML, audio) and per-role data
/// beside `project.json` without changing what exists.
public struct MMLProject: Codable, Sendable, Equatable, Identifiable {
    public static let format = "tw.mml-tools.app.project"
    public static let schemaVersion = 1

    public let id: UUID
    public var title: String
    public let createdAt: Date
    public var updatedAt: Date
    public var score: ScoreInput
    public var lastCheck: TechnicalCheckRecord?

    public init(id: UUID = UUID(), title: String, createdAt: Date, score: ScoreInput = ScoreInput(), lastCheck: TechnicalCheckRecord? = nil) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        updatedAt = createdAt
        self.score = score
        self.lastCheck = lastCheck
    }

    enum CodingKeys: String, CodingKey {
        case format
        case schemaVersion = "schema_version"
        case id, title, score
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case lastCheck = "last_check"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let format = try container.decode(String.self, forKey: .format)
        guard format == Self.format else { throw ProjectFormatError.notAProject(format) }
        let schema = try container.decode(Int.self, forKey: .schemaVersion)
        // A newer App wrote this. Reading it with this schema would drop what
        // this App does not know, and saving would destroy it.
        guard schema <= Self.schemaVersion else { throw ProjectFormatError.newerSchema(schema) }
        id = try container.decode(UUID.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
        score = try container.decode(ScoreInput.self, forKey: .score)
        lastCheck = try container.decodeIfPresent(TechnicalCheckRecord.self, forKey: .lastCheck)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.format, forKey: .format)
        try container.encode(Self.schemaVersion, forKey: .schemaVersion)
        try container.encode(id, forKey: .id)
        try container.encode(title, forKey: .title)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
        try container.encode(score, forKey: .score)
        try container.encode(lastCheck, forKey: .lastCheck)
    }

    /// How the stored check relates to the score as it is now, under `engine`.
    public func checkFreshness(under engine: EngineStamp) -> CheckFreshness? {
        lastCheck?.freshness(for: score.checkRequest, under: engine)
    }
}

public enum ProjectFormatError: Error, Equatable, Sendable {
    case notAProject(String)
    case newerSchema(Int)
}

/// The score as the user entered it. Blank optional fields mean "not stated";
/// the App never fills in a meter, pickup or final bar the source did not give.
public struct ScoreInput: Codable, Sendable, Equatable {
    public var mml: String
    /// Source-confirmed meter map, one "beat meter" per line (e.g. "0 4/4").
    public var meterText: String
    public var pickup: String
    public var finalPartial: String

    public init(mml: String = "", meterText: String = "", pickup: String = "", finalPartial: String = "") {
        self.mml = mml
        self.meterText = meterText
        self.pickup = pickup
        self.finalPartial = finalPartial
    }

    public var checkRequest: TechnicalCheckRequest {
        TechnicalCheckRequest(mml: mml, meterText: meterText, pickup: pickup, finalPartial: finalPartial)
    }

    enum CodingKeys: String, CodingKey {
        case mml, pickup
        case meterText = "meter_text"
        case finalPartial = "final_partial"
    }
}

/// A technical check as it was asked and answered, bound to the engine that
/// answered it.
public struct TechnicalCheckRecord: Codable, Sendable, Equatable {
    public var request: TechnicalCheckRequest
    public var engine: EngineStamp
    public var checkedAt: Date
    public var outcome: TechnicalCheckOutcome

    public init(request: TechnicalCheckRequest, engine: EngineStamp, checkedAt: Date, outcome: TechnicalCheckOutcome) {
        self.request = request
        self.engine = engine
        self.checkedAt = checkedAt
        self.outcome = outcome
    }

    /// Current only for the same request under the same engine. Anything else
    /// is shown as stale with its reasons, never silently reused.
    public func freshness(for currentRequest: TechnicalCheckRequest, under currentEngine: EngineStamp) -> CheckFreshness {
        var reasons: Set<StaleReason> = []
        if request != currentRequest { reasons.insert(.inputChanged) }
        if !engine.sameCanonical(as: currentEngine) { reasons.insert(.canonicalChanged) }
        else if !engine.sameEngine(as: currentEngine) { reasons.insert(.engineChanged) }
        return reasons.isEmpty ? .current : .stale(reasons)
    }

    enum CodingKeys: String, CodingKey {
        case request, engine, outcome
        case checkedAt = "checked_at"
    }

    private enum OutcomeKeys: String, CodingKey { case kind, report, refusal }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        request = try container.decode(TechnicalCheckRequest.self, forKey: .request)
        engine = try container.decode(EngineStamp.self, forKey: .engine)
        checkedAt = try container.decode(Date.self, forKey: .checkedAt)
        let outcomeContainer = try container.nestedContainer(keyedBy: OutcomeKeys.self, forKey: .outcome)
        switch try outcomeContainer.decode(String.self, forKey: .kind) {
        case "report":
            outcome = .report(try TechnicalReport(raw: outcomeContainer.decode(JSONValue.self, forKey: .report)))
        case "refused":
            outcome = .refused(try outcomeContainer.decode(CoreRefusal.self, forKey: .refusal))
        case let kind:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: outcomeContainer, debugDescription: "Unknown outcome \(kind)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(request, forKey: .request)
        try container.encode(engine, forKey: .engine)
        try container.encode(checkedAt, forKey: .checkedAt)
        var outcomeContainer = container.nestedContainer(keyedBy: OutcomeKeys.self, forKey: .outcome)
        switch outcome {
        case let .report(report):
            try outcomeContainer.encode("report", forKey: .kind)
            try outcomeContainer.encode(report.raw, forKey: .report)
        case let .refused(refusal):
            try outcomeContainer.encode("refused", forKey: .kind)
            try outcomeContainer.encode(refusal, forKey: .refusal)
        }
    }
}

public enum CheckFreshness: Sendable, Equatable {
    case current
    case stale(Set<StaleReason>)
}

public enum StaleReason: String, Sendable, Hashable, CaseIterable {
    /// The score, meter, pickup or final bar changed since the check.
    case inputChanged
    /// The App now runs another Published Canonical release, runtime package
    /// or validation profile.
    case canonicalChanged
    /// Same release, another build of the core.
    case engineChanged
}
