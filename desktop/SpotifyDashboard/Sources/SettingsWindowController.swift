import Cocoa
import WebKit
import Carbon

/// Sections of the Settings page and their ⌃-letter jump keys (rebindable
/// from the page's SETTINGS card; ⌘, and ⌘` stay fixed).
enum SettingsSection: String, CaseIterable {
    case general, appearance, shortcuts

    var defaultCombo: KeyCombo {
        switch self {
        case .general:    return KeyCombo(keyCode: 5, modifiers: UInt32(controlKey)) // ⌃G
        case .appearance: return KeyCombo(keyCode: 0, modifiers: UInt32(controlKey)) // ⌃A
        case .shortcuts:  return KeyCombo(keyCode: 1, modifiers: UInt32(controlKey)) // ⌃S
        }
    }
}

/// A key combination in the native hotkey layer's vocabulary: Carbon virtual
/// keycode + Carbon modifier mask (the same shape HotkeyManager registers).
struct KeyCombo: Codable, Equatable {
    let keyCode: UInt32
    let modifiers: UInt32
}

protocol SettingsDelegate: AnyObject {
    func settingsDidChangeAppMode(menuBarMode: Bool)
    func settingsDidChangeFloatOnTop(enabled: Bool)
    func settingsDidChangeTheme(_ theme: String)
    func settingsDidChangeGridShortcuts()
    func settingsDidChangeSidebarShortcut()
}

/// The ONE settings surface. A resizable, frame-persisting window hosting
/// the dashboard's own /settings page (served by the Flask backend, styled
/// like the rest of the app). Preferences that live natively — global
/// hotkeys, app mode, float-on-top, the sidebar and section shortcuts —
/// round-trip through the `settings` script-message bridge; the grid
/// shortcuts and theme are shared with the dashboard through localStorage
/// (same origin, same website data store).
final class SettingsWindowController: NSObject {

    private let hotkeyManager: HotkeyManager
    weak var delegate: SettingsDelegate?

    private var window: NSWindow?
    private var webView: WKWebView?
    private var pageReady = false
    private var pendingSection: SettingsSection?

    /// True while a recorder on the page is capturing — the app-level key
    /// monitor lets every combo through to the page in that state.
    private(set) var isRecording = false

    private(set) var sectionShortcuts: [SettingsSection: KeyCombo] = [:]
    private static let sectionDefaultsKey = "settingsSectionShortcuts"
    private static let frameAutosaveName = "SettingsWindow"
    private let pageURL = URL(string: "http://127.0.0.1:8888/settings")!

    init(hotkeyManager: HotkeyManager) {
        self.hotkeyManager = hotkeyManager
        super.init()
        loadSectionShortcuts()
    }

    var isVisible: Bool { window?.isVisible ?? false }

    // MARK: - Show / hide

