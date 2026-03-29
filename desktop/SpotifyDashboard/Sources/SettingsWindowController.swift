import Cocoa
import WebKit

protocol SettingsDelegate: AnyObject {
    func settingsDidChangeAppMode(menuBarMode: Bool)
    func settingsDidChangeFloatOnTop(enabled: Bool)
}

class SettingsWindowController {

    private var window: NSWindow?
    private let hotkeyManager: HotkeyManager
    private weak var webView: WKWebView?
    weak var delegate: SettingsDelegate?

    private var recorderViews: [DashboardPage: ShortcutRecorderView] = [:]
    private var sidebarRecorderView: ShortcutRecorderView?
    private var floatOnTopToggle: NSSwitch?

    init(hotkeyManager: HotkeyManager, webView: WKWebView?) {
        self.hotkeyManager = hotkeyManager
        self.webView = webView
    }

    func showWindow() {
        if let existing = window, existing.isVisible {
            existing.makeKeyAndOrderFront(nil)
            return
        }

        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 520),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        win.title = "Settings"
        win.level = .floating
        win.isReleasedWhenClosed = false
        win.center()

        let contentView = NSView(frame: win.contentView!.bounds)
        contentView.autoresizingMask = [.width, .height]

        // Dark background to match app aesthetic
        contentView.wantsLayer = true
        contentView.layer?.backgroundColor = NSColor(white: 0.1, alpha: 1.0).cgColor

        buildSettingsUI(in: contentView)

