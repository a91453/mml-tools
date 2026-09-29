import Foundation
@testable import MMLCore
import XCTest

final class MMLCoreTests: XCTestCase {
    func testJSONValueRoundTripsWithoutLoss() throws {
        let text = #"{"a":[1,2.5,-3,9007199254740993,true,null,"拍號"],"b":{"c":{}},"d":[]}"#
        let value = try JSONValue(jsonData: Data(text.utf8))
        XCTAssertEqual(value["a"], .array([.integer(1), .number(2.5), .integer(-3), .integer(9_007_199_254_740_993), .bool(true), .null, .string("拍號")]))
        XCTAssertEqual(try JSONValue(jsonData: value.jsonData()), value)
        XCTAssertEqual(String(decoding: try value.jsonData(), as: UTF8.self), #"{"a":[1,2.5,-3,9007199254740993,true,null,"拍號"],"b":{"c":{}},"d":[]}"#)
    }

    func testTheRequestUsesTheCoreFieldNamesAndOmitsWhatWasNotStated() throws {
        let request = TechnicalCheckRequest(mml: "MML@t120o4c1,,,,,;", meterText: "0 4/4", pickup: "  ", finalPartial: "")
        XCTAssertNil(request.pickup)
        XCTAssertNil(request.finalPartial)
        let encoded = try JSONValue(jsonData: JSONEncoder().encode(request))
        XCTAssertEqual(encoded, .object(["mml": .string("MML@t120o4c1,,,,,;"), "meter_text": .string("0 4/4")]))
        let stated = TechnicalCheckRequest(mml: "x", meterText: "0 3/4", pickup: "1", finalPartial: "2")
        XCTAssertEqual(try JSONValue(jsonData: JSONEncoder().encode(stated))["final_partial"], .string("2"))
    }

    func testAReportKeepsWhatTheCoreSaidAndReadsTextSummariesAsDiagnostics() throws {
        let raw = try JSONValue(jsonData: Data(#"""
        {"service_version":"native-core-1","legacy_core_version":"0.1.0","profile":"p","authority":"PUBLISHED_CANONICAL",
         "technical_ok":true,"gates":{"strict_mobile_technical":"PASS","in_game_acceptance":"PENDING"},
         "error_count":0,"errors":[],"error_offset":0,"next_error_offset":null,
         "warnings":["2組持續同音重疊，需依角色與來源審核，非自動刪音",{"message":"末小節只有3拍","code":"FINAL_BAR_PARTIAL_UNDECLARED","start":"0","beats":"3"}],
         "tracks":[{"role":"Melody","empty":false,"characters":12,"character_limit":2400,"total_beats":"3","note_events":3,"error_count":0}],
         "total_beats":"3","estimated_seconds":1.5,"tempo_map":[{"beat":"0","bpm":120}],"meter_map":[{"beat":"0","numerator":4,"denominator":4}],
         "bar_count":1,"pair_count":15,"pairs":[],"low_mid_interval_count":0,"max_simultaneous_attacks":1,"changed_input":false,
         "evidence_notice":"n","future_field":{"kept":true}}
        """#.utf8))
        let report = try TechnicalReport(raw: raw)
        XCTAssertEqual(report.technicalOk, true)
        XCTAssertEqual(report.gates["in_game_acceptance"], "PENDING")
        XCTAssertEqual(report.warnings.count, 2)
        XCTAssertEqual(report.warnings[0].message, "2組持續同音重疊，需依角色與來源審核，非自動刪音")
        XCTAssertNil(report.warnings[0].code)
        XCTAssertEqual(report.warnings[1].code, "FINAL_BAR_PARTIAL_UNDECLARED")
        XCTAssertEqual(report.tracks.first?.characterLimit, 2400)
        XCTAssertEqual(report.estimatedSeconds, 1.5)
        XCTAssertEqual(report.raw["future_field"], .object(["kept": .bool(true)]), "a field the App does not read is kept")
    }

    func testAnEngineStampSeparatesAnotherReleaseFromAnotherBuild() {
        let base = EngineStamp(canonicalVersion: "2026-09-23-v3", rulesSnapshotSHA: "ff", manifestVersion: "m1", runtimePackageDigest: "d", profile: "p", serviceVersion: "native-core-1", bundleSHA256: "b1")
        var rebuilt = base
        rebuilt.bundleSHA256 = "b2"
        XCTAssertTrue(base.sameCanonical(as: rebuilt))
        XCTAssertFalse(base.sameEngine(as: rebuilt))
        var republished = base
        republished.rulesSnapshotSHA = "aa"
        XCTAssertFalse(base.sameCanonical(as: republished))
    }

    func testAnIdentityWithoutCanonicalIsNotReady() throws {
        let answer = try JSONValue(jsonData: Data(#"""
        {"api_version":1,"native_core":{"format":"mml-tools/native-core@1","service_version":"native-core-1"},
         "runtime_package_digest":"d","canonical":{"status":"CANONICAL_NOT_LOADED","canonical_version":null,"reason":"CANONICAL_NOT_LOADED: Canonical metadata has no valid rules_snapshot_sha"},
         "service":{"validation_authority":"PUBLISHED_CANONICAL","canonical_validation":"CANONICAL_NOT_LOADED","profile":null,"legacy_core_version":"0.1.0","legacy_profile":"mobile-strict-2026-09-08"},
         "documents":[],"host_shims":["TextEncoder"]}
        """#.utf8))
        let identity = try CoreIdentity(coreAnswer: answer, bundle: nil)
        XCTAssertFalse(identity.isCanonicalReady)
        XCTAssertNil(identity.validation.profile)
        XCTAssertEqual(identity.validation.legacyProfile, "mobile-strict-2026-09-08")
        XCTAssertNil(identity.stamp.bundleSHA256)
    }
}
