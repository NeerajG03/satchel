import Foundation

/// What one step of sending came to. The sender decides what to do next from this alone.
enum Step {
    case done
    case signedOut
    case later(String)
    case never(String)
}

/// The same three calls the web page and the phone make: add the row, upload the file,
/// ask for the read. Every call runs as the person, on their own token.
enum ShelfAPI {
    static func add(_ item: QueuedItem) async -> Step {
        var body: [String: Any] = [
            "p_id": item.id, "p_kind": item.kind, "p_note": item.note,
            "p_object_path": item.objectPath ?? NSNull(), "p_mime_type": item.mime ?? NSNull(), "p_size_bytes": item.size ?? NSNull(),
        ]
        if let voice = item.voicePath {
            body["p_voice_path"] = voice
            body["p_voice_mime"] = item.voiceMime
            body["p_voice_size"] = item.voiceSize
        }
        return await call { token in
            let (data, code) = try await send(supabase("/rest/v1/rpc/add_shelf_item", token, json: body))
            if (200..<300).contains(code) { return .done }
            if code == 401 { return .signedOut }
            if (errorOf(data)["hint"] as? String) == "satchel:conflict:shelf_request" {
                return .never("this capture clashes with one already on your Shelf")
            }
            return fallback(code, "Satchel")
        }
    }

    static func upload(path: String?, mime: String?, file: URL) async -> Step {
        guard let path, let mime else { return .done }
        return await call { token in
            var request = supabase("/storage/v1/object/shelf/\(path)", token)
            request.setValue("false", forHTTPHeaderField: "x-upsert")
            request.setValue(mime, forHTTPHeaderField: "content-type")
            let (data, response) = try await URLSession.shared.upload(for: request, fromFile: file)
            let error = errorOf(data)
            // Storage answers most failures as a 400 with the real status in the body.
            let status = Int((error["statusCode"] as? String) ?? "") ?? (response as? HTTPURLResponse)?.statusCode ?? 0
            if (200..<300).contains(status) || status == 409 { return .done }
            if status == 401 || ((error["message"] as? String) ?? "").lowercased().contains("jwt") { return .signedOut }
            return fallback(status, "Storage")
        }
    }

    /// "Already read", "being read" and "could not read it" all count as done: the item is
    /// on the Shelf and the web page can try again. Each try costs a model call.
    static func describe(_ item: QueuedItem) async -> Step {
        await call { token in
            let (_, code) = try await send(satchel("/api/shelf", token, json: ["action": "describe", "id": item.id]))
            switch code {
            case 200, 409, 502: return .done
            case 401: return .signedOut
            case 404: return .never("it is no longer on your Shelf")
            default: return fallback(code, "Satchel")
            }
        }
    }

    /// How many to-dos and events are waiting for a yes. Nil when it could not be read.
    static func waitingCount() async -> Int? {
        guard let token = await Tokens.shared.accessToken(),
              let (data, code) = try? await send(supabase("/rest/v1/rpc/list_shelf_suggestions", token, json: [:])),
              (200..<300).contains(code)
        else { return nil }
        return (try? JSONSerialization.jsonObject(with: data) as? [Any])?.count
    }

    private static func call(_ block: (String) async throws -> Step) async -> Step {
        guard let token = await Tokens.shared.accessToken() else { return .signedOut }
        do { return try await block(token) } catch { return .later("no connection") }
    }

    private static func fallback(_ code: Int, _ who: String) -> Step {
        code >= 500 || code == 429 || code == 0 ? .later("\(who) answered \(code)") : .never("\(who) refused it (\(code))")
    }

    private static func errorOf(_ data: Data) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    private static func send(_ request: URLRequest) async throws -> (Data, Int) {
        let (data, response) = try await URLSession.shared.data(for: request)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }

    private static func supabase(_ path: String, _ token: String, json: [String: Any]? = nil) -> URLRequest {
        var request = URLRequest(url: URL(string: Config.supabaseURL + path)!)
        request.httpMethod = "POST"
        request.setValue(Config.supabaseKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        if let json {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: json)
        }
        return request
    }

    private static func satchel(_ path: String, _ token: String, json: [String: Any]) -> URLRequest {
        var request = URLRequest(url: URL(string: Config.satchelURL + path)!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: json)
        return request
    }
}

/// Sends what is queued, oldest first, one confirmed step at a time. One stuck item never holds up the rest.
actor Sender {
    static let shared = Sender()
    private var running = false
    private var again = false

    nonisolated func kick() { Task { await run() } }

    func run() async {
        if running { again = true; return }
        running = true
        defer { running = false }
        repeat {
            again = false
            var tried = Set<String>()
            while true {
                let fresh = Queue.shared.pending().filter { $0.problem == nil && !tried.contains($0.id) }
                if fresh.isEmpty { break }
                for item in fresh {
                    tried.insert(item.id)
                    if await send(item) == .signedOut { return }
                }
            }
        } while again
    }

    private enum Outcome { case sent, later, signedOut }

    private func send(_ start: QueuedItem) async -> Outcome {
        let queue = Queue.shared
        var item = start
        do {
            if let mime = item.mime, item.objectPath == nil {
                guard let owner = await Tokens.shared.session()?.userId else { return .signedOut }
                item.objectPath = "\(owner)/\(item.id).\(Config.ext(mime) ?? "bin")"
                if let voiceMime = item.voiceMime { item.voicePath = "\(owner)/\(item.id)-voice.\(Config.ext(voiceMime) ?? "m4a")" }
                item = try queue.update(item)
            }
            while true {
                let step: Step
                switch item.stage {
                case QueuedItem.add: step = await ShelfAPI.add(item)
                case QueuedItem.upload:
                    let first = await ShelfAPI.upload(path: item.objectPath, mime: item.mime, file: queue.file(item))
                    if case .done = first, item.voicePath != nil {
                        step = await ShelfAPI.upload(path: item.voicePath, mime: item.voiceMime, file: queue.voice(item))
                    } else { step = first }
                default: step = await ShelfAPI.describe(item)
                }
                switch step {
                case .done:
                    if item.stage >= QueuedItem.read { queue.remove(item); return .sent }
                    item.stage = item.stage == QueuedItem.add && item.objectPath == nil ? QueuedItem.read : item.stage + 1
                    item = try queue.update(item)
                case .never(let why):
                    item.problem = why
                    try? queue.update(item)
                    return .sent
                case .signedOut: return .signedOut
                case .later: return .later
                }
            }
        } catch {
            // Cleared from the Mac while this run was holding it.
            return .sent
        }
    }
}
