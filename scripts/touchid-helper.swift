import Foundation
import LocalAuthentication

let args = CommandLine.arguments
let reason = args.count > 1 ? args[1] : "Authenticate to unlock the database connection"

let context = LAContext()
var error: NSError?

let policy = LAPolicy.deviceOwnerAuthentication
guard context.canEvaluatePolicy(policy, error: &error) else {
    if let e = error {
        FileHandle.standardError.write("auth-unavailable: \(e.localizedDescription)\n".data(using: .utf8) ?? Data())
    }
    exit(2)
}

let sema = DispatchSemaphore(value: 0)
var success = false
context.evaluatePolicy(policy, localizedReason: reason) { ok, err in
    success = ok
    if let e = err {
        FileHandle.standardError.write("auth-error: \(e.localizedDescription)\n".data(using: .utf8) ?? Data())
    }
    sema.signal()
}
sema.wait()
exit(success ? 0 : 1)
