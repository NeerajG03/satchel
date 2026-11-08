import AVFoundation

/// The microphone, only while a key is held or hands-free is on. AAC in an .m4a, like the phone.
final class Recorder {
    private let recorder: AVAudioRecorder
    private let url: URL
    private let started = Date()

    init() throws {
        url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).m4a")
        recorder = try AVAudioRecorder(url: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ])
        recorder.isMeteringEnabled = true
        guard recorder.record() else { throw QueueError("The microphone did not start.") }
    }

    var seconds: Int { Int(Date().timeIntervalSince(started)) }

    /// 0 to 1, for the level bars.
    func level() -> Float {
        recorder.updateMeters()
        return max(0, min(1, (recorder.averagePower(forChannel: 0) + 50) / 50))
    }

    /// The recording, or nil when it was too short to be anything.
    func stop() -> Data? {
        let long = Date().timeIntervalSince(started) >= 0.7
        recorder.stop()
        defer { try? FileManager.default.removeItem(at: url) }
        return long ? try? Data(contentsOf: url) : nil
    }

    func discard() {
        recorder.stop()
        recorder.deleteRecording()
    }

    static var allowed: Bool { AVCaptureDevice.authorizationStatus(for: .audio) == .authorized }

    /// Asks once. Returns whether the microphone can be used now.
    static func ask() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
    }
}
