import AppKit
import Carbon
import Network

/// Satchel for the Mac: a menu bar light and two keys from anywhere. Hold right ⌥ to talk
/// and let go to save; ⌃⌥Space opens the panel to type, paste or grab part of the screen.
@main
enum Main {
    static let delegate = AppDelegate()
    static func main() {
        let app = NSApplication.shared
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var bar: StatusBar?
    private let network = NWPathMonitor()

    func applicationDidFinishLaunching(_ notification: Notification) {
        Look.register()
        bar = StatusBar()

        NotificationCenter.default.addObserver(forName: .satchelQueue, object: nil, queue: .main) { [weak self] _ in self?.refresh() }
        NotificationCenter.default.addObserver(forName: .satchelAuth, object: nil, queue: .main) { [weak self] _ in
            self?.refresh()
            Sender.shared.kick()
        }

        // ⌃⌥Space opens the panel to type, paste or grab the screen.
        HotKeys.shared.register(id: 1, key: HotKeys.space, modifiers: UInt32(controlKey | optionKey)) { pressed in
            guard pressed else { return }
            if Capture.shared.listening { Capture.shared.finishListening() } else { PanelController.shared.toggle() }
        }
        wireTalkKey()

        network.pathUpdateHandler = { path in if path.status == .satisfied { Sender.shared.kick() } }
        network.start(queue: .global(qos: .utility))
        Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in Sender.shared.kick() }

        Task { @MainActor in
            Capture.shared.signedIn = await Tokens.shared.session() != nil
            self.refresh()
            if !Capture.shared.signedIn { PanelController.shared.show(focus: true) }
            Sender.shared.kick()
        }
    }

    private func wireTalkKey() {
        let key = TalkKey.shared
        let capture = Capture.shared
        key.onHold = { if capture.signedIn && !capture.listening { capture.listen(handsFree: false) } }
        key.onRelease = { if capture.listening && !capture.handsFree { capture.finishListening() } }
        // It was a shortcut after all: nothing heard is kept.
        key.onInterrupt = { if capture.listening && !capture.handsFree { capture.cancelListening() } }
        key.onDoubleTap = { if capture.signedIn && !capture.listening { capture.listen(handsFree: true) } }
        key.onTap = { if capture.listening && capture.handsFree { capture.finishListening() } }

        // Accessibility can be turned on at any time in System Settings; start as soon as it is.
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { timer in
            capture.talkKeyOn = key.allowed
            if key.allowed { key.start(); timer.invalidate() }
        }.fire()
    }

    private func refresh() {
        Task { @MainActor in
            let signedIn = await Tokens.shared.session() != nil
            Capture.shared.signedIn = signedIn
            Status.shared.refresh(signedIn: signedIn)
            self.bar?.refresh()
        }
    }
}
