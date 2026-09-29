import Foundation
import MMLCore
import MMLCoreJSC
import MMLProjects
import MMLTestSupport
@testable import MMLWorkspace
import XCTest

/// Stage 1's end-to-end flow on the real shared core, with no network:
/// create → enter MML → check → save → close → relaunch → reopen → same data
/// and the same result.
///
/// Workspace and ProjectSession are main-actor isolated. Test bodies hop onto
/// the main actor through `onMainActor` instead of isolating the XCTestCase
/// subclass, which Swift 6.0's test discovery on Linux rejects (the same
/// pattern as a91453/railway-game-ios's GameSession tests).
final class VerticalSliceTests: XCTestCase {
    private var root: URL!

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("mmlkit-slice-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testCreateCheckSaveCloseReopenGivesTheSameProjectAndResult() async throws {
        let root = try XCTUnwrap(self.root)
        try await onMainActor {
            let workspace = try await launch(root)
            let identity = try XCTUnwrap(workspace.coreState.identity, "\(workspace.coreState)")
            XCTAssertTrue(identity.isCanonicalReady)

            let session = try await workspace.createProject(title: "  練習曲  ")
            XCTAssertEqual(session.title, "練習曲")
            XCTAssertEqual(session.score, ScoreInput(), "nothing is filled in, in particular no meter")
            XCTAssertEqual(workspace.projects.map(\.id), [session.id])

            session.score.meterText = "0 4/4"
            session.score.mml = "MML@t120o4l4cdefgab>c,t120o3l2cegc,,,,;"
            XCTAssertTrue(session.hasUnsavedChanges)
            XCTAssertNil(session.freshness)
            await session.runTechnicalCheck()
            XCTAssertNil(session.checkError)
            XCTAssertFalse(session.hasUnsavedChanges, "a check is saved with the project")
            XCTAssertEqual(session.freshness, .current)
            let record = try XCTUnwrap(session.project.lastCheck)
            guard case let .report(report) = record.outcome else { return XCTFail("\(record.outcome)") }
            XCTAssertEqual(report.technicalOk, true)
            XCTAssertEqual(report.authority, "PUBLISHED_CANONICAL")
            XCTAssertEqual(report.gates["in_game_acceptance"], "PENDING", "a technical PASS accepts nothing else")
            XCTAssertEqual(record.engine, identity.stamp)
            XCTAssertEqual(record.engine.rulesSnapshotSHA, identity.canonical.rulesSnapshotSHA)
            let saved = session.project
            await session.close()

            // A new process: new workspace, new core, same library on disk.
            let relaunched = try await launch(root)
            XCTAssertEqual(relaunched.projects.map(\.id), [saved.id])
            XCTAssertEqual(relaunched.projects.first?.lastCheck, .technicalPass)
            let reopened = try await relaunched.openProject(id: saved.id)
            XCTAssertEqual(reopened.project, saved)
            XCTAssertEqual(reopened.freshness, .current, "the same core recognises its own result")

            // Checking again gives the same answer.
            await reopened.runTechnicalCheck()
            XCTAssertEqual(reopened.project.lastCheck?.outcome, record.outcome)
            XCTAssertEqual(reopened.project.lastCheck?.request, record.request)
        }
    }

    func testAFailingScoreKeepsTheCoreDiagnosticsAndAnEditMakesThemStale() async throws {
        let root = try XCTUnwrap(self.root)
        try await onMainActor {
            let workspace = try await launch(root)
            let session = try await workspace.createProject(title: "tempo")
            session.score = ScoreInput(mml: "MML@t256o4c1,,,,,;", meterText: "0 4/4")
            await session.runTechnicalCheck()
            guard case let .report(report)? = session.project.lastCheck?.outcome else { return XCTFail("no report") }
            XCTAssertEqual(report.technicalOk, false)
            XCTAssertEqual(report.errors.first?.code, "TEMPO_OUT_OF_RANGE")
            XCTAssertEqual(report.errors.first?.role, "Melody")
            XCTAssertEqual(workspace.projects.first?.lastCheck, .technicalFail)

            session.score.mml = "MML@t255o4c1,,,,,;"
            XCTAssertEqual(session.freshness, .stale([.inputChanged]), "the old verdict is not presented as current")
        }
    }

    func testARequestTheCoreRefusesIsStoredAsARefusal() async throws {
        let root = try XCTUnwrap(self.root)
        try await onMainActor {
            let workspace = try await launch(root)
            let session = try await workspace.createProject(title: "no meter")
            session.score.mml = "MML@t120o4c1,,,,,;"
            await session.runTechnicalCheck()
            guard case let .refused(refusal)? = session.project.lastCheck?.outcome else { return XCTFail("\(String(describing: session.project.lastCheck))") }
            XCTAssertEqual(refusal.code, "INVALID_REQUEST")
            XCTAssertEqual(workspace.projects.first?.lastCheck, .refused(code: "INVALID_REQUEST"))
        }
    }

