import Foundation
import MMLCore
@testable import MMLCoreJSC
import MMLTestSupport
import XCTest

/// The shared core on a real JavaScriptCore: Apple's framework on iOS and
/// macOS, WebKitGTK's on Linux. The expected answers were computed by the Node
/// server path when the bundle was built; nothing here states a rule.
final class JavaScriptCoreEngineTests: XCTestCase {
    func testTheCoreLoadsThePublishedCanonicalItWasBuiltWith() async throws {
        let conformance = try NativeCoreFixtures.conformance()
        let identity = try await NativeCoreFixtures.engine().identity()
        XCTAssertTrue(identity.isCanonicalReady)
        XCTAssertEqual(identity.apiVersion, 1)
        XCTAssertEqual(identity.coreFormat, "mml-tools/native-core@1")
        XCTAssertEqual(identity.canonical.status, "CANONICAL_LOADED")
        XCTAssertEqual(identity.canonical.canonicalVersion, conformance.canonical["canonical_version"])
        XCTAssertEqual(identity.canonical.canonicalStatus, "PUBLISHED")
        XCTAssertEqual(identity.canonical.manifestVersion, conformance.canonical["manifest_version"])
        XCTAssertEqual(identity.canonical.rulesSnapshotSHA, conformance.canonical["rules_snapshot_sha"])
        XCTAssertEqual(identity.runtimePackageDigest, conformance.runtimePackageDigest)
        XCTAssertEqual(identity.bundle?.sha256, conformance.bundleSHA256)
        XCTAssertEqual(identity.validation.canonicalValidation, "AVAILABLE")
        XCTAssertNotNil(identity.validation.profile)
        XCTAssertNotEqual(identity.validation.profile, identity.validation.legacyProfile, "the legacy profile is never the Canonical one")
        XCTAssertEqual(identity.documents.count, 6)
        XCTAssertTrue(Set(identity.hostShims).isSubset(of: ["TextEncoder", "TextDecoder", "structuredClone"]))
    }

    func testEveryConformanceCaseAnswersAsTheNodeServerPath() async throws {
        let engine = try NativeCoreFixtures.engine()
        let conformance = try NativeCoreFixtures.conformance()
        XCTAssertFalse(conformance.cases.isEmpty)
        for testCase in conformance.cases {
            let envelope = try await engine.rawEnvelope(operation: testCase.operation, input: testCase.request)
            XCTAssertEqual(envelope, testCase.expected, testCase.name)
        }
    }

    func testTheTypedCheckReturnsTheSameAnswer() async throws {
        let engine = try NativeCoreFixtures.engine()
        let typedFields: Set<String> = ["mml", "meter_text", "pickup", "final_partial"]
        var compared = 0
        for testCase in try NativeCoreFixtures.conformance().cases where testCase.operation == "validate" {
            guard case let .object(fields) = testCase.request, Set(fields.keys).isSubset(of: typedFields), let mml = fields["mml"]?.stringValue else { continue }
            let request = TechnicalCheckRequest(mml: mml, meterText: fields["meter_text"]?.stringValue ?? "", pickup: fields["pickup"]?.stringValue, finalPartial: fields["final_partial"]?.stringValue)
            let outcome = try await engine.technicalCheck(request)
            switch outcome {
            case let .report(report):
                XCTAssertEqual(testCase.expected["ok"], .bool(true), testCase.name)
                XCTAssertEqual(report.raw, testCase.expected["result"], testCase.name)
                XCTAssertEqual(report.authority, "PUBLISHED_CANONICAL", testCase.name)
            case let .refused(refusal):
                XCTAssertEqual(testCase.expected["ok"], .bool(false), testCase.name)
                XCTAssertEqual(.string(refusal.code), testCase.expected["error"]?["code"], testCase.name)
            }
            compared += 1
        }
        XCTAssertGreaterThanOrEqual(compared, 8)
    }

    func testChecksFromManyTasksAreSerializedAndIdentical() async throws {
        let engine = try NativeCoreFixtures.engine()
        let request = TechnicalCheckRequest(mml: "MML@t120o4l4cdefgab>c,t120o3l2cegc,,,,;", meterText: "0 4/4")
        let first = try await engine.technicalCheck(request)
        let outcomes = try await withThrowingTaskGroup(of: TechnicalCheckOutcome.self) { group in
            for _ in 0..<8 { group.addTask { try await engine.technicalCheck(request) } }
            return try await group.reduce(into: []) { $0.append($1) }
        }
        XCTAssertEqual(outcomes.count, 8)
        for outcome in outcomes { XCTAssertEqual(outcome, first) }
    }

    func testAPublishedDocumentReadsOffline() async throws {
        let engine = try NativeCoreFixtures.engine()
        let identity = try await engine.identity()
        let document = try await engine.canonicalDocument(path: "docs/MOBILE_SYNTAX.md")
        XCTAssertEqual(document.authority, "CANONICAL_RULE_SOURCE")
        XCTAssertTrue(document.content.contains("Version: \(identity.canonical.canonicalVersion ?? "?")"))
        XCTAssertEqual(document.blobSHA, identity.documents.first { $0.path == document.path }?.blobSHA)
        do {
            _ = try await engine.canonicalDocument(path: "docs/NOT_A_RULE.md")
            XCTFail("an unknown document was answered")
        } catch let refusal as CoreRefusal {
            XCTAssertEqual(refusal.code, "INVALID_REQUEST")
        }
    }

