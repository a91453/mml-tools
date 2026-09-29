import Foundation

/// What a core engine runs, as it reports itself.
///
/// The Canonical fields come from inside the engine: the runtime package it
/// verified before use. The bundle fields come from the host, which checked the
/// bundle bytes against the manifest built beside them. Git provenance in
/// ``CoreBundleDescriptor/audit`` was recorded at build time and is not
/// re-verified on the device; it is shown as audit metadata only.
public struct CoreIdentity: Sendable, Equatable {
    public var apiVersion: Int
    public var coreFormat: String
    public var serviceVersion: String
    public var runtimePackageDigest: String?
    public var canonical: CanonicalRelease
    public var validation: ValidationAvailability
    public var documents: [CanonicalDocumentReference]
    public var hostShims: [String]
    public var bundle: CoreBundleDescriptor?

    /// Published Canonical loaded and the Canonical validator available.
    public var isCanonicalReady: Bool {
        canonical.status == "CANONICAL_LOADED" && validation.canonicalValidation == "AVAILABLE"
    }

    /// The identity a stored result is bound to.
    public var stamp: EngineStamp {
        EngineStamp(
            canonicalVersion: canonical.canonicalVersion,
            rulesSnapshotSHA: canonical.rulesSnapshotSHA,
            manifestVersion: canonical.manifestVersion,
            runtimePackageDigest: runtimePackageDigest,
            profile: validation.profile,
            serviceVersion: serviceVersion,
            bundleSHA256: bundle?.sha256
        )
    }

    /// Decodes the core's `identity` answer.
    public init(coreAnswer answer: JSONValue, bundle: CoreBundleDescriptor?) throws {
        let fields = try answer.decode(Fields.self)
        apiVersion = fields.api_version
        coreFormat = fields.native_core.format
        serviceVersion = fields.native_core.service_version
        runtimePackageDigest = fields.runtime_package_digest
        canonical = fields.canonical
        validation = fields.service
        documents = fields.documents
        hostShims = fields.host_shims
        self.bundle = bundle
    }

    private struct Fields: Decodable {
        struct NativeCore: Decodable { let format: String; let service_version: String }
        let api_version: Int
        let native_core: NativeCore
        let runtime_package_digest: String?
        let canonical: CanonicalRelease
        let service: ValidationAvailability
        let documents: [CanonicalDocumentReference]
        let host_shims: [String]
    }
}

/// The Published Canonical release a core loaded, or why it did not.
public struct CanonicalRelease: Decodable, Sendable, Equatable {
    public var status: String
    public var canonicalVersion: String?
    public var canonicalStatus: String?
    public var manifestVersion: String?
    public var rulesSnapshotSHA: String?
    public var machineDeliverySchema: String?
    public var entryPoint: String?
    public var reason: String?

    enum CodingKeys: String, CodingKey {
        case status, reason
        case canonicalVersion = "canonical_version"
        case canonicalStatus = "canonical_status"
        case manifestVersion = "manifest_version"
        case rulesSnapshotSHA = "rules_snapshot_sha"
        case machineDeliverySchema = "machine_delivery_schema"
        case entryPoint = "entry_point"
    }
}

/// Whether Canonical validation answers, under which profile. The legacy
/// `dist/core.js` identifiers are named as legacy and are never the profile.
public struct ValidationAvailability: Decodable, Sendable, Equatable {
    public var canonicalValidation: String
    public var profile: String?
    public var legacyCoreVersion: String?
    public var legacyProfile: String?

    enum CodingKeys: String, CodingKey {
        case profile
        case canonicalValidation = "canonical_validation"
        case legacyCoreVersion = "legacy_core_version"
        case legacyProfile = "legacy_profile"
    }
}

public struct CanonicalDocumentReference: Decodable, Sendable, Hashable, Identifiable {
    public var path: String
    public var authority: String
    public var blobSHA: String
    public var url: String

    public var id: String { path }

    enum CodingKeys: String, CodingKey {
        case path, authority, url
        case blobSHA = "blob_sha"
    }
}

/// The bundle a host evaluated, as its manifest describes it.
public struct CoreBundleDescriptor: Sendable, Equatable {
    public var sha256: String
    public var bytes: Int
    public var bundler: String
    public var target: String
    public var moduleCount: Int
    public var audit: BuildAudit

    public init(sha256: String, bytes: Int, bundler: String, target: String, moduleCount: Int, audit: BuildAudit) {
        self.sha256 = sha256
        self.bytes = bytes
        self.bundler = bundler
        self.target = target
        self.moduleCount = moduleCount
        self.audit = audit
    }
}

/// Git provenance recorded when the bundle was built. Audit only.
public struct BuildAudit: Decodable, Sendable, Equatable {
    public var manifestCommit: String?
    public var publishedMainHead: String?
    public var repositoryHead: String?
    public var prHead: String?
    public var checkoutIdentity: String?

    public init(manifestCommit: String? = nil, publishedMainHead: String? = nil, repositoryHead: String? = nil, prHead: String? = nil, checkoutIdentity: String? = nil) {
        self.manifestCommit = manifestCommit
        self.publishedMainHead = publishedMainHead
        self.repositoryHead = repositoryHead
        self.prHead = prHead
        self.checkoutIdentity = checkoutIdentity
    }

    enum CodingKeys: String, CodingKey {
        case manifestCommit = "manifest_commit"
        case publishedMainHead = "published_main_head"
        case repositoryHead = "repository_head"
        case prHead = "pr_head"
        case checkoutIdentity = "checkout_identity"
    }
}

/// The engine identity a stored result was produced under.
///
/// A result is only current for the engine that produced it: a different
/// Canonical release, runtime package or profile can judge the same MML
/// differently, and so can a different build of the same release.
public struct EngineStamp: Codable, Sendable, Hashable {
    public var canonicalVersion: String?
    public var rulesSnapshotSHA: String?
    public var manifestVersion: String?
    public var runtimePackageDigest: String?
    public var profile: String?
    public var serviceVersion: String
    public var bundleSHA256: String?

    public init(canonicalVersion: String?, rulesSnapshotSHA: String?, manifestVersion: String?, runtimePackageDigest: String?, profile: String?, serviceVersion: String, bundleSHA256: String?) {
        self.canonicalVersion = canonicalVersion
        self.rulesSnapshotSHA = rulesSnapshotSHA
        self.manifestVersion = manifestVersion
        self.runtimePackageDigest = runtimePackageDigest
        self.profile = profile
        self.serviceVersion = serviceVersion
        self.bundleSHA256 = bundleSHA256
    }

    /// Same Published Canonical release, runtime package and profile.
    public func sameCanonical(as other: EngineStamp) -> Bool {
        canonicalVersion == other.canonicalVersion
            && rulesSnapshotSHA == other.rulesSnapshotSHA
            && manifestVersion == other.manifestVersion
            && runtimePackageDigest == other.runtimePackageDigest
            && profile == other.profile
    }

    /// Same engine build as well.
    public func sameEngine(as other: EngineStamp) -> Bool {
        sameCanonical(as: other) && serviceVersion == other.serviceVersion && bundleSHA256 == other.bundleSHA256
    }

    enum CodingKeys: String, CodingKey {
        case profile
        case canonicalVersion = "canonical_version"
        case rulesSnapshotSHA = "rules_snapshot_sha"
        case manifestVersion = "manifest_version"
        case runtimePackageDigest = "runtime_package_digest"
        case serviceVersion = "service_version"
        case bundleSHA256 = "bundle_sha256"
    }
}
