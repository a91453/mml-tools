import Foundation
import MMLCore

/// The built shared core: `mml-core.js` and the manifest built beside it
/// (`npm run build:native-core`, studio/native-build/).
///
/// Loading checks that the two belong together (format, API version, byte
/// count and SHA-256) before any script is evaluated. A mismatch is refused;
/// nothing falls back to another copy of the core.
public struct NativeCoreBundle: Sendable {
    public static let scriptFileName = "mml-core.js"
    public static let manifestFileName = "mml-core.json"
    public static let manifestFormat = "mml-tools/native-core-manifest@1"
    public static let supportedAPIVersion = 1

    public let script: String
    public let descriptor: CoreBundleDescriptor
    /// The runtime package digest the manifest says the bundle carries. The
    /// engine requires the running core to report the same one.
    public let expectedRuntimePackageDigest: String
    public let expectedCanonicalVersion: String?

    /// The lowercase hex SHA-256 a manifest records for a bundle.
    public static func digest(of data: Data) -> String {
        SHA256.hex(data)
    }

    /// Loads the bundle from a directory holding both files.
    public static func load(from directory: URL) throws -> NativeCoreBundle {
        let scriptURL = directory.appendingPathComponent(scriptFileName)
        let manifestURL = directory.appendingPathComponent(manifestFileName)
        guard let scriptData = try? Data(contentsOf: scriptURL) else { throw MMLCoreError.bundleMissing(scriptURL.path) }
        guard let manifestData = try? Data(contentsOf: manifestURL) else { throw MMLCoreError.bundleMissing(manifestURL.path) }
        return try NativeCoreBundle(scriptData: scriptData, manifestData: manifestData)
    }

    public init(scriptData: Data, manifestData: Data) throws {
        let manifest: Manifest
        do {
            manifest = try JSONDecoder().decode(Manifest.self, from: manifestData)
        } catch {
            throw MMLCoreError.bundleCorrupt("manifest is not readable: \(error)")
        }
        guard manifest.format == Self.manifestFormat else {
            throw MMLCoreError.incompatibleCore("manifest format \(manifest.format), expected \(Self.manifestFormat)")
        }
        guard manifest.api_version == Self.supportedAPIVersion else {
            throw MMLCoreError.incompatibleCore("core API version \(manifest.api_version), this App supports \(Self.supportedAPIVersion)")
        }
        guard scriptData.count == manifest.bundle.bytes else {
            throw MMLCoreError.bundleCorrupt("\(scriptData.count) bytes, manifest says \(manifest.bundle.bytes)")
        }
        let digest = SHA256.hex(scriptData)
        guard digest == manifest.bundle.sha256 else {
            throw MMLCoreError.bundleCorrupt("SHA-256 \(digest), manifest says \(manifest.bundle.sha256)")
        }
        guard let script = String(data: scriptData, encoding: .utf8) else {
            throw MMLCoreError.bundleCorrupt("script is not UTF-8")
        }
        self.script = script
        expectedRuntimePackageDigest = manifest.release.runtime_package_digest
        expectedCanonicalVersion = manifest.release.canonical["canonical_version"]
        descriptor = CoreBundleDescriptor(
            sha256: digest,
            bytes: scriptData.count,
            bundler: manifest.toolchain.bundler,
            target: manifest.toolchain.target,
            moduleCount: manifest.modules.count,
            audit: manifest.audit
        )
    }

    private struct Manifest: Decodable {
        struct Bundle: Decodable { let path: String; let sha256: String; let bytes: Int }
        struct Release: Decodable { let canonical: [String: String]; let runtime_package_digest: String }
        struct Toolchain: Decodable { let bundler: String; let format: String; let target: String }
        let format: String
        let api_version: Int
        let bundle: Bundle
        let release: Release
        let toolchain: Toolchain
        let modules: [JSONValue]
        let audit: BuildAudit
    }
}