    func show(section: SettingsSection? = nil) {
        let win = window ?? makeWindow()
        applyChrome()
        if let section = section {
            if pageReady {
                evaluate("SettingsPage.showSection('\(section.rawValue)')")
            } else {
                pendingSection = section
            }
        }
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func toggle() {
        if isVisible { close() } else { show() }
    }

    /// Hides rather than destroys, so ⌘` brings it straight back.
    func close() {
        window?.orderOut(nil)
    }

    // MARK: - Section shortcuts (⌃G / ⌃A / ⌃S by default)

    func matchSection(keyCode: UInt32, carbonModifiers: UInt32) -> SettingsSection? {
        for (section, combo) in sectionShortcuts
        where combo.keyCode == keyCode && combo.modifiers == carbonModifiers {
            return section
        }
        return nil
    }

    private func loadSectionShortcuts() {
        var loaded: [SettingsSection: KeyCombo] = [:]
        if let data = UserDefaults.standard.data(forKey: Self.sectionDefaultsKey),
           let stored = try? JSONDecoder().decode([String: KeyCombo].self, from: data) {
            for (key, combo) in stored {
                if let section = SettingsSection(rawValue: key) { loaded[section] = combo }
            }
        }
        for section in SettingsSection.allCases where loaded[section] == nil {
            loaded[section] = section.defaultCombo
        }
        sectionShortcuts = loaded
    }

    private func saveSectionShortcuts() {
        var out: [String: KeyCombo] = [:]
        for (section, combo) in sectionShortcuts { out[section.rawValue] = combo }
        if let data = try? JSONEncoder().encode(out) {
            UserDefaults.standard.set(data, forKey: Self.sectionDefaultsKey)
        }
    }

    // MARK: - Keeping the page in sync with changes made elsewhere

    func noteFloatOnTop(_ enabled: Bool) { push(["floatOnTop": enabled]) }
    func noteMenuBarMode(_ enabled: Bool) { push(["menuBarMode": enabled]) }
    func noteTheme(_ theme: String) {
        applyChrome()
        push(["theme": theme])
    }

    // MARK: - Window

    private func makeWindow() -> NSWindow {
        // Default: most of the screen, so sections need little or no scrolling.
        // A saved frame (setFrameAutosaveName) overrides this on later runs.
        let screen = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let w = floor(screen.width * 0.78)
        let h = floor(screen.height * 0.84)
        let rect = NSRect(x: screen.midX - w / 2, y: screen.midY - h / 2, width: w, height: h)

        let win = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        win.title = "Settings"
        win.minSize = NSSize(width: 840, height: 560)
        win.isReleasedWhenClosed = false
        win.level = .floating // the dashboard itself may float; Settings sits above it
        win.titlebarAppearsTransparent = true
        win.delegate = self
        win.setFrameAutosaveName(Self.frameAutosaveName)

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.userContentController.add(self, name: "settings")
        config.userContentController.addUserScript(WKUserScript(
            source: "window.__nativeApp = true;",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        let wv = WKWebView(frame: win.contentView!.bounds, configuration: config)
        wv.autoresizingMask = [.width, .height]
        wv.setValue(false, forKey: "drawsBackground")
        wv.navigationDelegate = self
        win.contentView?.addSubview(wv)
        wv.load(URLRequest(url: pageURL))

        webView = wv
        window = win
        return win
    }

    private var currentTheme: String {
        UserDefaults.standard.string(forKey: "dashTheme") ?? "dark"
    }

    /// Window background + appearance follow the dashboard theme so the
    /// title bar and any pre-paint frame match the page instead of flashing.
    private func applyChrome() {
        guard let win = window else { return }
        let light = currentTheme == "light"
        win.backgroundColor = light
            ? NSColor(red: 0.933, green: 0.941, blue: 0.910, alpha: 1) // #eef0e8
            : NSColor(red: 0.039, green: 0.039, blue: 0.039, alpha: 1) // #0a0a0a
        win.appearance = NSAppearance(named: light ? .aqua : .darkAqua)
    }

    // MARK: - Bridge → page

    private func evaluate(_ js: String) {
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    private func push(_ partial: [String: Any]) {
        guard pageReady, let json = jsonString(partial) else { return }
        evaluate("window.SettingsPage && SettingsPage.update(\(json))")
    }

    private func pushFullState() {
        var hotkeys: [String: Any] = [:]
        for page in DashboardPage.allCases {
            if let b = hotkeyManager.binding(for: page) {
                hotkeys[page.rawValue] = ["keyCode": b.keyCode, "modifiers": b.modifiers]
            } else {
                hotkeys[page.rawValue] = NSNull()
            }
        }

        var sidebar: [String: Any] = ["keyCode": 1, "modifiers": Int(cmdKey)]
        if let dict = UserDefaults.standard.dictionary(forKey: "internalSidebarShortcut"),
           let kc = dict["keyCode"] as? NSNumber, let mods = dict["modifiers"] as? NSNumber {
            sidebar = ["keyCode": kc.intValue, "modifiers": mods.intValue]
        }

        var sections: [String: Any] = [:]
        for (section, combo) in sectionShortcuts {
            sections[section.rawValue] = ["keyCode": combo.keyCode, "modifiers": combo.modifiers]
        }

        let defaults = UserDefaults.standard
        let state: [String: Any] = [
            "menuBarMode": defaults.bool(forKey: "menuBarMode"),
            "floatOnTop": defaults.object(forKey: "floatOnTop") == nil ? true : defaults.bool(forKey: "floatOnTop"),
            "hotkeys": hotkeys,
            "sidebar": sidebar,
            "sections": sections,
            "theme": currentTheme,
        ]
        if let json = jsonString(state) {
            evaluate("window.SettingsPage && SettingsPage.setState(\(json))")
        }
    }

    private func jsonString(_ object: [String: Any]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func uint32(_ value: Any?) -> UInt32? {
        (value as? NSNumber)?.uint32Value
    }
}

// MARK: - Bridge ← page

extension SettingsWindowController: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        let clear = (body["clear"] as? Bool) == true

        switch type {
        case "ready":
            pageReady = true
            pushFullState()
            if let section = pendingSection {
                pendingSection = nil
                evaluate("SettingsPage.showSection('\(section.rawValue)')")
            }

        case "set":
            guard let key = body["key"] as? String, let value = body["value"] as? Bool else { return }
            switch key {
            case "menuBarMode":
                UserDefaults.standard.set(value, forKey: "menuBarMode")
                delegate?.settingsDidChangeAppMode(menuBarMode: value)
            case "floatOnTop":
                UserDefaults.standard.set(value, forKey: "floatOnTop")
                delegate?.settingsDidChangeFloatOnTop(enabled: value)
            default:
                break
            }

        case "hotkey":
            guard let pageStr = body["page"] as? String,
                  let page = DashboardPage(rawValue: pageStr) else { return }
            if clear {
                hotkeyManager.unregister(page: page)
            } else if let kc = uint32(body["keyCode"]), let mods = uint32(body["modifiers"]) {
                hotkeyManager.register(page: page, keyCode: kc, modifiers: mods)
            }

        case "sidebarShortcut":
            if clear {
                UserDefaults.standard.removeObject(forKey: "internalSidebarShortcut")
            } else if let kc = uint32(body["keyCode"]), let mods = uint32(body["modifiers"]) {
                UserDefaults.standard.set([
                    "keyCode": Int(kc),
                    "modifiers": Int(mods),
                    "displayString": (body["display"] as? String) ?? "",
                ], forKey: "internalSidebarShortcut")
            }
            delegate?.settingsDidChangeSidebarShortcut()

        case "sectionShortcut":
            guard let sectionStr = body["section"] as? String,
                  let section = SettingsSection(rawValue: sectionStr) else { return }
            if clear {
                sectionShortcuts[section] = section.defaultCombo
            } else if let kc = uint32(body["keyCode"]), let mods = uint32(body["modifiers"]) {
                sectionShortcuts[section] = KeyCombo(keyCode: kc, modifiers: mods)
            }
            saveSectionShortcuts()

        case "gridShortcutsChanged":
            delegate?.settingsDidChangeGridShortcuts()

        case "theme":
            if let theme = body["theme"] as? String {
                UserDefaults.standard.set(theme, forKey: "dashTheme")
                applyChrome()
                delegate?.settingsDidChangeTheme(theme)
            }

        case "recording":
            isRecording = (body["active"] as? Bool) ?? false

        case "close":
            close()

        default:
            break
        }
    }
}

// MARK: - NSWindowDelegate

extension SettingsWindowController: NSWindowDelegate {
    /// The red button hides the window (the page stays loaded, so the next
    /// ⌘, / ⌘` is instant). The app never quits from here.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        close()
        return false
    }
}

// MARK: - WKNavigationDelegate

extension SettingsWindowController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        if nsError.code == NSURLErrorCancelled { return }
        // Backend still warming up — try again shortly.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self = self else { return }
            self.webView?.load(URLRequest(url: self.pageURL))
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        pageReady = false
    }
}
