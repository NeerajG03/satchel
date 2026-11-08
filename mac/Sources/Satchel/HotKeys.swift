import Carbon

/// System-wide keys through Carbon's hot key API: it reports both press and release,
/// which hold-to-talk needs, and it asks for no Accessibility permission.
final class HotKeys {
    static let shared = HotKeys()
    static let space: UInt32 = 49
    static let escape: UInt32 = 53

    private var handlers: [UInt32: (Bool) -> Void] = [:]
    private var refs: [UInt32: EventHotKeyRef] = [:]
    private var installed = false

    /// `handler` gets true on press and false on release.
    func register(id: UInt32, key: UInt32, modifiers: UInt32, _ handler: @escaping (Bool) -> Void) {
        install()
        unregister(id: id)
        var ref: EventHotKeyRef?
        let hotKeyID = EventHotKeyID(signature: OSType(0x5354_4348), id: id)
        guard RegisterEventHotKey(key, modifiers, hotKeyID, GetApplicationEventTarget(), 0, &ref) == noErr, let ref else { return }
        refs[id] = ref
        handlers[id] = handler
    }

    func unregister(id: UInt32) {
        if let ref = refs.removeValue(forKey: id) { UnregisterEventHotKey(ref) }
        handlers[id] = nil
    }

    private func install() {
        guard !installed else { return }
        installed = true
        var types = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var hotKey = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &hotKey)
            let pressed = GetEventKind(event) == UInt32(kEventHotKeyPressed)
            HotKeys.shared.handlers[hotKey.id]?(pressed)
            return noErr
        }, types.count, &types, nil, nil)
    }
}
