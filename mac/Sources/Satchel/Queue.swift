import Foundation

/// One capture waiting to reach the Shelf. `stage` is how far it got, saved after
/// every step, so a capture picks up where it stopped. Same shape as the phone's.
struct QueuedItem: Codable {
    static let add = 0, upload = 1, read = 2

    let id: String
    let kind: String            // note, photo or voice
    let note: String
    var objectPath: String?     // <owner id>/<item id>.<ext>, set once signed in
    let mime: String?
    let size: Int?
    var stage = QueuedItem.add
    var createdAt = Date().timeIntervalSince1970
    var problem: String?
    var voicePath: String?
    var voiceMime: String?
    var voiceSize: Int?
}

struct QueueError: LocalizedError {
    let errorDescription: String?
    init(_ why: String) { errorDescription = why }
}

/// Captures as folders in Application Support: meta.json plus the file. Nothing here touches the network.
final class Queue {
    static let shared = Queue()
    private let root: URL
    private let fm = FileManager.default

    init() {
        root = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Satchel/queue")
        try? fm.createDirectory(at: root, withIntermediateDirectories: true)
    }

    func addNote(_ text: String) throws -> QueuedItem {
        try save(QueuedItem(id: UUID().uuidString.lowercased(), kind: "note", note: String(text.prefix(Config.noteLimit)),
                            mime: nil, size: nil), file: nil)
    }

    func addFile(kind: String, mime: String, data: Data, note: String = "") throws -> QueuedItem {
        guard Config.ext(mime) != nil else { throw QueueError("The Shelf does not take that kind of file.") }
        guard (1...Config.byteLimit).contains(data.count) else { throw QueueError("That file is over 20 MB.") }
        return try save(QueuedItem(id: UUID().uuidString.lowercased(), kind: kind, note: String(note.prefix(Config.noteLimit)),
                                   mime: mime, size: data.count), file: data)
    }

    /// A picture and what was said about it, as one item.
    func addPictureWithVoice(picture: Data, mime: String, voice: Data, note: String = "") throws -> QueuedItem {
        guard (1...Config.byteLimit).contains(picture.count), (1...Config.byteLimit).contains(voice.count)
        else { throw QueueError("That file is over 20 MB.") }
        let item = QueuedItem(id: UUID().uuidString.lowercased(), kind: "photo", note: String(note.prefix(Config.noteLimit)),
                              mime: mime, size: picture.count, voiceMime: "audio/mp4", voiceSize: voice.count)
        let dir = root.appendingPathComponent(item.id)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        try voice.write(to: dir.appendingPathComponent("voice"), options: .atomic)
        return try save(item, file: picture)
    }

    func pending() -> [QueuedItem] {
        let dirs = (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        return dirs.compactMap { read($0.appendingPathComponent("meta.json")) }.sorted { $0.createdAt < $1.createdAt }
    }

    func item(_ id: String) -> QueuedItem? { read(root.appendingPathComponent(id).appendingPathComponent("meta.json")) }
    func file(_ item: QueuedItem) -> URL { root.appendingPathComponent(item.id).appendingPathComponent("data") }
    func voice(_ item: QueuedItem) -> URL { root.appendingPathComponent(item.id).appendingPathComponent("voice") }

    @discardableResult
    func update(_ item: QueuedItem) throws -> QueuedItem {
        let meta = root.appendingPathComponent(item.id).appendingPathComponent("meta.json")
        guard fm.fileExists(atPath: meta.path) else { throw CocoaError(.fileNoSuchFile) }
        try JSONEncoder().encode(item).write(to: meta, options: .atomic)
        changed()
        return item
    }

    func remove(_ item: QueuedItem) {
        try? fm.removeItem(at: root.appendingPathComponent(item.id))
        changed()
    }

    /// Lets go of items that will never send, so the light can go back to green.
    func clearStuck() { pending().filter { $0.problem != nil }.forEach(remove) }

    private func save(_ item: QueuedItem, file: Data?) throws -> QueuedItem {
        let dir = root.appendingPathComponent(item.id)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        if let file { try file.write(to: dir.appendingPathComponent("data"), options: .atomic) }
        // Written whole and then moved, so a crash mid-write never leaves half a record.
        try JSONEncoder().encode(item).write(to: dir.appendingPathComponent("meta.json"), options: .atomic)
        changed()
        return item
    }

    private func read(_ url: URL) -> QueuedItem? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(QueuedItem.self, from: data)
    }

    private func changed() { onMain { NotificationCenter.default.post(name: .satchelQueue, object: nil) } }
}
