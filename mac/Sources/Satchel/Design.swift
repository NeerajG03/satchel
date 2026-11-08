import AppKit
import SwiftUI

// Satchel's tokens (design/tokens.css). Hardware is the frame and the keys; paper is
// where the person's words sit. Orange is a fill only on a key that is on.
extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
    static let hw = Color(hex: 0x26231F)
    static let hwKey = Color(hex: 0x332E28)
    static let hwText = Color(hex: 0xEEE7DB)
    static let hwMuted = Color(hex: 0xA79E90)
    static let paper = Color(hex: 0xF4F0E7)
    static let inkText = Color(hex: 0x1F1B17)
    static let muted = Color(hex: 0x6B6257)
    static let orange = Color(hex: 0xE4571E)
    static let ledGreen = Color(hex: 0x3E9E62)
    static let ledAmber = Color(hex: 0xE2A11E)
    static let ledRed = Color(hex: 0xC8442E)
    static let ledOff = Color(hex: 0x6E665C)
    static let onHwRed = Color(hex: 0xFFB4A8)
}

/// Four sizes, two weights. Fonts ship inside the app and are registered for this process only.
enum Look {
    static func register() {
        guard let dir = Bundle.main.resourceURL?.appendingPathComponent("Fonts"),
              let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return }
        for file in files where file.pathExtension == "ttf" {
            CTFontManagerRegisterFontsForURL(file as CFURL, .process, nil)
        }
    }
    static let mark = Font.custom("Caveat", size: 24).weight(.semibold)
    static let block = Font.custom("Newsreader", size: 20)
    static let words = Font.custom("Newsreader", size: 16)
    static let body = Font.custom("Instrument Sans", size: 14)
    static let key = Font.custom("Instrument Sans", size: 14).weight(.semibold)
    static let fine = Font.custom("Instrument Sans", size: 12)
    static let readout = Font.custom("DM Mono", size: 11)
}

/// A light never stands alone: it always sits next to its word.
struct Led: View {
    let color: Color
    let word: String
    var wordColor: Color = .hwMuted
    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(color).frame(width: 8, height: 8)
                .background(Circle().fill(color.opacity(0.35)).frame(width: 16, height: 16))
            Text(word.uppercased()).font(Look.readout).tracking(1).foregroundColor(wordColor)
        }
    }
}

/// A raised key on the hardware: it drops a pixel when pressed.
struct HardwareKeyStyle: ButtonStyle {
    var selected = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(selected ? Look.key : Look.body)
            .foregroundColor(selected ? .inkText : .hwText)
            .padding(.horizontal, 14)
            .frame(height: 34)
            .background(
                RoundedRectangle(cornerRadius: 8).fill(selected ? Color.orange : Color.hwKey)
                    .overlay(alignment: .top) {
                        Rectangle().fill(Color.white.opacity(selected ? 0.2 : 0.07)).frame(height: 1).padding(.horizontal, 6)
                    }
                    .shadow(color: .black.opacity(configuration.isPressed ? 0 : 0.5), radius: 0, y: 1)
            )
            .offset(y: configuration.isPressed ? 1 : 0)
            .contentShape(Rectangle())
    }
}

/// How loud it is, as five bars.
struct Levels: View {
    let level: Float
    var body: some View {
        HStack(alignment: .center, spacing: 3) {
            ForEach(0..<5) { i in
                let on = level * 5 > Float(i)
                RoundedRectangle(cornerRadius: 1).fill(on ? Color.orange : Color.ledOff)
                    .frame(width: 3, height: CGFloat(6 + i * 3))
            }
        }
    }
}

/// A key name drawn as a small key, so a shortcut reads at a glance.
struct Keycap: View {
    let label: String
    var dark = false
    init(_ label: String, dark: Bool = false) { self.label = label; self.dark = dark }
    var body: some View {
        Text(label).font(Look.readout)
            .foregroundColor(dark ? .inkText : .hwText)
            .padding(.horizontal, 6).frame(minWidth: 20, minHeight: 18)
            .background(RoundedRectangle(cornerRadius: 4).stroke(dark ? Color.inkText.opacity(0.5) : Color.hwMuted.opacity(0.6)))
    }
}
