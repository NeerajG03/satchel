import AppKit
import ApplicationServices

/// Left ⌥ on its own is the talk key: hold to talk and let go to save; double-tap for
/// hands-free, and tap once more to finish. Left ⌥ is also half of many shortcuts, so it
/// only counts while nothing else is pressed: another key, modifier or click while it is
/// down means it was a shortcut, and anything heard is thrown away.
final class TalkKey {
    static let shared = TalkKey()
    private static let leftOption: UInt16 = 58

    var onHold: () -> Void = {}
    var onRelease: () -> Void = {}
    var onInterrupt: () -> Void = {}
    var onDoubleTap: () -> Void = {}
    var onTap: () -> Void = {}

    private var monitors: [Any] = []
    private var down: Date?
    private var solo = false
    private var holding = false
    private var lastTap: Date?
    private var timer: DispatchWorkItem?

    /// Hearing a key while another app is in front needs Accessibility, once.
    var allowed: Bool { AXIsProcessTrusted() }

    func ask() {
        AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    }

    func start() {
        guard monitors.isEmpty, allowed else { return }
        let others: NSEvent.EventTypeMask = [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
        monitors.append(NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] in self?.flags($0) } as Any)
        monitors.append(NSEvent.addGlobalMonitorForEvents(matching: others) { [weak self] _ in self?.other() } as Any)
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] in self?.flags($0); return $0 } as Any)
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: others) { [weak self] in self?.other(); return $0 } as Any)
    }

    private func flags(_ event: NSEvent) {
        let rest = event.modifierFlags.intersection([.command, .control, .shift, .function, .capsLock])
        if event.keyCode == Self.leftOption {
            if event.modifierFlags.contains(.option) { pressed(alone: rest.isEmpty) } else { released() }
        } else if down != nil {
            other()
        }
    }

    private func pressed(alone: Bool) {
        guard down == nil else { return }
        down = Date()
        solo = alone
        guard alone else { return }
        let hold = DispatchWorkItem { [weak self] in
            guard let self, self.down != nil, self.solo else { return }
            self.holding = true
            self.onHold()
        }
        timer = hold
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: hold)
    }

    private func released() {
        timer?.cancel()
        defer { down = nil; holding = false }
        guard let start = down, solo else { return }
        if holding { onRelease(); return }
        guard Date().timeIntervalSince(start) < 0.3 else { return }
        if let last = lastTap, Date().timeIntervalSince(last) < 0.4 {
            lastTap = nil
            onDoubleTap()
        } else {
            lastTap = Date()
            onTap()
        }
    }

    private func other() {
        guard down != nil, solo else { return }
        solo = false
        lastTap = nil
        timer?.cancel()
        if holding { holding = false; onInterrupt() }
    }
}