    func testImportReplacesOnlyTheMMLAndRefusesWhatIsNotText() async throws {
        let root = try XCTUnwrap(self.root)
        try await onMainActor {
            let workspace = try await launch(root)
            let session = try await workspace.createProject(title: "import")
            session.score.meterText = "0 3/4"
            try session.importMML(data: Data([0xef, 0xbb, 0xbf]) + Data("MML@t120o4c2.,,,,,;\n".utf8))
            XCTAssertEqual(session.score.mml, "MML@t120o4c2.,,,,,;\n", "imported exactly as read, BOM aside")
            XCTAssertEqual(session.score.meterText, "0 3/4", "a text file carries no source-confirmed meter")
            XCTAssertThrowsError(try session.importMML(data: Data([0xff, 0xfe, 0x41]))) { XCTAssertEqual($0 as? ProjectSession.ImportError, .notUTF8) }
            XCTAssertThrowsError(try session.importMML(data: Data(count: ProjectSession.maximumImportBytes + 1))) { XCTAssertEqual($0 as? ProjectSession.ImportError, .tooLarge(ProjectSession.maximumImportBytes + 1)) }
            await session.runTechnicalCheck()
            guard case let .report(report)? = session.project.lastCheck?.outcome else { return XCTFail("no report") }
            XCTAssertEqual(report.technicalOk, true, "\(report.errors)")
            XCTAssertEqual(report.meterMap.first?.numerator, 3)
        }
    }

    func testWithoutAWorkingCoreProjectsStillOpenEditAndSaveButNothingIsJudged() async throws {
        let root = try XCTUnwrap(self.root)
        try await onMainActor {
            let workspace = Workspace(store: FileProjectStore(root: root), autosaveDelay: nil)
            await workspace.startCore { throw MMLCoreError.bundleMissing("NativeCore/mml-core.js") }
            guard case .failed = workspace.coreState else { return XCTFail("\(workspace.coreState)") }
            let session = try await workspace.createProject(title: "offline")
            session.score = ScoreInput(mml: "MML@t120o4c1,,,,,;", meterText: "0 4/4")
            XCTAssertFalse(session.canCheck)
            await session.runTechnicalCheck()
            XCTAssertNil(session.project.lastCheck, "no verdict without the core")
            XCTAssertNotNil(session.checkError)
            try await session.save()
            let reopened = try await workspace.openProject(id: session.id)
            XCTAssertEqual(reopened.project.score, session.score)
            // A failed start is attempted again, and the open project can then be checked.
            await workspace.startCore { try NativeCoreFixtures.engine() }
            XCTAssertTrue(reopened.canCheck)
        }
    }

    func testALateCheckNeverWritesAnOlderScoreOverNewerEdits() async throws {
        let root = try XCTUnwrap(self.root)
        try await onMainActor {
            let workspace = Workspace(store: FileProjectStore(root: root), autosaveDelay: nil)
            await workspace.startCore { SlowEngine(base: try NativeCoreFixtures.engine(), delay: .milliseconds(300)) }
            let first = try await workspace.createProject(title: "race")
            first.score = ScoreInput(mml: "MML@t120o4c1,,,,,;", meterText: "0 4/4")
            let check = Task { await first.runTechnicalCheck() }
            await first.close()
            // The user moves to another project and back while the check runs.
            let again = try await workspace.openProject(id: first.id)
            XCTAssertTrue(again === first, "one live session per project")
            again.score.mml = "MML@t120o4d1,,,,,;"
            try await again.save()
            await check.value
            let stored = try await FileProjectStore(root: root).load(id: first.id)
            XCTAssertEqual(stored.score.mml, "MML@t120o4d1,,,,,;", "the late check wrote an older score back")
            XCTAssertNotNil(stored.lastCheck)
            XCTAssertEqual(again.freshness, .stale([.inputChanged]), "the result belongs to the score it checked")
        }
    }

    func testAProjectOpenedBeforeTheCoreLoadedIsCheckedOnceItLoads() async throws {
        let root = try XCTUnwrap(self.root)
        try await onMainActor {
            let workspace = Workspace(store: FileProjectStore(root: root), autosaveDelay: nil)
            let session = try await workspace.createProject(title: "early")
            session.score = ScoreInput(mml: "MML@t120o4c1,,,,,;", meterText: "0 4/4")
            XCTAssertFalse(session.canCheck, "no core yet")
            XCTAssertNil(session.freshness)
            await workspace.startCore { try NativeCoreFixtures.engine() }
            XCTAssertTrue(session.canCheck, "the session sees the core that loaded after it opened")
            await session.runTechnicalCheck()
            guard case let .report(report)? = session.project.lastCheck?.outcome else { return XCTFail("no report") }
            XCTAssertEqual(report.technicalOk, true)
            // Another window starting the core keeps the one that is running.
            let identity = workspace.coreState.identity
            await workspace.startCore { throw MMLCoreError.bundleMissing("a second core was built") }
            XCTAssertEqual(workspace.coreState.identity, identity)
        }
    }

