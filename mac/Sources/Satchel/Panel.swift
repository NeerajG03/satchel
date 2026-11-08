import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// A floating panel that takes typing without pulling the person out of the app they are in.
final class CapturePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class PanelController: NSObject, NSWindowDelegate {
    static let shared = PanelController()
    private var top: CGFloat = 0
    private var grabbing = false

    private lazy var panel: CapturePanel = {
        let p = CapturePanel(contentRect: NSRect(x: 0, y: 0, width: 560, height: 200),
                             styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView], backing: .buffered, defer: true)
        p.isFloatingPanel = true
        p.level = .floating
        p.backgroundColor = .clear
        p.isOpaque = false
        p.hasShadow = true
        p.hidesOnDeactivate = false
        p.isMovableByWindowBackground = true
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let host = NSHostingView(rootView: PanelView().environmentObject(Capture.shared))
        host.sizingOptions = [.preferredContentSize]
        p.contentView = host
        p.delegate = self
        // ⌘V with a picture on the clipboard attaches it; plain text pastes as usual.
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard event.window === p, event.modifierFlags.contains(.command), event.charactersIgnoringModifiers == "v",
                  let image = Pasteboard.picture() else { return event }
            Capture.shared.attach(image.data, mime: image.mime)
            return nil
        }
        return p
    }()

    var visible: Bool { panel.isVisible }
    var isKey: Bool { panel.isKeyWindow }

    func toggle() { visible && isKey ? hide() : show(focus: true) }

    /// `focus` takes the keyboard for typing; without it the panel only shows, as while talking.
    func show(focus: Bool) {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
        if !panel.isVisible, let area = screen?.visibleFrame {
            top = area.maxY - area.height * 0.2
            let size = panel.frame.size
            panel.setFrameOrigin(NSPoint(x: area.midX - size.width / 2, y: top - size.height))
        }
        if focus { panel.makeKeyAndOrderFront(nil) } else { panel.orderFrontRegardless() }
    }

    func hide() { panel.orderOut(nil) }

    /// Picks part of the screen with the system's own crosshair, then comes back with it.
    func grabScreen() {
        grabbing = true
        hide()
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).png")
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        task.arguments = ["-i", "-x", file.path]
        task.terminationHandler = { _ in
            DispatchQueue.main.async {
                self.grabbing = false
                if let data = try? Data(contentsOf: file), !data.isEmpty { Capture.shared.attach(data, mime: "image/png") }
                try? FileManager.default.removeItem(at: file)
                self.show(focus: true)
            }
        }
        do { try task.run() } catch { grabbing = false; show(focus: true) }
    }

    // The panel grows downward from where it opened, not upward.
    func windowDidResize(_ notification: Notification) {
        guard top > 0 else { return }
        panel.setFrameOrigin(NSPoint(x: panel.frame.minX, y: top - panel.frame.height))
    }

    func windowDidMove(_ notification: Notification) { top = panel.frame.maxY }

    func windowDidResignKey(_ notification: Notification) {
        if Capture.shared.mode == .compose && !grabbing { hide() }
    }
}