        win.contentView = contentView
        win.makeKeyAndOrderFront(nil)
        self.window = win
    }

    // MARK: - UI Construction

    private func buildSettingsUI(in container: NSView) {
        let padding: CGFloat = 24
        let rowHeight: CGFloat = 36
        var yOffset: CGFloat = container.bounds.height - padding

        // Title
        yOffset -= 28
        let titleLabel = makeLabel("Global Keyboard Shortcuts", size: 16, bold: true)
        titleLabel.frame = NSRect(x: padding, y: yOffset, width: 300, height: 24)
        container.addSubview(titleLabel)

        yOffset -= 8

        // Subtitle
        yOffset -= 18
        let subtitleLabel = makeLabel("Record a shortcut to toggle each page", size: 12, bold: false)
        subtitleLabel.textColor = NSColor.secondaryLabelColor
        subtitleLabel.frame = NSRect(x: padding, y: yOffset, width: 400, height: 16)
        container.addSubview(subtitleLabel)

        yOffset -= 12

        // Shortcut rows for each page
        for page in DashboardPage.allCases {
            yOffset -= rowHeight

            // Label
            let label = makeLabel(page.displayName, size: 14, bold: false)
            label.frame = NSRect(x: padding, y: yOffset + 4, width: 100, height: 22)
            container.addSubview(label)

            // Recorder
            let recorder = ShortcutRecorderView(frame: NSRect(x: 130, y: yOffset + 2, width: 200, height: 28))
            recorder.autoresizingMask = []

            // Load existing binding
            if let binding = hotkeyManager.binding(for: page) {
                recorder.setDisplayString(binding.displayString)
            }

            // Capture page in closure
            let capturedPage = page
            recorder.onShortcutRecorded = { [weak self] keyCode, modifiers, _ in
                self?.hotkeyManager.register(page: capturedPage, keyCode: keyCode, modifiers: modifiers)
            }

            container.addSubview(recorder)
            recorderViews[page] = recorder

            // Clear button
            let clearButton = NSButton(frame: NSRect(x: 345, y: yOffset + 2, width: 60, height: 28))
            clearButton.title = "Clear"
            clearButton.bezelStyle = .rounded
            clearButton.tag = page.hashValue
            clearButton.target = self
            clearButton.action = #selector(clearShortcut(_:))

            // Store page reference via associated object
            objc_setAssociatedObject(clearButton, "page", page.rawValue, .OBJC_ASSOCIATION_RETAIN)

            container.addSubview(clearButton)

            yOffset -= 4
        }

        // Divider line
        yOffset -= 20
        let divider = NSBox(frame: NSRect(x: padding, y: yOffset, width: container.bounds.width - padding * 2, height: 1))
        divider.boxType = .separator
        container.addSubview(divider)

        yOffset -= 16

        // App Mode section
        yOffset -= 24
        let modeTitle = makeLabel("App Mode", size: 16, bold: true)
        modeTitle.frame = NSRect(x: padding, y: yOffset, width: 200, height: 24)
        container.addSubview(modeTitle)

        yOffset -= rowHeight

        // Dock/Menu Bar toggle
        let modeLabel = makeLabel("Run as Menu Bar Utility", size: 14, bold: false)
        modeLabel.frame = NSRect(x: padding, y: yOffset + 4, width: 200, height: 22)
        container.addSubview(modeLabel)

        let toggle = NSSwitch(frame: NSRect(x: 250, y: yOffset + 2, width: 50, height: 28))
        toggle.state = UserDefaults.standard.bool(forKey: "menuBarMode") ? .on : .off
        toggle.target = self
        toggle.action = #selector(toggleAppMode(_:))
        container.addSubview(toggle)

        yOffset -= rowHeight

        // Float on Top toggle
        let floatLabel = makeLabel("Float on Top", size: 14, bold: false)
        floatLabel.frame = NSRect(x: padding, y: yOffset + 4, width: 200, height: 22)
        container.addSubview(floatLabel)

        let floatToggle = NSSwitch(frame: NSRect(x: 250, y: yOffset + 2, width: 50, height: 28))
        let floatDefault = UserDefaults.standard.object(forKey: "floatOnTop") == nil ? true : UserDefaults.standard.bool(forKey: "floatOnTop")
        floatToggle.state = floatDefault ? .on : .off
        floatToggle.target = self
        floatToggle.action = #selector(toggleFloatOnTop(_:))
        container.addSubview(floatToggle)
        self.floatOnTopToggle = floatToggle

        yOffset -= 8

        // Explanation text
        yOffset -= 32
        let explainLabel = makeLabel(
            "Menu Bar mode hides the app from the Dock.\nFloat on Top keeps the window above all others.",
            size: 11,
            bold: false
        )
        explainLabel.textColor = NSColor.tertiaryLabelColor
        explainLabel.maximumNumberOfLines = 2
        explainLabel.frame = NSRect(x: padding, y: yOffset, width: 420, height: 32)
        container.addSubview(explainLabel)

        // ─────────────────────────────────────────
        // Internal Shortcuts section
        // ─────────────────────────────────────────
        yOffset -= 24
        let divider2 = NSBox(frame: NSRect(x: padding, y: yOffset, width: container.bounds.width - padding * 2, height: 1))
        divider2.boxType = .separator
        container.addSubview(divider2)

        yOffset -= 16
        yOffset -= 24
        let internalTitle = makeLabel("Internal Shortcuts", size: 16, bold: true)
        internalTitle.frame = NSRect(x: padding, y: yOffset, width: 300, height: 24)
        container.addSubview(internalTitle)

        yOffset -= 10
        let internalSubtitle = makeLabel("Active only when this window has focus", size: 12, bold: false)
        internalSubtitle.textColor = NSColor.secondaryLabelColor
        internalSubtitle.frame = NSRect(x: padding, y: yOffset, width: 400, height: 16)
        container.addSubview(internalSubtitle)

        yOffset -= 12
        yOffset -= rowHeight

        // Sidebar toggle row
        let sidebarLabel = makeLabel("Toggle Sidebar", size: 14, bold: false)
        sidebarLabel.frame = NSRect(x: padding, y: yOffset + 4, width: 120, height: 22)
        container.addSubview(sidebarLabel)

        let sidebarRecorder = ShortcutRecorderView(frame: NSRect(x: 150, y: yOffset + 2, width: 180, height: 28))
        sidebarRecorder.autoresizingMask = []

        // Load current binding label from localStorage
        updateSidebarRecorderDisplay(sidebarRecorder)

        sidebarRecorder.onShortcutRecorded = { [weak self] keyCode, modifiers, displayString in
            let shortcutData: [String: Any] = [
                "keyCode": Int(keyCode),
                "modifiers": Int(modifiers),
                "displayString": displayString
            ]
            UserDefaults.standard.set(shortcutData, forKey: "internalSidebarShortcut")
            (NSApp.delegate as? AppDelegate)?.loadInternalSidebarShortcut()
        }

        container.addSubview(sidebarRecorder)
        self.sidebarRecorderView = sidebarRecorder

        // Clear button
        let sidebarClearBtn = NSButton(frame: NSRect(x: 345, y: yOffset + 2, width: 60, height: 28))
        sidebarClearBtn.title = "Clear"
        sidebarClearBtn.bezelStyle = .rounded
        sidebarClearBtn.target = self
        sidebarClearBtn.action = #selector(clearSidebarShortcut)
        container.addSubview(sidebarClearBtn)
    }

    /// Refresh the sidebar recorder's display from localStorage
    private func updateSidebarRecorderDisplay(_ recorder: ShortcutRecorderView) {
        if let dict = UserDefaults.standard.dictionary(forKey: "internalSidebarShortcut"),
           let display = dict["displayString"] as? String {
            recorder.setDisplayString(display)
        } else {
            recorder.setDisplayString("\u{2318}S")
        }
    }

    // MARK: - Actions

    @objc private func clearShortcut(_ sender: NSButton) {
        guard let pageStr = objc_getAssociatedObject(sender, "page") as? String,
              let page = DashboardPage(rawValue: pageStr) else { return }

        hotkeyManager.unregister(page: page)
        recorderViews[page]?.clearShortcut()
    }

    @objc private func clearSidebarShortcut() {
        // Reset to default ⌘S
        UserDefaults.standard.removeObject(forKey: "internalSidebarShortcut")
        (NSApp.delegate as? AppDelegate)?.loadInternalSidebarShortcut()
        sidebarRecorderView?.setDisplayString("\u{2318}S")
    }

    @objc private func toggleAppMode(_ sender: NSSwitch) {
        let menuBarMode = sender.state == .on
        UserDefaults.standard.set(menuBarMode, forKey: "menuBarMode")
        delegate?.settingsDidChangeAppMode(menuBarMode: menuBarMode)
    }

    @objc private func toggleFloatOnTop(_ sender: NSSwitch) {
        let enabled = sender.state == .on
        UserDefaults.standard.set(enabled, forKey: "floatOnTop")
        delegate?.settingsDidChangeFloatOnTop(enabled: enabled)
    }

    /// Called externally when the View menu toggle changes, to keep the Settings switch in sync
    func updateFloatOnTopState(_ enabled: Bool) {
        floatOnTopToggle?.state = enabled ? .on : .off
    }

    // MARK: - Helpers

    private func makeLabel(_ text: String, size: CGFloat, bold: Bool) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size)
        label.textColor = NSColor.white
        label.isEditable = false
        label.isSelectable = false
        label.isBordered = false
        label.backgroundColor = .clear
        return label
    }
}
