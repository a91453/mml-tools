import Foundation

/// A technical report from the shared core, in the shape of the MCP
/// `mml_validate` report.
///
/// This is a read-only view for display. The authoritative value is ``raw``,
/// exactly what the core returned; the typed fields are decoded from it and
/// never re-encoded into it. `technicalOk` is a Strict Mobile technical result
/// under the Published Canonical profile only: the report's own `gates` keep
/// source, listening, player readback and in-game acceptance separate, and the
/// App shows them as the core states them.
public struct TechnicalReport: Sendable, Equatable {
    public let raw: JSONValue

    public let serviceVersion: String
    public let profile: String?
    public let authority: String
    public let technicalOk: Bool?
    public let gates: [String: String]
    public let errorCount: Int
    public let errors: [Diagnostic]
    public let warnings: [Diagnostic]
    public let tracks: [TrackSummary]
    public let totalBeats: String?
    public let estimatedSeconds: Double?
    public let tempoMap: [TempoPoint]
    public let meterMap: [MeterPoint]
    public let barCount: Int
    public let pairCount: Int
    public let lowMidIntervalCount: Int?
    public let maxSimultaneousAttacks: Int?
    public let evidenceNotice: String?

    public init(raw: JSONValue) throws {
        let fields = try raw.decode(Fields.self)
        self.raw = raw
        serviceVersion = fields.service_version
        profile = fields.profile
        authority = fields.authority
        technicalOk = fields.technical_ok
        gates = fields.gates ?? [:]
        errorCount = fields.error_count ?? fields.errors?.count ?? 0
        errors = fields.errors ?? []
        warnings = fields.warnings ?? []
        tracks = fields.tracks ?? []
        totalBeats = fields.total_beats
        estimatedSeconds = fields.estimated_seconds
        tempoMap = fields.tempo_map ?? []
        meterMap = fields.meter_map ?? []
        barCount = fields.bar_count ?? 0
        pairCount = fields.pair_count ?? 0
        lowMidIntervalCount = fields.low_mid_interval_count
        maxSimultaneousAttacks = fields.max_simultaneous_attacks
        evidenceNotice = fields.evidence_notice
    }

    public static func == (lhs: TechnicalReport, rhs: TechnicalReport) -> Bool { lhs.raw == rhs.raw }

    // The wire names, decoded once. Optional wherever the overlap-details
    // report or a future core may omit a field.
    private struct Fields: Decodable {
        let service_version: String
        let profile: String?
        let authority: String
        let technical_ok: Bool?
        let gates: [String: String]?
        let error_count: Int?
        let errors: [Diagnostic]?
        let warnings: [Diagnostic]?
        let tracks: [TrackSummary]?
        let total_beats: String?
        let estimated_seconds: Double?
        let tempo_map: [TempoPoint]?
        let meter_map: [MeterPoint]?
        let bar_count: Int?
        let pair_count: Int?
        let low_mid_interval_count: Int?
        let max_simultaneous_attacks: Int?
        let evidence_notice: String?
    }
}

/// One error or warning. The core reports most as objects with a role, a
/// 1-based character position and a code; review summaries arrive as plain
/// text, and are kept as a message with nothing else.
public struct Diagnostic: Decodable, Sendable, Hashable {
    public let role: String?
    public let position: Int?
    public let code: String?
    public let message: String
    public let start: String?
    public let beats: String?

    public init(from decoder: Decoder) throws {
        if let text = try? decoder.singleValueContainer().decode(String.self) {
            role = nil; position = nil; code = nil; start = nil; beats = nil
            message = text
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        role = try container.decodeIfPresent(String.self, forKey: .role)
        position = try container.decodeIfPresent(Int.self, forKey: .position)
        code = try container.decodeIfPresent(String.self, forKey: .code)
        message = try container.decodeIfPresent(String.self, forKey: .message) ?? ""
        start = try container.decodeIfPresent(String.self, forKey: .start)
        beats = try container.decodeIfPresent(String.self, forKey: .beats)
    }

    enum CodingKeys: String, CodingKey { case role, position, code, message, start, beats }
}

public struct TrackSummary: Decodable, Sendable, Hashable {
    public let role: String
    public let empty: Bool
    public let characters: Int
    public let characterLimit: Int
    public let totalBeats: String
    public let noteEvents: Int
    public let errorCount: Int

    enum CodingKeys: String, CodingKey {
        case role, empty, characters
        case characterLimit = "character_limit"
        case totalBeats = "total_beats"
        case noteEvents = "note_events"
        case errorCount = "error_count"
    }
}

public struct TempoPoint: Decodable, Sendable, Hashable {
    public let beat: String
    public let bpm: Int
}

public struct MeterPoint: Decodable, Sendable, Hashable {
    public let beat: String
    public let numerator: Int
    public let denominator: Int
}
