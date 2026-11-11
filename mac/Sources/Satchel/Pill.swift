import AppKit
import SwiftUI

/// A small pill under the menu bar, for when the panel is not open: listening, then
/// amber while the drop is only on this Mac, then green once Satchel has it.
final class PillController {
    static let shared = PillController()

    private lazy var panel: CapturePanel = {
        let p = CapturePanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 44),
                             styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: true)
        p.level = .statusBar
        p.backgroundColor = .clear
        p.isOpaque = false
        p.hasShadow = true
        p.ignoresMouseEvents = true
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        let host = NSHostingView(rootView: PillView().environmentObject(Capture.shared))
        host.sizingOptions = [.preferredContentSize]
        p.contentView = host
        return p
    }()

    var visible: Bool { panel.isVisible }

    func show() {
        let mouse = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main else { return }
        let area = screen.visibleFrame
        panel.layoutIfNeeded()
        let size = panel.frame.size
        panel.setFrameOrigin(NSPoint(x: area.midX - size.width / 2, y: area.maxY - size.height - 8))
        panel.alphaValue = 1
        panel.orderFrontRegardless()
    }

    func hide() {
        guard panel.isVisible else { return }
        NSAnimationContext.runAnimationGroup({ $0.duration = 0.25; panel.animator().alphaValue = 0 }) {
            self.panel.orderOut(nil)
            self.panel.alphaValue = 1
        }
    }
}

struct PillView: View {
    @EnvironmentObject var c: Capture

    var body: some View {
        HStack(spacing: 12) {
            if let p = c.problem, c.mode != .saved {
                Led(color: .ledRed, word: "Not saved", wordColor: .hwText)
                Text(p).font(Look.fine).foregroundColor(.hwText).lineLimit(2)
            } else {
                switch c.mode {
                case .listening:
                    Led(color: .orange, word: String(format: c.handsFree ? "hands-free %d:%02d" : "listening %d:%02d",
                                                     c.seconds / 60, c.seconds % 60), wordColor: .hwText)
                    Levels(level: c.level)
                    if c.hasPicture { Text("WITH THE PICTURE").font(Look.readout).foregroundColor(.hwMuted) }
                    Spacer(minLength: 8)
                    Text(c.handsFree ? "TAP ⌥ · SAVE   ESC · CANCEL" : "LET GO · SAVE   ESC · CANCEL")
                        .font(Look.readout).foregroundColor(.hwMuted)
                case .saved:
                    switch c.saved {
                    case .sending: Led(color: .ledAmber, word: "On this Mac · sending", wordColor: .hwText)
                    case .onShelf: Led(color: .ledGreen, word: "On your Shelf", wordColor: .hwText)
                    case .stuck(let why): Led(color: .ledRed, word: "Not sent · \(why)", wordColor: .hwText)
                    }
                    Spacer(minLength: 8)
                    Text(c.savedWords).font(Look.fine).foregroundColor(.hwMuted).lineLimit(1).frame(maxWidth: 160, alignment: .trailing)
                case .compose:
                    EmptyView()
                }
            }
        }
        .padding(.horizontal, 16)
        .frame(width: 420, height: 40)
        .background(Capsule().fill(Color.hw))
        .overlay(Capsule().stroke(Color.white.opacity(0.08)))
    }
}