struct PanelView: View {
    @EnvironmentObject var c: Capture
    @FocusState private var typing: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Satchel\u{00A0}").font(Look.mark).foregroundColor(.hwText).fixedSize()
                Spacer()
                StatusLed()
            }
            if !c.signedIn { signIn }
            else {
                switch c.mode {
                case .compose: compose
                case .listening: listening
                case .saved: saved
                }
            }
        }
        .padding(16)
        .frame(width: 560)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.hw))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(0.06)))
        .onExitCommand {
            if c.listening { c.cancelListening() } else { PanelController.shared.hide() }
        }
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            providers.first?.loadObject(ofClass: URL.self) { url, _ in
                guard let url, let mime = Config.mime(forFile: url), mime.hasPrefix("image/"),
                      let data = try? Data(contentsOf: url) else { return }
                DispatchQueue.main.async { c.attach(data, mime: mime) }
            }
            return true
        }
        .onAppear { typing = true }
    }

    private var signIn: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Sign in once. Then hold left ⌥ anywhere to talk, or press ⌃⌥Space to type.")
                .font(Look.words).foregroundColor(.hwText)
            if let p = c.problem { Text(p).font(Look.fine).foregroundColor(.onHwRed) }
            Button("Sign in with Google") {
                Task { @MainActor in
                    let why = await SignIn.shared.start()
                    c.problem = why
                    PanelController.shared.show(focus: true)
                }
            }.buttonStyle(HardwareKeyStyle(selected: true))
        }
    }

    private var compose: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                if let picture = c.picture {
                    Image(nsImage: picture).resizable().scaledToFill()
                        .frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 6))
                        .overlay(alignment: .topTrailing) {
                            Button { c.dropPicture() } label: {
                                Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundColor(.paper)
                                    .frame(width: 18, height: 18).background(Circle().fill(Color.hw))
                            }.buttonStyle(.plain).offset(x: 6, y: -6).accessibilityLabel("Take the picture off")
                        }
                }
                TextField("", text: $c.note, prompt: Text(c.hasPicture ? "Say what it is, or type it…" : "A thought, a link, a to-do…").foregroundColor(.muted), axis: .vertical)
                    .textFieldStyle(.plain).font(Look.words).foregroundColor(.inkText)
                    .lineLimit(1...8).focused($typing)
                    .onSubmit { c.save() }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 9).fill(Color.paper))

            HStack(spacing: 8) {
                Button { PanelController.shared.grabScreen() } label: {
                    HStack(spacing: 8) { Image(systemName: "viewfinder"); Text("Screen"); Keycap("⌘G") }
                }.buttonStyle(HardwareKeyStyle()).keyboardShortcut("g", modifiers: .command)
                    .help("Drag a box around part of the screen")
                Spacer()
                MicKey()
                Button { c.save() } label: { HStack(spacing: 8) { Text("Save"); Keycap("⏎", dark: c.canSave) } }
                    .buttonStyle(HardwareKeyStyle(selected: c.canSave)).disabled(!c.canSave)
            }
            if let p = c.problem { Text(p).font(Look.fine).foregroundColor(.onHwRed) }
            if !c.talkKeyOn {
                HStack(spacing: 12) {
                    Led(color: .ledAmber, word: "⌥ talk key is off", wordColor: .hwText)
                    Spacer()
                    Button("Turn it on") { TalkKey.shared.ask() }.buttonStyle(HardwareKeyStyle())
                }
            }
            HStack(spacing: 6) {
                Keycap("⌥"); Text("HOLD · TALK")
                Spacer()
                Keycap("⌘V"); Text("PICTURE")
                Keycap("ESC").padding(.leading, 8); Text("CLOSE")
            }.font(Look.readout).foregroundColor(.hwMuted)
        }
    }

    private var listening: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Led(color: .orange, word: String(format: c.handsFree ? "listening · hands-free %d:%02d" : "listening %d:%02d",
                                                 c.seconds / 60, c.seconds % 60), wordColor: .hwText)
                Levels(level: c.level)
                Spacer()
                if let picture = c.picture {
                    Image(nsImage: picture).resizable().scaledToFill().frame(width: 32, height: 32)
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                }
                if c.handsFree {
                    Button("Cancel") { c.cancelListening() }.buttonStyle(HardwareKeyStyle())
                    MicKey()
                }
            }
            HStack {
                Text(c.handsFree ? "Tap ⌥ or click the mic to finish" : "Let go of ⌥ to save")
                    + Text(c.hasPicture ? " · the picture and your words, one drop" : " · a voice note")
                Spacer()
                Text("ESC · CANCEL").font(Look.readout)
            }.font(Look.fine).foregroundColor(.hwText)
        }
    }

    private var saved: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch c.saved {
            case .sending: Led(color: .ledAmber, word: "On this Mac · sending", wordColor: .hwText)
            case .onShelf: Led(color: .ledGreen, word: "On your Shelf", wordColor: .hwText)
            case .stuck(let why): Led(color: .ledRed, word: "Not sent · \(why)", wordColor: .hwText)
            }
            Text("“\(c.savedWords)”").font(Look.block).foregroundColor(.paper).lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture { c.another() }
    }
}

/// A click starts listening and the next click saves. Holding a mouse button to talk is
/// hard work, so the mouse gets a toggle and the keyboard gets the hold.
struct MicKey: View {
    @EnvironmentObject var c: Capture

    var body: some View {
        let on = c.listening
        Button { if on { c.finishListening() } else { c.listen(handsFree: true) } } label: {
            Image(systemName: on ? "stop.fill" : "mic.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(on ? .inkText : .hwText)
                .frame(width: 34, height: 34)
                .background(Circle().fill(on ? Color.orange : Color.hwKey))
                .overlay(Circle().stroke(on ? Color.orange : Color.hwMuted, lineWidth: 1.5))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help(on ? "Click to save" : "Click to talk, click again to save")
        .accessibilityLabel(on ? "Finish and save" : "Talk")
    }
}

/// The same light as the menu bar: what is still on this Mac.
struct StatusLed: View {
    @ObservedObject var status = Status.shared
    var body: some View { Led(color: status.color, word: status.word) }
}

enum Pasteboard {
    static func picture() -> (data: Data, mime: String)? {
        let pb = NSPasteboard.general
        if let url = (pb.readObjects(forClasses: [NSURL.self]) as? [URL])?.first(where: { $0.isFileURL }),
           let mime = Config.mime(forFile: url), mime.hasPrefix("image/"), let data = try? Data(contentsOf: url) {
            return (data, mime)
        }
        if pb.string(forType: .string) != nil { return nil }
        return image(pb).map { ($0, "image/png") }
    }

    static func image(_ pb: NSPasteboard) -> Data? {
        if let png = pb.data(forType: .png) { return png }
        if let tiff = pb.data(forType: .tiff), let rep = NSBitmapImageRep(data: tiff) { return rep.representation(using: .png, properties: [:]) }
        return nil
    }
}
