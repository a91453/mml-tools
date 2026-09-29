#if canImport(JavaScriptCore)
import JavaScriptCore
#else
import CJavaScriptCore
#endif
import MMLCore

/// A private JavaScriptCore context, through the JavaScriptCore C API.
///
/// The C API is the one surface JavaScriptCore offers on every platform this
/// package builds on: Apple's framework on iOS and macOS, WebKitGTK's library
/// on Linux. The context is a bare ECMAScript engine: it has no network, file
/// or timer API, so nothing evaluated in it can reach outside the process.
///
/// Not thread-safe by itself; ``JavaScriptCoreEngine`` owns it and serializes
/// every call.
final class JavaScriptRuntime {
    private let group: JSContextGroupRef
    private let context: JSGlobalContextRef
    private var protectedValues: [JSValueRef] = []

    init() {
        group = JSContextGroupCreate()
        context = JSGlobalContextCreateInGroup(group, nil)
    }

    deinit {
        for value in protectedValues { JSValueUnprotect(context, value) }
        JSGlobalContextRelease(context)
        JSContextGroupRelease(group)
    }

    /// Evaluates a classic script.
    @discardableResult
    func evaluate(_ script: String, sourceURL: String) throws -> JSValueRef {
        let source = makeString(script)
        let url = makeString(sourceURL)
        defer {
            JSStringRelease(source)
            JSStringRelease(url)
        }
        var exception: JSValueRef?
        let result = JSEvaluateScript(context, source, nil, url, 1, &exception)
        try check(exception)
        guard let result else { throw MMLCoreError.javaScriptException("evaluation returned no value") }
        return result
    }

    /// An object reachable from the global object, kept alive for the life of
    /// this runtime.
    func globalObject(named name: String) throws -> JSObjectRef {
        try object(property(of: JSContextGetGlobalObject(context), named: name), describing: name)
    }

    func function(of object: JSObjectRef, named name: String) throws -> JSObjectRef {
        let function = try self.object(property(of: object, named: name), describing: name)
        guard JSObjectIsFunction(context, function) else { throw MMLCoreError.incompatibleCore("\(name) is not a function") }
        return function
    }

    func number(of object: JSObjectRef, named name: String) throws -> Double {
        let value = try property(of: object, named: name)
        guard JSValueIsNumber(context, value) else { throw MMLCoreError.incompatibleCore("\(name) is not a number") }
        return JSValueToNumber(context, value, nil)
    }

    enum Argument {
        case string(String)
        case number(Double)
    }

    /// Calls `function` with `this` bound to `object`.
    func call(_ function: JSObjectRef, on object: JSObjectRef, _ arguments: [Argument]) throws -> JSValueRef {
        var strings: [JSStringRef] = []
        var values: [JSValueRef?] = []
        // The argument values live in a Swift array on the heap, which the
        // collector does not scan; each is protected from the moment it is
        // made until the call has returned.
        defer {
            for case let value? in values { JSValueUnprotect(context, value) }
            strings.forEach(JSStringRelease)
        }
        for argument in arguments {
            let value: JSValueRef
            switch argument {
            case let .string(text):
                let string = makeString(text)
                strings.append(string)
                value = JSValueMakeString(context, string)
            case let .number(number):
                value = JSValueMakeNumber(context, number)
            }
            JSValueProtect(context, value)
            values.append(value)
        }
        var exception: JSValueRef?
        let result = values.withUnsafeBufferPointer { buffer in
            JSObjectCallAsFunction(context, function, object, buffer.count, buffer.baseAddress, &exception)
        }
        try check(exception)
        guard let result else { throw MMLCoreError.javaScriptException("call returned no value") }
        return result
    }

    func string(_ value: JSValueRef) throws -> String {
        var exception: JSValueRef?
        let string = JSValueToStringCopy(context, value, &exception)
        try check(exception)
        guard let string else { throw MMLCoreError.malformedResponse("value is not convertible to a string") }
        defer { JSStringRelease(string) }
        return swiftString(string)
    }

    func number(_ value: JSValueRef) throws -> Double {
        guard JSValueIsNumber(context, value) else { throw MMLCoreError.malformedResponse("value is not a number") }
        return JSValueToNumber(context, value, nil)
    }

    // MARK: - Private

    private func property(of object: JSObjectRef, named name: String) throws -> JSValueRef {
        let key = makeString(name)
        defer { JSStringRelease(key) }
        var exception: JSValueRef?
        let value = JSObjectGetProperty(context, object, key, &exception)
        try check(exception)
        guard let value, !JSValueIsUndefined(context, value), !JSValueIsNull(context, value) else {
            throw MMLCoreError.incompatibleCore("\(name) is not defined")
        }
        return value
    }

    private func object(_ value: JSValueRef, describing name: String) throws -> JSObjectRef {
        guard JSValueIsObject(context, value) else { throw MMLCoreError.incompatibleCore("\(name) is not an object") }
        var exception: JSValueRef?
        let object = JSValueToObject(context, value, &exception)
        try check(exception)
        guard let object else { throw MMLCoreError.incompatibleCore("\(name) is not an object") }
        JSValueProtect(context, object)
        protectedValues.append(object)
        return object
    }

    private func check(_ exception: JSValueRef?) throws {
        guard let exception else { return }
        let text = (try? string(exception)) ?? "an exception that could not be described"
        throw MMLCoreError.javaScriptException(text)
    }

    private func makeString(_ text: String) -> JSStringRef {
        let units = Array(text.utf16)
        return units.withUnsafeBufferPointer { JSStringCreateWithCharacters($0.baseAddress, $0.count) }
    }

    private func swiftString(_ string: JSStringRef) -> String {
        let length = JSStringGetLength(string)
        guard length > 0, let characters = JSStringGetCharactersPtr(string) else { return "" }
        return String(decoding: UnsafeBufferPointer(start: characters, count: length), as: UTF16.self)
    }
}
