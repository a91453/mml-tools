#if canImport(JavaScriptCore)
import JavaScriptCore
#else
import CJavaScriptCore
#endif
import Foundation
import MMLCore

/// The shared MML core, running on the device in JavaScriptCore.
///
/// It evaluates the bundle built from the repository's shared engines
/// (studio/native, `npm run build:native-core`) and calls its facade, which
/// composes the same technical service and Published Canonical gate the MCP
/// tools use. The App therefore gets the MCP `mml_validate` answer without a
/// network, a server or a second implementation.
///
/// An actor: JavaScriptCore contexts are not used concurrently, and every call
/// runs off the main thread.
public actor JavaScriptCoreEngine: MMLCoreEngine {
    private let runtime: JavaScriptRuntime
    // Protected from collection by the runtime for its whole life.
    private let core: JSObjectRef
    private let submit: JSObjectRef
    private let collect: JSObjectRef
    private let cachedIdentity: CoreIdentity

    /// Evaluates the bundle and checks that the running core is the one the
    /// manifest describes. Throws before any MML is judged if it is not.
    public init(bundle: NativeCoreBundle) throws {
        let runtime = JavaScriptRuntime()
        try runtime.evaluate(bundle.script, sourceURL: NativeCoreBundle.scriptFileName)
        let core = try runtime.globalObject(named: "MMLNativeCore")
        let apiVersion = try runtime.number(of: core, named: "apiVersion")
        guard apiVersion == Double(NativeCoreBundle.supportedAPIVersion) else {
            throw MMLCoreError.incompatibleCore("facade API version \(apiVersion)")
        }
        let submit = try runtime.function(of: core, named: "submit")
        let collect = try runtime.function(of: core, named: "collect")

        let answer = try Self.envelope(runtime: runtime, core: core, submit: submit, collect: collect, operation: "identity", input: nil)
        guard case let .answered(result) = answer else {
            throw MMLCoreError.incompatibleCore("the core refused to identify itself")
        }
        let identity = try CoreIdentity(coreAnswer: result, bundle: bundle.descriptor)
        guard identity.runtimePackageDigest == bundle.expectedRuntimePackageDigest else {
            throw MMLCoreError.bundleCorrupt("core reports runtime package \(identity.runtimePackageDigest ?? "none"), manifest says \(bundle.expectedRuntimePackageDigest)")
        }
        if identity.canonical.status == "CANONICAL_LOADED", identity.canonical.canonicalVersion != bundle.expectedCanonicalVersion {
            throw MMLCoreError.bundleCorrupt("core loaded Canonical \(identity.canonical.canonicalVersion ?? "none"), manifest says \(bundle.expectedCanonicalVersion ?? "none")")
        }

        self.runtime = runtime
        self.core = core
        self.submit = submit
        self.collect = collect
        cachedIdentity = identity
    }

    /// Loads the bundle the App ships (resources `NativeCore/`).
    public static func bundled(in bundle: Bundle = .main, subdirectory: String = "NativeCore") throws -> JavaScriptCoreEngine {
        guard let resources = bundle.resourceURL else { throw MMLCoreError.bundleMissing("the App has no resource directory") }
        return try JavaScriptCoreEngine(bundle: NativeCoreBundle.load(from: resources.appendingPathComponent(subdirectory)))
    }

    public func identity() async throws -> CoreIdentity {
        cachedIdentity
    }

    public func technicalCheck(_ request: TechnicalCheckRequest) async throws -> TechnicalCheckOutcome {
        let input = try JSONValue(jsonData: JSONEncoder().encode(request))
        switch try call("validate", input) {
        case let .answered(result): return .report(try TechnicalReport(raw: result))
        case let .refused(refusal): return .refused(refusal)
        }
    }

    public func canonicalDocument(path: String) async throws -> CanonicalDocument {
        switch try call("canonicalDocument", .object(["path": .string(path)])) {
        case let .answered(result): return try result.decode(CanonicalDocument.self)
        case let .refused(refusal): throw refusal
        }
    }

    /// The facade's whole envelope for any operation and JSON input. Only the
    /// conformance tests use it, to replay requests the typed App API does not
    /// express (unknown fields, programs, overlap details).
    func rawEnvelope(operation: String, input: JSONValue?) throws -> JSONValue {
        switch try call(operation, input) {
        case let .answered(result): return .object(["ok": .bool(true), "result": result])
        case let .refused(refusal): return .object(["ok": .bool(false), "error": try JSONValue(jsonData: JSONEncoder().encode(refusal))])
        }
    }

    // MARK: - Facade calls

    enum Answer {
        case answered(JSONValue)
        case refused(CoreRefusal)
    }

    /// Codes that describe the host, not the request.
    private static let hostFaultCodes: Set<String> = ["INTERNAL_ERROR", "NOT_SETTLED", "UNKNOWN_TICKET"]

    private func call(_ operation: String, _ input: JSONValue?) throws -> Answer {
        try Self.envelope(runtime: runtime, core: core, submit: submit, collect: collect, operation: operation, input: input)
    }

    /// `submit` starts the operation; JavaScriptCore drains the microtask queue
    /// when that call returns, so `collect` finds it settled.
    private static func envelope(runtime: JavaScriptRuntime, core: JSObjectRef, submit: JSObjectRef, collect: JSObjectRef, operation: String, input: JSONValue?) throws -> Answer {
        let json = try input.map { String(decoding: try $0.jsonData(), as: UTF8.self) } ?? ""
        let ticket = try runtime.number(runtime.call(submit, on: core, [.string(operation), .string(json)]))
        let text = try runtime.string(runtime.call(collect, on: core, [.number(ticket)]))
        let envelope: JSONValue
        do {
            envelope = try JSONValue(jsonData: Data(text.utf8))
        } catch {
            throw MMLCoreError.malformedResponse("\(operation) answered with text that is not JSON")
        }
        guard let ok = envelope["ok"]?.boolValue else { throw MMLCoreError.malformedResponse("\(operation) answered without ok") }
        if ok { return .answered(envelope["result"] ?? .null) }
        let refusal: CoreRefusal
        do {
            refusal = try (envelope["error"] ?? .null).decode(CoreRefusal.self)
        } catch {
            throw MMLCoreError.malformedResponse("\(operation) refused without a code")
        }
        if hostFaultCodes.contains(refusal.code) { throw MMLCoreError.hostFault(code: refusal.code, message: refusal.message) }
        return .refused(refusal)
    }
}