    func testDeletingAnOpenProjectIsNotUndoneByItsSessionSaving() async throws {
        let root = try XCTUnwrap(self.root)
        try await onMainActor {
            let workspace = Workspace(store: FileProjectStore(root: root), autosaveDelay: .milliseconds(30))
            let session = try await workspace.createProject(title: "doomed")
            session.score.mml = "MML@t120o4c1,,,,,;"
            XCTAssertTrue(session.hasUnsavedChanges, "an autosave is pending")
            try await workspace.deleteProject(id: session.id)
            XCTAssertTrue(session.isDiscarded)
            await session.close()
            try await session.save()
            session.score.mml = "MML@t120o4d1,,,,,;"
            try await Task.sleep(for: .milliseconds(150))
            let listing = try await FileProjectStore(root: root).list()
            XCTAssertTrue(listing.projects.isEmpty, "the deleted project was written back")
            XCTAssertTrue(listing.unreadable.isEmpty)
        }
    }

    func testAStoredResultIsNotCalledStaleByACoreWithoutCanonical() async throws {
        let root = try XCTUnwrap(self.root)
        try await onMainActor {
            let workspace = try await launch(root)
            let session = try await workspace.createProject(title: "checked")
            session.score = ScoreInput(mml: "MML@t120o4c1,,,,,;", meterText: "0 4/4")
            await session.runTechnicalCheck()
            await session.close()

            // The same library under a core that could not load Published Canonical.
            let degraded = Workspace(store: FileProjectStore(root: root), autosaveDelay: nil)
            await degraded.startCore { try JavaScriptCoreEngine(bundle: NativeCoreFixtures.bundleWithUnverifiableCanonical()) }
            XCTAssertEqual(degraded.coreState.identity?.isCanonicalReady, false)
            let reopened = try await degraded.openProject(id: session.id)
            XCTAssertNotNil(reopened.project.lastCheck, "the stored result is kept")
            XCTAssertNil(reopened.freshness, "a core without Canonical cannot judge whether it is stale")
            XCTAssertFalse(reopened.canCheck)
        }
    }

    func testAutosaveWritesEditsWithoutAnExplicitSave() async throws {
        let root = try XCTUnwrap(self.root)
        try await onMainActor {
            let workspace = Workspace(store: FileProjectStore(root: root), autosaveDelay: .milliseconds(50))
            let session = try await workspace.createProject(title: "autosave")
            session.score.mml = "MML@t120o4c1,,,,,;"
            for _ in 0..<100 where session.hasUnsavedChanges { try await Task.sleep(for: .milliseconds(20)) }
            XCTAssertFalse(session.hasUnsavedChanges)
            let stored = try await FileProjectStore(root: root).load(id: session.id)
            XCTAssertEqual(stored.score.mml, "MML@t120o4c1,,,,,;")
        }
    }

    func testThePublishedRulesReadOfflineThroughTheWorkspace() async throws {
        let root = try XCTUnwrap(self.root)
        try await onMainActor {
            let workspace = try await launch(root)
            let identity = try XCTUnwrap(workspace.coreState.identity)
            for reference in identity.documents {
                let document = try await workspace.canonicalDocument(path: reference.path)
                XCTAssertEqual(document.blobSHA, reference.blobSHA)
                XCTAssertFalse(document.content.isEmpty)
            }
        }
    }

    /// The App's code has no network path: no URL session, socket or web view
    /// in any App source. Rules, core and projects are all local.
    func testNoAppSourceUsesANetworkAPI() throws {
        var apps = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { apps.deleteLastPathComponent() }
        XCTAssertEqual(apps.lastPathComponent, "ios")
        let enumerator = try XCTUnwrap(FileManager.default.enumerator(at: apps, includingPropertiesForKeys: nil))
        let forbidden = ["URLSession", "URLRequest", "NWConnection", "import Network", "WKWebView", "import WebKit", "CFStream", "Socket("]
        var scanned = 0
        for case let file as URL in enumerator where file.pathExtension == "swift" && !file.path.contains("/.build/") && !file.path.contains("/Tests/") {
            let text = try String(contentsOf: file, encoding: .utf8)
            for token in forbidden { XCTAssertFalse(text.contains(token), "\(file.lastPathComponent) uses \(token)") }
            scanned += 1
        }
        XCTAssertGreaterThan(scanned, 10)
    }
}

@MainActor
private func launch(_ root: URL) async throws -> Workspace {
    let workspace = Workspace(store: FileProjectStore(root: root), autosaveDelay: nil)
    await workspace.startCore { try NativeCoreFixtures.engine() }
    await workspace.refreshLibrary()
    return workspace
}

private func onMainActor(_ body: @MainActor @Sendable () async throws -> Void) async throws {
    try await body()
}

/// The real core, answering each check only after `delay`: a check that is
/// still running when the user moves on.
private actor SlowEngine: MMLCoreEngine {
    let base: JavaScriptCoreEngine
    let delay: Duration

    init(base: JavaScriptCoreEngine, delay: Duration) {
        self.base = base
        self.delay = delay
    }

    func identity() async throws -> CoreIdentity { try await base.identity() }

    func technicalCheck(_ request: TechnicalCheckRequest) async throws -> TechnicalCheckOutcome {
        try await Task.sleep(for: delay)
        return try await base.technicalCheck(request)
    }

    func canonicalDocument(path: String) async throws -> CanonicalDocument {
        try await base.canonicalDocument(path: path)
    }
}
