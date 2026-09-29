import Foundation
import MMLCore
import MMLCoreJSC

/// The built native core and its conformance answers, as
/// `npm run build:native-core` writes them to studio/native-build/.
///
/// Tests fail, rather than skip, when the build is missing: a skipped bridge
/// test would read as a pass. Set MML_NATIVE_CORE_DIR to use another build.
public enum NativeCoreFixtures {
    public static var directory: URL {
        if let override = ProcessInfo.processInfo.environment["MML_NATIVE_CORE_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        // Tests/Support/NativeCoreFixtures.swift -> the repository root.
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { root.deleteLastPathComponent() }
        return root.appendingPathComponent("studio/native-build", isDirectory: true)
    }

    public static func bundle() throws -> NativeCoreBundle {
        do {
            return try NativeCoreBundle.load(from: directory)
        } catch MMLCoreError.bundleMissing(let path) {
            throw FixtureError("The native core is not built (\(path)). Run `npm ci --ignore-scripts && npm run build:native-core` at the repository root first.")
        }
    }

    public static func engine() throws -> JavaScriptCoreEngine {
        try JavaScriptCoreEngine(bundle: bundle())
    }

    public static func scriptData() throws -> Data {
        try Data(contentsOf: directory.appendingPathComponent(NativeCoreBundle.scriptFileName))
    }

    public static func manifestData() throws -> Data {
        try Data(contentsOf: directory.appendingPathComponent(NativeCoreBundle.manifestFileName))
    }

    public static func conformance() throws -> Conformance {
        let data = try Data(contentsOf: directory.appendingPathComponent("conformance.json"))
        return try JSONDecoder().decode(Conformance.self, from: data)
    }

    public struct Conformance: Decodable, Sendable {
        public let format: String
        public let canonical: [String: String]
        public let runtimePackageDigest: String
        public let bundleSHA256: String
        public let cases: [Case]

        public struct Case: Decodable, Sendable {
            public let name: String
            public let operation: String
            public let request: JSONValue
            public let expected: JSONValue
        }

        enum CodingKeys: String, CodingKey {
            case format, canonical, cases
            case runtimePackageDigest = "runtime_package_digest"
            case bundleSHA256 = "bundle_sha256"
        }
    }

    public struct FixtureError: Error, CustomStringConvertible {
        public let description: String
        init(_ description: String) { self.description = description }
    }
}
