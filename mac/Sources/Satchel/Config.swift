import Foundation

/// Written into the app's Info.plist when it is built, from the repo's .env. Both values are public:
/// the web app ships them too.
enum Config {
    private static func value(_ key: String) -> String { (Bundle.main.object(forInfoDictionaryKey: key) as? String) ?? "" }
    static let supabaseURL = value("SatchelSupabaseURL")
    static let supabaseKey = value("SatchelSupabaseKey")
    static let satchelURL = value("SatchelURL")
    static let redirect = "satchel://auth/callback"

    static let noteLimit = 4000
    static let byteLimit = 20 * 1024 * 1024
    private static let extensions = [
        "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic",
        "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/webm": "webm", "audio/ogg": "ogg",
    ]
    static func ext(_ mime: String) -> String? { extensions[mime] }
    static func mime(forFile url: URL) -> String? {
        let e = url.pathExtension.lowercased()
        if e == "jpeg" { return "image/jpeg" }
        return extensions.first { $0.value == e }?.key
    }
}

extension Notification.Name {
    /// Something was added to, sent from or stuck in the queue.
    static let satchelQueue = Notification.Name("satchel.queue")
    static let satchelAuth = Notification.Name("satchel.auth")
}

func onMain(_ block: @escaping () -> Void) {
    if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
}