    func testAFullSixRoleScoreChecksInReasonableTime() async throws {
        // Every role at the 2400-character Final limit.
        let bar = "cdefgab>c<"
        let role = "t120o4l16" + String(repeating: bar, count: 239)
        XCTAssertLessThanOrEqual(role.count, 2400)
        let mml = "MML@" + Array(repeating: role, count: 6).joined(separator: ",") + ";"
        let engine = try NativeCoreFixtures.engine()
        let started = Date()
        let outcome = try await engine.technicalCheck(TechnicalCheckRequest(mml: mml, meterText: "0 4/4", finalPartial: nil))
        let seconds = Date().timeIntervalSince(started)
        print("six-role 2400-character technical check: \(String(format: "%.3f", seconds)) s")
        guard case let .report(report) = outcome else { return XCTFail("refused: \(outcome)") }
        XCTAssertEqual(report.tracks.count, 6)
        XCTAssertLessThan(seconds, 30)
    }

    func testABundleThatDoesNotMatchItsManifestIsRefusedBeforeEvaluation() throws {
        let script = try NativeCoreFixtures.scriptData()
        let manifest = try NativeCoreFixtures.manifestData()
        var altered = script
        altered[altered.count - 2] ^= 0x01
        XCTAssertThrowsError(try NativeCoreBundle(scriptData: altered, manifestData: manifest)) { error in
            guard case MMLCoreError.bundleCorrupt = error else { return XCTFail("\(error)") }
        }
        XCTAssertThrowsError(try NativeCoreBundle(scriptData: script + Data([0x20]), manifestData: manifest)) { error in
            guard case MMLCoreError.bundleCorrupt = error else { return XCTFail("\(error)") }
        }
        let newerAPI = try rewriteManifest(manifest) { $0["api_version"] = 2 }
        XCTAssertThrowsError(try NativeCoreBundle(scriptData: script, manifestData: newerAPI)) { error in
            guard case MMLCoreError.incompatibleCore = error else { return XCTFail("\(error)") }
        }
        XCTAssertThrowsError(try NativeCoreBundle.load(from: URL(fileURLWithPath: "/nonexistent-native-core"))) { error in
            guard case MMLCoreError.bundleMissing = error else { return XCTFail("\(error)") }
        }
    }

    func testACoreWhosePackageFailsVerificationRefusesToJudge() async throws {
        // A consistent bundle and manifest whose Canonical package no longer
        // matches the digest it was built with: the core refuses to load the
        // rules, and every check is refused with CANONICAL_NOT_LOADED.
        let conformance = try NativeCoreFixtures.conformance()
        var text = try XCTUnwrap(String(data: NativeCoreFixtures.scriptData(), encoding: .utf8))
        let range = try XCTUnwrap(text.range(of: "Status: PUBLISHED CANONICAL"))
        text.replaceSubrange(range, with: "Status: PUBLISHED CANONICAl")
        let script = Data(text.utf8)
        let manifest = try rewriteManifest(NativeCoreFixtures.manifestData()) { manifest in
            var bundle = manifest["bundle"] as? [String: Any] ?? [:]
            bundle["sha256"] = SHA256.hex(script)
            bundle["bytes"] = script.count
            manifest["bundle"] = bundle
        }
        let engine = try JavaScriptCoreEngine(bundle: NativeCoreBundle(scriptData: script, manifestData: manifest))
        let identity = try await engine.identity()
        XCTAssertEqual(identity.canonical.status, CoreRefusal.canonicalNotLoaded)
        XCTAssertFalse(identity.isCanonicalReady)
        XCTAssertEqual(identity.runtimePackageDigest, conformance.runtimePackageDigest)
        XCTAssertTrue(identity.documents.isEmpty)
        let outcome = try await engine.technicalCheck(TechnicalCheckRequest(mml: "MML@t120o4c1,,,,,;", meterText: "0 4/4"))
        guard case let .refused(refusal) = outcome else { return XCTFail("a check was answered without Canonical: \(outcome)") }
        XCTAssertEqual(refusal.code, CoreRefusal.canonicalNotLoaded)
        XCTAssertEqual(refusal.details["legacy_fallback_allowed"], .bool(false))
    }

    func testSHA256MatchesKnownVectorsAndTheNodeBuild() throws {
        XCTAssertEqual(SHA256.hex(Data()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(SHA256.hex(Data("abc".utf8)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertEqual(SHA256.hex(Data("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq".utf8)), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
        XCTAssertEqual(SHA256.hex(Data(repeating: 0x61, count: 1000)), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3")
        XCTAssertEqual(SHA256.hex(try NativeCoreFixtures.scriptData()), try NativeCoreFixtures.conformance().bundleSHA256)
    }

    private func rewriteManifest(_ data: Data, _ edit: (inout [String: Any]) -> Void) throws -> Data {
        var manifest = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        edit(&manifest)
        return try JSONSerialization.data(withJSONObject: manifest)
    }
}
