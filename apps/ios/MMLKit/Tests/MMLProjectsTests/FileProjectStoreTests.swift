import Foundation
import MMLCore
@testable import MMLProjects
import XCTest

final class FileProjectStoreTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("mmlkit-store-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private let stamp = EngineStamp(canonicalVersion: "2026-09-23-v3", rulesSnapshotSHA: "ff1a9df0", manifestVersion: "2026-09-23-v3-manifest1", runtimePackageDigest: "8f01", profile: "p", serviceVersion: "native-core-1", bundleSHA256: "b1")

    private func checkedProject(clock: ProjectClock = .system) throws -> MMLProject {
        var project = MMLProject(title: "千本櫻", createdAt: clock.now(), score: ScoreInput(mml: "MML@t120o4c1,,,,,;", meterText: "0 4/4", pickup: "", finalPartial: ""))
        let raw = try JSONValue(jsonData: Data(#"{"service_version":"native-core-1","authority":"PUBLISHED_CANONICAL","profile":"p","technical_ok":false,"errors":[{"role":"Melody","position":1,"message":"T256超出32–255","code":"TEMPO_OUT_OF_RANGE"}],"warnings":["x"]}"#.utf8))
        project.lastCheck = TechnicalCheckRecord(request: project.score.checkRequest, engine: stamp, checkedAt: clock.now(), outcome: .report(try TechnicalReport(raw: raw)))
        return project
    }

    func testAProjectReadsBackExactlyAsItWasSaved() async throws {
        let store = FileProjectStore(root: root)
        let project = try checkedProject()
        try await store.save(project)
        let loaded = try await store.load(id: project.id)
        XCTAssertEqual(loaded, project)
        XCTAssertEqual(loaded.lastCheck?.outcome, project.lastCheck?.outcome)
        // Saving what was read changes nothing on disk.
        let file = root.appendingPathComponent("\(project.id.uuidString).mmlproj/project.json")
        let first = try Data(contentsOf: file)
        try await store.save(loaded)
        XCTAssertEqual(try Data(contentsOf: file), first)
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: file.deletingLastPathComponent().path)
        XCTAssertEqual(leftovers, ["project.json"], "an atomic write leaves no temporary file")
    }

    func testTheFileIsVersionedAndReadable() async throws {
        let store = FileProjectStore(root: root)
        let project = try checkedProject()
        try await store.save(project)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: store.packageURL(for: project.id).appendingPathComponent("project.json"))) as? [String: Any])
        XCTAssertEqual(json["format"] as? String, "tw.mml-tools.app.project")
        XCTAssertEqual(json["schema_version"] as? Int, 1)
        XCTAssertEqual((json["score"] as? [String: Any])?["meter_text"] as? String, "0 4/4")
        let lastCheck = try XCTUnwrap(json["last_check"] as? [String: Any])
        XCTAssertEqual((lastCheck["outcome"] as? [String: Any])?["kind"] as? String, "report")
        XCTAssertEqual((lastCheck["engine"] as? [String: Any])?["rules_snapshot_sha"] as? String, "ff1a9df0")
    }

    func testTimestampsRoundTripAtMillisecondPrecision() throws {
        for seconds in [0, 1.2345, 1_790_000_000.9996, -1.0005, 1_234_567_890.5] as [Double] {
            let date = ProjectClock.millisecondPrecision(Date(timeIntervalSince1970: seconds))
            let text = ProjectCoding.timestamp(date)
            XCTAssertTrue(text.range(of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"#, options: .regularExpression) != nil, text)
            XCTAssertEqual(ProjectCoding.date(timestamp: text), date, text)
        }
        XCTAssertEqual(ProjectCoding.timestamp(Date(timeIntervalSince1970: 1.5)), "1970-01-01T00:00:01.500Z")
        XCTAssertNil(ProjectCoding.date(timestamp: "1970-01-01T00:00:01.5+08:00"))
    }

    func testANewerSchemaOrAnotherFormatIsRefusedNotRewritten() async throws {
        let store = FileProjectStore(root: root)
        let project = try checkedProject()
        try await store.save(project)
        let file = store.packageURL(for: project.id).appendingPathComponent("project.json")
        try rewrite(file) { $0["schema_version"] = 2 }
        do {
            _ = try await store.load(id: project.id)
            XCTFail("a newer schema was read")
        } catch let ProjectStoreError.unreadable(id, reason) {
            XCTAssertEqual(id, project.id)
            XCTAssertTrue(reason.contains("newerSchema"), reason)
        }
        let listing = try await store.list()
        XCTAssertTrue(listing.projects.isEmpty)
        XCTAssertEqual(listing.unreadable.count, 1, "an unreadable project stays visible")
        try rewrite(file) { $0["schema_version"] = 1; $0["format"] = "something.else" }
        await XCTAssertThrowsErrorAsync(try await store.load(id: project.id))
    }

    private func rewrite(_ file: URL, _ edit: (inout [String: Any]) -> Void) throws {
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        edit(&json)
        try JSONSerialization.data(withJSONObject: json).write(to: file, options: .atomic)
    }

    func testAFileMovedIntoAnotherProjectsPackageIsRefused() async throws {
        let store = FileProjectStore(root: root)
        let project = try checkedProject()
        try await store.save(project)
        let other = UUID()
        try FileManager.default.createDirectory(at: store.packageURL(for: other), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: store.packageURL(for: project.id).appendingPathComponent("project.json"), to: store.packageURL(for: other).appendingPathComponent("project.json"))
        await XCTAssertThrowsErrorAsync(try await store.load(id: other))
        let listing = try await store.list()
        XCTAssertEqual(listing.projects.map(\.id), [project.id])
        XCTAssertEqual(listing.unreadable.count, 1)
    }

    func testTheLibraryListsNewestFirstAndDeletes() async throws {
        let store = FileProjectStore(root: root)
        let times = [Date(timeIntervalSince1970: 100), Date(timeIntervalSince1970: 300), Date(timeIntervalSince1970: 200)]
        var ids: [UUID] = []
        for (index, time) in times.enumerated() {
            let project = MMLProject(title: "p\(index)", createdAt: time)
            ids.append(project.id)
            try await store.save(project)
        }
        let listing = try await store.list()
        XCTAssertEqual(listing.projects.map(\.title), ["p1", "p2", "p0"])
        XCTAssertEqual(listing.projects.map(\.lastCheck), [.none, .none, .none])
        try await store.delete(id: ids[1])
        let afterDelete = try await store.list()
        XCTAssertEqual(afterDelete.projects.map(\.title), ["p2", "p0"])
        await XCTAssertThrowsErrorAsync(try await store.delete(id: ids[1]))
        await XCTAssertThrowsErrorAsync(try await store.load(id: UUID()))
        let empty = try await FileProjectStore(root: root.appendingPathComponent("missing")).list()
        XCTAssertEqual(empty, ProjectListing())
    }

    func testAStoredCheckIsCurrentOnlyForTheSameRequestAndEngine() throws {
        var project = try checkedProject()
        XCTAssertEqual(project.checkFreshness(under: stamp), .current)
        var rebuilt = stamp
        rebuilt.bundleSHA256 = "b2"
        XCTAssertEqual(project.checkFreshness(under: rebuilt), .stale([.engineChanged]))
        var republished = stamp
        republished.canonicalVersion = "2026-10-01-v4"
        XCTAssertEqual(project.checkFreshness(under: republished), .stale([.canonicalChanged]))
        project.score.meterText = "0 3/4"
        XCTAssertEqual(project.checkFreshness(under: stamp), .stale([.inputChanged]))
        project.score.meterText = "0 4/4"
        project.score.pickup = " "
        XCTAssertEqual(project.checkFreshness(under: stamp), .current, "a blank pickup is not a stated pickup")
        project.title = "renamed"
        XCTAssertEqual(project.checkFreshness(under: stamp), .current, "the title is not part of the check")
        XCTAssertNil(MMLProject(title: "new", createdAt: Date()).checkFreshness(under: stamp))
    }

    func testARefusalIsStoredAsTheCoreGaveIt() async throws {
        let store = FileProjectStore(root: root)
        var project = MMLProject(title: "no meter", createdAt: ProjectClock.system.now(), score: ScoreInput(mml: "MML@t120o4c1,,,,,;"))
        let refusal = CoreRefusal(code: "INVALID_REQUEST", message: "meter_text must be a string of 1–2048 characters", details: .object([:]))
        project.lastCheck = TechnicalCheckRecord(request: project.score.checkRequest, engine: stamp, checkedAt: ProjectClock.system.now(), outcome: .refused(refusal))
        try await store.save(project)
        let loaded = try await store.load(id: project.id)
        XCTAssertEqual(loaded.lastCheck?.outcome, .refused(refusal))
        let listed = try await store.list()
        XCTAssertEqual(listed.projects.first?.lastCheck, .refused(code: "INVALID_REQUEST"))
    }
}

func XCTAssertThrowsErrorAsync<T>(_ expression: @autoclosure () async throws -> T, file: StaticString = #filePath, line: UInt = #line) async {
    do {
        _ = try await expression()
        XCTFail("expected an error", file: file, line: line)
    } catch {}
}
