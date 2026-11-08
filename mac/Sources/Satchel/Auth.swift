import AppKit
import AuthenticationServices
import CryptoKit
import Security

struct Session: Codable {
    let access: String
    let refresh: String
    let expiresAt: Double
    let userId: String
}

/// The session lives in the login keychain, readable only by this app.
private enum Keychain {
    private static let base: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "app.satchel.mac",
        kSecAttrAccount as String: "session",
    ]

    static func load() -> Session? {
        var query = base
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Session.self, from: data)
    }

    static func save(_ session: Session) {
        guard let data = try? JSONEncoder().encode(session) else { return }
        let status = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var query = base
            query[kSecValueData as String] = data
            query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(query as CFDictionary, nil)
        }
    }

    static func clear() { SecItemDelete(base as CFDictionary) }
}

/// The person's own Supabase session, the same kind the web app and the phone hold.
/// Every refresh goes through this one actor: Supabase rotates the refresh token on
/// each use, so two refreshes at once would leave one holding a dead token.
actor Tokens {
    static let shared = Tokens()
    private var cached: Session?
    private var loaded = false
    private var refreshing: Task<Void, Never>?

    func session() -> Session? {
        if !loaded { cached = Keychain.load(); loaded = true }
        return cached
    }

    /// A token good for at least another minute. Nil when signed out.
    func accessToken() async -> String? {
        guard let current = session() else { return nil }
        if current.expiresAt - Date().timeIntervalSince1970 > 60 { return current.access }
        if refreshing == nil {
            refreshing = Task { _ = await self.exchange("refresh_token", ["refresh_token": current.refresh]) }
        }
        await refreshing?.value
        refreshing = nil
        return session()?.access
    }

    /// Nil on success, or a sentence for the person. Only a refusal clears the session; a dropped connection keeps it.
    @discardableResult
    func exchange(_ grant: String, _ body: [String: String]) async -> String? {
        var request = URLRequest(url: URL(string: "\(Config.supabaseURL)/auth/v1/token?grant_type=\(grant)")!)
        request.httpMethod = "POST"
        request.setValue(Config.supabaseKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(code) else {
                if [400, 401, 403, 404].contains(code) { clear() }
                return code == 429 || code >= 500 ? "Satchel is busy. Try again in a minute." : "Satchel did not accept the sign-in. Sign in again."
            }
            guard let o = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let access = o["access_token"] as? String, let refresh = o["refresh_token"] as? String,
                  let user = o["user"] as? [String: Any], let id = user["id"] as? String
            else { return "Satchel sent back something it could not read. Try again." }
            let expires = (o["expires_at"] as? Double) ?? (Date().timeIntervalSince1970 + ((o["expires_in"] as? Double) ?? 3600))
            let fresh = Session(access: access, refresh: refresh, expiresAt: expires, userId: id)
            Keychain.save(fresh)
            cached = fresh
            loaded = true
            onMain { NotificationCenter.default.post(name: .satchelAuth, object: nil) }
            return nil
        } catch {
            return "No connection. Try again when you are online."
        }
    }

    func clear() {
        Keychain.clear()
        cached = nil
        loaded = true
        onMain { NotificationCenter.default.post(name: .satchelAuth, object: nil) }
    }

    /// Forgets the session here at once, then ends it on the server when it can.
    func signOut() async {
        let access = session()?.access
        clear()
        guard let access else { return }
        var request = URLRequest(url: URL(string: "\(Config.supabaseURL)/auth/v1/logout")!)
        request.httpMethod = "POST"
        request.setValue(Config.supabaseKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(access)", forHTTPHeaderField: "authorization")
        _ = try? await URLSession.shared.data(for: request)
    }
}

/// Google sign-in in the system's own sign-in sheet, with PKCE, the same way the phone does it.
final class SignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = SignIn()
    private var running: ASWebAuthenticationSession?

    func start() async -> String? {
        let verifier = Self.base64url(Data((0..<48).map { _ in UInt8.random(in: 0...255) }))
        let challenge = Self.base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
        var url = URLComponents(string: "\(Config.supabaseURL)/auth/v1/authorize")!
        url.queryItems = [
            .init(name: "provider", value: "google"),
            .init(name: "redirect_to", value: Config.redirect),
            .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "s256"),
        ]
        let back: URL? = await withCheckedContinuation { done in
            DispatchQueue.main.async {
                let session = ASWebAuthenticationSession(url: url.url!, callbackURLScheme: "satchel") { url, _ in done.resume(returning: url) }
                session.presentationContextProvider = self
                self.running = session
                session.start()
            }
        }
        running = nil
        guard let back, let code = URLComponents(url: back, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "code" })?.value
        else { return "The sign-in did not finish. Try again." }
        return await Tokens.shared.exchange("pkce", ["auth_code": code, "code_verifier": verifier])
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApp.windows.first(where: { $0.isVisible }) ?? ASPresentationAnchor()
    }

    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
