import AppKit
import SwiftUI

/// What is being dropped right now: words, maybe a picture, maybe a voice. Main thread only.
final class Capture: ObservableObject {
    static let shared = Capture()

    enum Mode { case compose, listening, saved }
    enum Saved { case sending, onShelf, stuck(String) }

    @Published var mode = Mode.compose
    @Published var note = ""
    @Published var picture: NSImage?
    @Published var problem: String?
    @Published var handsFree = false
    @Published var seconds = 0
    @Published var level: Float = 0
    @Published var saved = Saved.sending
    @Published var savedWords = ""
    @Published var signedIn = false
    @Published var talkKeyOn = false

    private var pictureData: Data?
    private var pictureMime: String?
    private var recorder: Recorder?
    private var ticker: Timer?
    private var watcher: Timer?

    var listening: Bool { recorder != nil }
    var hasPicture: Bool { pictureData != nil }
    var canSave: Bool { hasPicture || !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    func attach(_ data: Data, mime: String) {
        guard data.count <= Config.byteLimit else { problem = "That picture is over 20 MB."; return }
        pictureData = data
        pictureMime = mime
        picture = NSImage(data: data)
        problem = nil
    }

    func dropPicture() {
        pictureData = nil
        pictureMime = nil
        picture = nil
    }

    /// Starts listening if the microphone is allowed. The first time, it asks and the person holds again.
    @discardableResult
    func listen(handsFree: Bool) -> Bool {
        guard recorder == nil else { return true }
        guard Recorder.allowed else {
            Task { @MainActor in
                let ok = await Recorder.ask()
                self.say(ok ? "Satchel can hear you now. Hold ⌥ again to talk."
                    : "Satchel needs the microphone. Allow it in System Settings › Privacy & Security › Microphone.")
            }
            return false
        }
        do {
            recorder = try Recorder()
        } catch {
            say(error.localizedDescription)
            return false
        }
        if !PanelController.shared.visible { PillController.shared.show() }
        self.handsFree = handsFree
        problem = nil
        seconds = 0
        level = 0
        mode = .listening
        HotKeys.shared.register(id: 9, key: HotKeys.escape, modifiers: 0) { [weak self] pressed in
            if pressed { self?.cancelListening() }
        }
        ticker = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self, let r = self.recorder else { return }
            self.level = r.level()
            self.seconds = r.seconds
        }
        return true
    }

    func finishListening() {
        guard let r = stopListening() else { return }
        guard let voice = r.stop() else {
            mode = .compose
            say("Nothing was heard, so nothing was sent.")
            return
        }
        save(voice: voice)
    }

    func cancelListening() {
        stopListening()?.discard()
        mode = .compose
        PillController.shared.hide()
    }

    private func stopListening() -> Recorder? {
        let r = recorder
        recorder = nil
        ticker?.invalidate()
        ticker = nil
        handsFree = false
        HotKeys.shared.unregister(id: 9)
        return r
    }

    /// Straight from a drag onto the menu bar icon, leaving any draft in the panel alone.
    func drop(data: Data, mime: String) {
        let kind = mime.hasPrefix("audio/") ? "voice" : "photo"
        commit { try Queue.shared.addFile(kind: kind, mime: mime, data: data) } words: { kind == "voice" ? "A voice note" : "A picture" }
    }

    func drop(text: String) {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return }
        commit { try Queue.shared.addNote(words) } words: { words }
    }

    private func commit(_ add: () throws -> QueuedItem, words: () -> String) {
        do {
            let item = try add()
            savedWords = words()
            saved = .sending
            mode = .saved
            if !PanelController.shared.visible { PillController.shared.show() }
            Sender.shared.kick()
            watch(item.id)
        } catch {
            say(error.localizedDescription)
        }
    }

    /// One drop, whatever it holds: words, a picture, a voice, or a picture with the voice.
    func save(voice: Data? = nil) {
        let words = note.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let item: QueuedItem
            switch (pictureData, voice) {
            case let (picture?, voice?): item = try Queue.shared.addPictureWithVoice(picture: picture, mime: pictureMime ?? "image/png", voice: voice, note: words)
            case let (picture?, nil): item = try Queue.shared.addFile(kind: "photo", mime: pictureMime ?? "image/png", data: picture, note: words)
            case let (nil, voice?): item = try Queue.shared.addFile(kind: "voice", mime: "audio/mp4", data: voice, note: words)
            case (nil, nil):
                guard !words.isEmpty else { return }
                item = try Queue.shared.addNote(words)
            }
            savedWords = words.isEmpty ? (voice != nil ? "A voice note" : "A picture") : words
            note = ""
            dropPicture()
            problem = nil
            saved = .sending
            mode = .saved
            if !PanelController.shared.visible { PillController.shared.show() }
            Sender.shared.kick()
            watch(item.id)
        } catch {
            problem = error.localizedDescription
            mode = .compose
        }
    }

    /// Amber while it is only on this Mac, green once Satchel has it. Green only when that is true.
    private func watch(_ id: String) {
        watcher?.invalidate()
        let start = Date()
        watcher = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] timer in
            guard let self else { return timer.invalidate() }
            let item = Queue.shared.item(id)
            let waited = Date().timeIntervalSince(start)
            if item == nil {
                self.saved = .onShelf
                timer.invalidate()
                self.close(after: 1.4)
            } else if let why = item?.problem {
                self.saved = .stuck(why)
                timer.invalidate()
            } else if waited > 6 {
                // Still sending: the menu bar light keeps watching it.
                timer.invalidate()
                self.close(after: 0)
            }
        }
    }

    private func close(after seconds: Double) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
            guard self.mode == .saved else { return }
            PanelController.shared.hide()
            PillController.shared.hide()
            self.mode = .compose
        }
    }

    /// A problem goes where the person is looking: the panel when it is open, the pill when not.
    func say(_ text: String) {
        problem = text
        guard !PanelController.shared.visible else { return }
        PillController.shared.show()
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            guard self.problem == text, self.mode != .listening else { return }
            self.problem = nil
            PillController.shared.hide()
        }
    }

    func another() {
        watcher?.invalidate()
        mode = .compose
    }
}
