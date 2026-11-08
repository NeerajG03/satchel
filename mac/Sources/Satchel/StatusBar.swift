import AppKit
import ServiceManagement
import SwiftUI

/// What is still on this Mac, as one light: green synced, amber sending, red stuck.
final class Status: ObservableObject {
    static let shared = Status()
    @Published var color = Color.ledOff
    @Published var word = "…"
    @Published var sending = 0
    @Published var stuck: [QueuedItem] = []
    @Published var waiting: Int?

    func refresh(signedIn: Bool) {
        let pending = Queue.shared.pending()
        stuck = pending.filter { $0.problem != nil }
        sending = pending.count - stuck.count
        switch (signedIn, sending, stuck.count) {
        case (false, _, _): color = .ledOff; word = "signed out"
        case (_, 0, 0): color = .ledGreen; word = "synced"
        case (_, _, 0): color = .ledAmber; word = "\(sending) sending"
        default: color = .ledRed; word = "\(stuck.count) stuck"
        }
    }
}

final class StatusBar: NSObject, NSMenuDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()

    override init() {
        super.init()
        item.button?.image = NSImage(systemSymbolName: "tray.and.arrow.down", accessibilityDescription: "Satchel")
        item.button?.imagePosition = .imageLeading
        menu.delegate = self
        item.menu = menu
        if let button = item.button {
            let target = DropTarget(frame: button.bounds)
            target.autoresizingMask = [.width, .height]
            button.addSubview(target)
        }
    }

    /// The bar shows only the icon when all is well, and a coloured dot when it is not.
    func refresh() {
        let s = Status.shared
        let dot: NSColor? = s.stuck.isEmpty ? (s.sending > 0 ? NSColor(Color.ledAmber) : nil) : NSColor(Color.ledRed)
        if let dot {
            item.button?.attributedTitle = NSAttributedString(string: "●", attributes: [.foregroundColor: dot, .font: NSFont.systemFont(ofSize: 8)])
        } else {
            item.button?.title = ""
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let s = Status.shared
        let signedIn = Capture.shared.signedIn

        let light = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        light.attributedTitle = NSAttributedString(string: "●  \(s.word.capitalized)", attributes: [.foregroundColor: NSColor.labelColor])
        light.isEnabled = false
        menu.addItem(light)
        for stuck in s.stuck.prefix(3) {
            let row = NSMenuItem(title: "   \(stuck.note.isEmpty ? stuck.kind.capitalized : String(stuck.note.prefix(40))): \(stuck.problem ?? "")", action: nil, keyEquivalent: "")
            row.isEnabled = false
            menu.addItem(row)
        }
        menu.addItem(.separator())

        if signedIn {
            add("Drop something…", key: " ", modifiers: [.control, .option], #selector(drop))
            add("Pick part of the screen…", #selector(grab))
            if TalkKey.shared.allowed {
                let hint = NSMenuItem(title: "Hold right ⌥ anywhere to talk", action: nil, keyEquivalent: "")
                hint.isEnabled = false
                menu.addItem(hint)
            } else {
                add("Turn on the ⌥ talk key…", #selector(talkKey))
            }
            let tip = NSMenuItem(title: "Drag a file, picture or link onto this icon", action: nil, keyEquivalent: "")
            tip.isEnabled = false
            menu.addItem(tip)
            menu.addItem(.separator())
            if let waiting = s.waiting, waiting > 0 {
                add("\(waiting) waiting for you", #selector(openShelf))
            }
            add("Open your Shelf", #selector(openShelf))
            if s.sending > 0 { add("Send now", #selector(sendNow)) }
            if !s.stuck.isEmpty { add("Let go of stuck drops", #selector(clearStuck)) }
        } else {
            add("Sign in with Google…", #selector(signIn))
        }
        menu.addItem(.separator())
        let login = add("Open at login", #selector(toggleLogin))
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        if signedIn { add("Sign out", #selector(signOut)) }
        add("Quit Satchel", key: "q", #selector(quit))

        Task { @MainActor in
            s.waiting = await ShelfAPI.waitingCount()
        }
    }

    @discardableResult
    private func add(_ title: String, key: String = "", modifiers: NSEvent.ModifierFlags = [.command], _ action: Selector) -> NSMenuItem {
        let row = NSMenuItem(title: title, action: action, keyEquivalent: key)
        row.keyEquivalentModifierMask = modifiers
        row.target = self
        menu.addItem(row)
        return row
    }

    @objc private func drop() { PanelController.shared.show(focus: true) }
    @objc private func grab() { PanelController.shared.grabScreen() }
    @objc private func talkKey() { TalkKey.shared.ask() }
    @objc private func sendNow() { Sender.shared.kick() }
    @objc private func clearStuck() { Queue.shared.clearStuck() }
    @objc private func quit() { NSApp.terminate(nil) }

    @objc private func openShelf() {
        if let url = URL(string: Config.satchelURL + "/shelf") { NSWorkspace.shared.open(url) }
    }

    @objc private func signIn() { PanelController.shared.show(focus: true) }

    @objc private func signOut() { Task { await Tokens.shared.signOut() } }

    @objc private func toggleLogin() {
        let service = SMAppService.mainApp
        if service.status == .enabled { try? service.unregister() } else { try? service.register() }
    }
}

/// The menu bar icon takes drops: a picture or voice file goes on the Shelf as it is,
/// and text or a link becomes a note.
final class DropTarget: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        registerForDraggedTypes([.fileURL, .URL, .string, .png, .tiff])
    }
    required init?(coder: NSCoder) { nil }

    // Drags find this view by hit testing, so it stays hit-testable and hands clicks to the icon.
    override func mouseDown(with event: NSEvent) { superview?.mouseDown(with: event) }
    override func rightMouseDown(with event: NSEvent) { superview?.rightMouseDown(with: event) }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard Capture.shared.signedIn else { return [] }
        return .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let pb = sender.draggingPasteboard
        let capture = Capture.shared
        if let url = (pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL])?.first {
            guard let mime = Config.mime(forFile: url), let data = try? Data(contentsOf: url) else {
                capture.say("The Shelf takes pictures and voice notes. That file is neither.")
                return false
            }
            capture.drop(data: data, mime: mime)
            return true
        }
        if let png = Pasteboard.image(pb) { capture.drop(data: png, mime: "image/png"); return true }
        if let link = (pb.readObjects(forClasses: [NSURL.self]) as? [URL])?.first { capture.drop(text: link.absoluteString); return true }
        if let text = pb.string(forType: .string) { capture.drop(text: text); return true }
        return false
    }
}
