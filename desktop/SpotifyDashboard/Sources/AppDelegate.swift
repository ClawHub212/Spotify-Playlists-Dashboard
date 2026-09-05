import Cocoa
import WebKit

/// The name the user sees (window title, app menu). Read from CFBundleName so a
/// rename is a plist-only change — v1 became "Spotify Dashboard (old)" on 09-05-26.
let appDisplayName = (Bundle.main.infoDictionary?["CFBundleName"] as? String) ?? "Spotify Dashboard (old)"

class AppDelegate: NSObject, NSApplicationDelegate {

    // MARK: - Properties
    var mainWindow: NSWindow!
    var webViewController: MainWindowController!
    var settingsWindowController: SettingsWindowController!
    var statusBarController: StatusBarController?
    var backendManager: BackendManager!
    var hotkeyManager: HotkeyManager!
    var loadingViewController: LoadingViewController?
    var missingFilesViewController: MissingFilesViewController?
    var authRequiredViewController: AuthRequiredViewController?
    private var aboutWindow: NSWindow?

    // Internal shortcut state (default Cmd+S: keyCode 1, modifiers 256)
    var internalSidebarKeyCode: UInt32 = 1
    var internalSidebarModifiers: UInt32 = 256

    // Tracks the page the user actually wants when the app is cold-launched.
    // If an AppleScript "show page X" arrives before the backend is ready,
    // we stash it here and the auth-ready handler will load X instead of the
    // default. Set to nil once the initial page has loaded.
    private var pendingInitialPage: DashboardPage?
    private var hasLoadedInitialPage = false

    // Keep the dispatch signal sources alive for the app's lifetime.
    private var terminationSignalSources: [DispatchSourceSignal] = []

    private var versionMenuController: VersionMenuController?
    private var themesMenu: NSMenu?

    /// "dark" (Phosphor) or "light" (Daybreak) — mirrored from the page's
    /// localStorage through the `dashboard` script-message bridge.
    private var currentTheme: String {
        get { UserDefaults.standard.string(forKey: "dashTheme") ?? "dark" }
        set { UserDefaults.standard.set(newValue, forKey: "dashTheme") }
    }

    // Set by a launcher that must not steal focus (scripts/dashboard-open.sh
    // --background, tooling that relaunches the app while you work elsewhere).
    // One-shot: only the launch-time window show is silent — everything the
    // user triggers afterwards activates normally.
    private var isBackgroundLaunch =
        ProcessInfo.processInfo.environment["SPOTIFY_DASHBOARD_BACKGROUND_LAUNCH"] != nil

    private var isMenuBarMode: Bool {
        get { UserDefaults.standard.bool(forKey: "menuBarMode") }
        set { UserDefaults.standard.set(newValue, forKey: "menuBarMode") }
    }

    private var isFloatOnTop: Bool {
        get {
            // Default to false if never set
            if UserDefaults.standard.object(forKey: "floatOnTop") == nil { return false }
            return UserDefaults.standard.bool(forKey: "floatOnTop")
        }
        set { UserDefaults.standard.set(newValue, forKey: "floatOnTop") }
    }

    // MARK: - Loader diagnostics

    /// Append a timestamped line to <projectRoot>/loader-debug.log (gitignored
    /// via *.log). The loading-screen flow has repeatedly failed in ways that
    /// are invisible after the fact — this file records which dismissal path
    /// fired and what the readiness flags said, so a "skeleton after the
    /// loader" report can be diagnosed from disk instead of guesswork.
    private func loaderLog(_ message: String) {
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        let line = "\(df.string(from: Date())) \(message)\n"
        guard let root = backendManager?.projectRoot,
              let data = line.data(using: .utf8) else { return }
        let url = URL(fileURLWithPath: root).appendingPathComponent("loader-debug.log")
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: url)
        }
    }

    // MARK: - Application Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        backendManager = BackendManager()

        // SIGTERM (pkill, shutdown) and SIGINT (Ctrl-C in a dev shell) bypass
        // applicationWillTerminate, which would orphan the Flask child on the
        // port with stale code. Catch them and stop the backend before exiting.
        installTerminationSignalHandlers()

        // Create and show the main window first so any preflight error is
        // shown inside the app rather than as an external dialog.
        createMainWindow()
        showWindowOnCurrentScreen()
        buildMenu()

        // Preflight: if required files are missing, show an in-window error
        // and stop here — the Flask backend would otherwise hang silently.
        let missing = backendManager.checkRequiredFiles()
        if !missing.isEmpty, let contentView = mainWindow.contentView {
            missingFilesViewController = MissingFilesViewController(
                parentView: contentView,
                missing: missing,
                projectRoot: backendManager.projectRoot
            )
            return
        }

        backendManager.start()

        if let contentView = mainWindow.contentView {
            loadingViewController = LoadingViewController(parentView: contentView)
        }

        // Create the web view controller (adds WebView behind the loading screen)
        webViewController = MainWindowController(window: mainWindow)

        // Set up hotkey manager
        hotkeyManager = HotkeyManager()
        hotkeyManager.delegate = self
        hotkeyManager.loadAndRegisterAll()

        // Set up settings window controller
        settingsWindowController = SettingsWindowController(hotkeyManager: hotkeyManager)
        settingsWindowController.delegate = self

        // The dashboard page reports theme changes (its own toggle, ⇧⌘L) so
        // the Themes menu check and the Settings window follow.
        webViewController.webView.configuration.userContentController.add(self, name: "dashboard")

        // Apply Dock/Menu Bar mode
        applyAppMode()

        // Wait for backend to be ready with progress reporting.
        // Backend readiness only fills the ring to 60% — the remainder is
        // filled while waiting for the current track to render, so the ring
        // completing coincides with the track actually being on screen.
        // Read the env var directly — isBackgroundLaunch is one-shot and was
        // already consumed by showWindowOnCurrentScreen() above.
        let bgEnv = ProcessInfo.processInfo.environment["SPOTIFY_DASHBOARD_BACKGROUND_LAUNCH"] != nil
        loaderLog("launch: loading screen up (backgroundLaunch=\(bgEnv))")
        backendManager.waitForReady(progress: { [weak self] progress in
            DispatchQueue.main.async {
                self?.loadingViewController?.setProgress(CGFloat(progress) * 0.6)
            }
        }) { [weak self] in
            DispatchQueue.main.async {
                self?.loaderLog("backend ready — checking auth")
                self?.checkAuthAndProceed()
            }
        }

        loadInternalSidebarShortcut()

        // App-level shortcuts. A local monitor rather than menu key
        // equivalents alone: the web view is almost always first responder
        // and eats key equivalents before the menu bar sees them.
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self else { return event }
            let flags = event.modifierFlags.intersection([.command, .option, .control, .shift])
            let carbonMods = HotkeyManager.cocoaToCarbonModifiers(flags)
            let chars = event.charactersIgnoringModifiers ?? ""
            let keyCode = UInt32(event.keyCode)

            // A Settings recorder is capturing: every combo belongs to it.
            if self.settingsWindowController.isRecording { return event }

            // Settings — ⌘, opens, ⌘` toggles. Fixed; everything else is rebindable.
            if flags == [.command] && chars == "," {
                self.openSettings()
                return nil
            }
            if flags == [.command] && chars == "`" {
                self.settingsWindowController.toggle()
                return nil
            }
            // ⌃G / ⌃A / ⌃S (rebindable) jump straight to a Settings section
            if let section = self.settingsWindowController.matchSection(keyCode: keyCode, carbonModifiers: carbonMods) {
                self.settingsWindowController.show(section: section)
                return nil
            }

            // Sidebar toggle belongs to the dashboard window only — not to
            // Settings or any other window that happens to be key.
            if event.window == self.mainWindow
                && keyCode == self.internalSidebarKeyCode && carbonMods == self.internalSidebarModifiers {
                self.webViewController.webView.evaluateJavaScript("toggleSidebar()", completionHandler: nil)
                return nil // Swallow event
            }
            return event
        }
    }

    func loadInternalSidebarShortcut() {
        if let dict = UserDefaults.standard.dictionary(forKey: "internalSidebarShortcut") {
            if let kc = dict["keyCode"] as? NSNumber { self.internalSidebarKeyCode = kc.uint32Value }
            if let mods = dict["modifiers"] as? NSNumber { self.internalSidebarModifiers = mods.uint32Value }
        } else {
            // Default ⌘S
            self.internalSidebarKeyCode = 1
            self.internalSidebarModifiers = 256
        }
    }

    // MARK: - Auth gating

    /// Check whether the Flask backend reports a valid Spotify token.
    /// If yes → load dashboard. If no → show in-app auth panel.
    private func checkAuthAndProceed() {
        guard let url = URL(string: "http://127.0.0.1:8888/api/auth-status") else {
            self.loadDashboardAfterAuth()
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 3.0

        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self = self else { return }

            var authenticated = false
            if let data = data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let value = json["authenticated"] as? Bool {
                authenticated = value
            }

            DispatchQueue.main.async {
                if authenticated {
                    self.loadDashboardAfterAuth()
                } else {
                    self.showAuthPanel()
                }
            }
        }.resume()
    }

    private func showAuthPanel() {
        loaderLog("dismissing loading screen: auth panel path")
        // Dismiss loading screen first
        loadingViewController?.dismiss { [weak self] in
            self?.loadingViewController = nil
        }

        guard let contentView = mainWindow.contentView else { return }
        authRequiredViewController = AuthRequiredViewController(parentView: contentView) { [weak self] in
            self?.authRequiredViewController = nil
            self?.loadDashboardAfterAuth()
        }
    }

    private func loadDashboardAfterAuth() {
        let initialPage = pendingInitialPage ?? .playlists
        pendingInitialPage = nil
        hasLoadedInitialPage = true
        loaderLog("auth ok — loading page '\(initialPage.rawValue)', polling readiness flags")
        webViewController.loadPage(initialPage)

        // Poll the WebView until the page is genuinely ready: script.js sets
        // window.__trackReady once the header shows the track (or a settled
        // "nothing playing"), and window.__gridReady once the real playlist
        // tiles have rendered (not the skeleton placeholders). Waiting for
        // both means the loading screen lifts onto a finished page — no
        // second "playlist loading" animation after the loader (08-28-26).
        // __gridReady is compared against `false` (not `=== true`) so a
        // frontend that predates the flag (undefined) doesn't stall the
        // loader until the cap — it just falls back to the track-only gate.
        let maxAttempts = 150  // 150 × 0.2s = 30s safety cap
        func checkWebViewReady(attemptsLeft: Int) {
            guard attemptsLeft > 0 else {
                self.loaderLog("dismissing loading screen: CAP hit after \(Int(Double(maxAttempts) * 0.2))s — page never reported ready")
                self.loadingViewController?.dismiss { [weak self] in
                    self?.loadingViewController = nil
                }
                return
            }

            // Creep the ring from 60% toward 95% while we wait for the track
            let waited = CGFloat(maxAttempts - attemptsLeft) / CGFloat(maxAttempts)
            self.loadingViewController?.setProgress(0.6 + 0.35 * waited)

            let js = "'' + (window.__trackReady === true) + '|' + (window.__gridReady !== false)"
            self.webViewController.webView.evaluateJavaScript(js) { [weak self] (result, _) in
                let parts = (result as? String)?.split(separator: "|").map(String.init) ?? []
                let trackReady = parts.first == "true"
                let gridReady = parts.count > 1 && parts[1] == "true"
                let attempt = maxAttempts - attemptsLeft + 1
                if trackReady && gridReady {
                    self?.loaderLog("dismissing loading screen: page ready after \(String(format: "%.1f", Double(attempt) * 0.2))s")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                        self?.loadingViewController?.dismiss {
                            self?.loadingViewController = nil
                        }
                    }
                } else {
                    if attempt % 25 == 0 {  // every ~5s while waiting
                        self?.loaderLog("still waiting at \(Int(Double(attempt) * 0.2))s: trackReady=\(trackReady) gridReady=\(gridReady) rawResult=\(result.map(String.init(describing:)) ?? "nil")")
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                        checkWebViewReady(attemptsLeft: attemptsLeft - 1)
                    }
                }
            }
        }
        checkWebViewReady(attemptsLeft: maxAttempts)
    }

    func applicationWillTerminate(_ notification: Notification) {
        hotkeyManager?.unregisterAll()
        backendManager?.stop()
    }

    private func installTerminationSignalHandlers() {
        for sig in [SIGTERM, SIGINT] {
            // Ignore the default disposition so the dispatch source gets it.
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in
                print("[AppDelegate] Caught termination signal; stopping backend")
                self?.hotkeyManager?.unregisterAll()
                self?.backendManager?.stop()  // blocks until the child is dead
                exit(0)
            }
            source.resume()
            terminationSignalSources.append(source)
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows {
            showWindowOnCurrentScreen()
        }
        return true
    }

    // MARK: - Window Creation

    private func createMainWindow() {
        // Fill the entire visible screen area on launch
        let screenFrame = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        let styleMask: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable]

        mainWindow = NSWindow(
            contentRect: screenFrame,
            styleMask: styleMask,
            backing: .buffered,
            defer: false
        )

        mainWindow.title = appDisplayName
        mainWindow.level = isFloatOnTop ? .floating : .normal
        mainWindow.isReleasedWhenClosed = false
        mainWindow.delegate = self
        mainWindow.titlebarAppearsTransparent = true
        mainWindow.titleVisibility = .hidden
        mainWindow.backgroundColor = NSColor(red: 0.07, green: 0.07, blue: 0.07, alpha: 1.0)

        // Allow fullscreen via the green traffic-light button
        mainWindow.collectionBehavior = [.fullScreenPrimary]

        // Minimum reasonable size, no maximum cap
        mainWindow.minSize = NSSize(width: 800, height: 500)

    }

    // MARK: - Window Show/Hide

    func showWindowOnCurrentScreen() {
        // Fill the entire visible area of the current monitor
        if let screen = NSScreen.main ?? NSScreen.screens.first {
            mainWindow.setFrame(screen.visibleFrame, display: true)
        }

        if isBackgroundLaunch {
            isBackgroundLaunch = false
            // Order in behind whatever the user is working in — skipping
            // activate alone still leaves the window covering the front app.
            mainWindow.orderBack(nil)
            return
        }

        mainWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func hideWindow() {
        mainWindow.orderOut(nil)
    }

    func toggleWindow() {
        if mainWindow.isVisible {
            hideWindow()
        } else {
            showWindowOnCurrentScreen()
        }
    }

    /// Show the window and navigate to a specific page.
    /// Skips reloading the WebView if the window is already visible on this page —
    /// so re-running an AppleScript / hotkey for the active page is a no-op
    /// (just keeps the window front) instead of a full reload.
    /// If the app is cold-launched and the backend isn't ready yet, the page
    /// is stashed and loaded once auth completes (avoiding a flash to Playlists).
    func showPage(_ page: DashboardPage) {
        if !hasLoadedInitialPage {
            pendingInitialPage = page
            showWindowOnCurrentScreen()
            return
        }
        let alreadyShowing = mainWindow.isVisible && webViewController.currentPage == page
        if !alreadyShowing {
            webViewController.loadPage(page)
        }
        showWindowOnCurrentScreen()
    }

    /// Toggle visibility; if showing, navigate to a specific page
    func togglePage(_ page: DashboardPage) {
        if mainWindow.isVisible {
            // If already on this page, hide. Otherwise navigate.
            if webViewController.currentPage == page {
                hideWindow()
            } else {
                webViewController.loadPage(page)
            }
        } else {
            webViewController.loadPage(page)
            showWindowOnCurrentScreen()
        }
    }

    // MARK: - App Mode (Dock vs Menu Bar)

    func applyAppMode() {
        if isMenuBarMode {
            NSApp.setActivationPolicy(.accessory)
            if statusBarController == nil {
                statusBarController = StatusBarController()
                statusBarController?.delegate = self
            }
        } else {
            NSApp.setActivationPolicy(.regular)
            statusBarController?.remove()
            statusBarController = nil
        }
    }

    func setFloatOnTop(_ enabled: Bool) {
        isFloatOnTop = enabled
        mainWindow.level = enabled ? .floating : .normal
    }

    func setMenuBarMode(_ enabled: Bool) {
        isMenuBarMode = enabled
        applyAppMode()
        if enabled {
            // When switching to menu bar mode, make sure window stays accessible
            showWindowOnCurrentScreen()
        }
    }

    // MARK: - Menu

    private func buildMenu() {
        let mainMenu = NSMenu()

        // App menu
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        let aboutItem = NSMenuItem(title: "About \(appDisplayName)",
                                   action: #selector(showAboutPanel),
                                   keyEquivalent: "")
        aboutItem.target = self
        appMenu.addItem(aboutItem)
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Settings...", action: #selector(openSettings), keyEquivalent: ",")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Hide \(appDisplayName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit \(appDisplayName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // Edit menu — required for text input to behave like a Mac app.
        // Without it AppKit gives the web view no editing key equivalents, so
        // ⌘X/⌘C/⌘V/⌘A and ⌃⌘Space (Emoji & Symbols) all did nothing inside the
        // playlist editor's fields — which is why emoji couldn't be typed or
        // pasted into a display name. Actions dispatch through the responder
        // chain (target = nil), so WKWebView handles them for the focused field.
        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redoItem = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redoItem.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(redoItem)
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: Selector(("cut:")), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: Selector(("copy:")), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: Selector(("paste:")), keyEquivalent: "v")
        let pasteMatchItem = NSMenuItem(title: "Paste and Match Style",
                                        action: Selector(("pasteAsPlainText:")),
                                        keyEquivalent: "v")
        pasteMatchItem.keyEquivalentModifierMask = [.command, .option, .shift]
        editMenu.addItem(pasteMatchItem)
        editMenu.addItem(withTitle: "Delete", action: Selector(("delete:")), keyEquivalent: "")
        editMenu.addItem(withTitle: "Select All", action: Selector(("selectAll:")), keyEquivalent: "a")
        editMenu.addItem(NSMenuItem.separator())
        // Added explicitly (and AppKit's automatic copy suppressed in Info.plist
        // via NSDisabledCharacterPaletteMenuItem) so the palette is always there.
        let emojiItem = NSMenuItem(title: "Emoji & Symbols",
                                   action: #selector(NSApplication.orderFrontCharacterPalette(_:)),
                                   keyEquivalent: " ")
        emojiItem.keyEquivalentModifierMask = [.control, .command]
        editMenu.addItem(emojiItem)
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        // View menu
        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Playlists", action: #selector(navigateToPlaylists), keyEquivalent: "1")
        viewMenu.addItem(withTitle: "Tracker", action: #selector(navigateToTracker), keyEquivalent: "2")
        viewMenu.addItem(withTitle: "Queue", action: #selector(navigateToQueue), keyEquivalent: "3")
        viewMenu.addItem(NSMenuItem.separator())
        viewMenu.addItem(withTitle: "Reload Page", action: #selector(reloadPage), keyEquivalent: "r")
        viewMenu.addItem(NSMenuItem.separator())
        let zoomInItem = NSMenuItem(title: "Zoom In", action: #selector(zoomIn), keyEquivalent: "+")
        zoomInItem.keyEquivalentModifierMask = [.command]
        viewMenu.addItem(zoomInItem)
        // Also allow ⌘= (unshifted plus key)
        let zoomInAlt = NSMenuItem(title: "Zoom In", action: #selector(zoomIn), keyEquivalent: "=")
        zoomInAlt.keyEquivalentModifierMask = [.command]
        zoomInAlt.isAlternate = true
        viewMenu.addItem(zoomInAlt)
        viewMenu.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        viewMenu.addItem(withTitle: "Actual Size", action: #selector(resetZoom), keyEquivalent: "0")
        viewMenu.addItem(NSMenuItem.separator())
        let floatItem = NSMenuItem(title: "Float on Top", action: #selector(toggleFloatOnTop(_:)), keyEquivalent: "")
        floatItem.state = isFloatOnTop ? .on : .off
        viewMenu.addItem(floatItem)
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        // Themes menu — flat, single-select, each row says whether it is a
        // light or a dark theme; rebuilt on open so the ✓ is always current.
        let themesMenuItem = NSMenuItem()
        let themes = NSMenu(title: "Themes")
        themes.delegate = self
        themesMenuItem.submenu = themes
        mainMenu.addItem(themesMenuItem)
        themesMenu = themes
        rebuildThemesMenu()

        // Window menu
        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)

        // Version menu — which checkout this window is actually serving, and how
        // recently that code changed. Last in the bar so it reads as status.
        versionMenuController = VersionMenuController(projectRoot: backendManager.projectRoot)
        mainMenu.addItem(versionMenuController!.menuItem)

        NSApp.mainMenu = mainMenu
    }

    @objc func openSettings() {
        settingsWindowController.show()
    }

    // MARK: - Themes

    private static let themeRows: [(id: String, name: String, symbol: String)] = [
        ("dark", "Phosphor", "moon.fill"),
        ("light", "Daybreak", "sun.max.fill"),
    ]

    private func rebuildThemesMenu() {
        guard let menu = themesMenu else { return }
        menu.removeAllItems()
        let theme = currentTheme
        let toLight = theme == "dark"

        let switchItem = NSMenuItem(
            title: toLight ? "Switch to Light Appearance" : "Switch to Dark Appearance",
            action: #selector(toggleThemeFromMenu),
            keyEquivalent: "l"
        )
        switchItem.keyEquivalentModifierMask = [.command, .shift]
        switchItem.target = self
        switchItem.image = NSImage(systemSymbolName: toLight ? "sun.max.fill" : "moon.fill", accessibilityDescription: nil)
        menu.addItem(switchItem)
        menu.addItem(NSMenuItem.separator())

        for row in Self.themeRows {
            let item = NSMenuItem(title: row.name, action: #selector(selectTheme(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = row.id
            item.image = NSImage(systemSymbolName: row.symbol, accessibilityDescription: row.id == "dark" ? "Dark theme" : "Light theme")
            item.state = row.id == theme ? .on : .off
            menu.addItem(item)
        }
    }

    /// Apply a theme everywhere: the dashboard page (which persists it in
    /// localStorage and reports back), the Settings window, and our mirror.
    func setTheme(_ theme: String, fromDashboard: Bool = false) {
        let normalized = theme == "light" ? "light" : "dark"
        currentTheme = normalized
        if !fromDashboard {
            webViewController.webView.evaluateJavaScript(
                "typeof applyTheme === 'function' && applyTheme('\(normalized)')",
                completionHandler: nil
            )
        }
        settingsWindowController.noteTheme(normalized)
    }

    @objc private func toggleThemeFromMenu() {
        setTheme(currentTheme == "dark" ? "light" : "dark")
    }

    @objc private func selectTheme(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        setTheme(id)
    }

    @objc func showAboutPanel() {
        if aboutWindow == nil {
            aboutWindow = buildAboutWindow()
        }
        aboutWindow?.center()
        NSApp.activate(ignoringOtherApps: true)
        aboutWindow?.makeKeyAndOrderFront(nil)
    }

    private func buildAboutWindow() -> NSWindow {
        let info = Bundle.main.infoDictionary ?? [:]
        let appName = (info["CFBundleName"] as? String) ?? appDisplayName
        let shortVersion = info["CFBundleShortVersionString"] as? String ?? ""
        let displayVersion = (info["SpotifyDashboardVersionDisplay"] as? String)
            ?? (info["CFBundleVersion"] as? String ?? "")
        let commitURL = info["SpotifyDashboardVersionCommitURL"] as? String

        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 520),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        win.title = "About \(appName)"
        win.isReleasedWhenClosed = false
        win.titlebarAppearsTransparent = true

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 20
        stack.edgeInsets = NSEdgeInsets(top: 48, left: 48, bottom: 48, right: 48)
        stack.translatesAutoresizingMaskIntoConstraints = false

        let iconView = NSImageView()
        iconView.image = NSApp.applicationIconImage
        iconView.imageScaling = .scaleProportionallyUpOrDown
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.widthAnchor.constraint(equalToConstant: 192).isActive = true
        iconView.heightAnchor.constraint(equalToConstant: 192).isActive = true
        stack.addArrangedSubview(iconView)

        let nameLabel = NSTextField(labelWithString: appName)
        nameLabel.font = NSFont.systemFont(ofSize: 32, weight: .bold)
        nameLabel.alignment = .center
        stack.addArrangedSubview(nameLabel)

        let versionLabel = NSTextField(labelWithString: "Version \(shortVersion)")
        versionLabel.font = NSFont.systemFont(ofSize: 22, weight: .medium)
        versionLabel.textColor = .labelColor
        versionLabel.alignment = .center
        stack.addArrangedSubview(versionLabel)

        stack.addArrangedSubview(buildLine(displayVersion, commitURL: commitURL))

        guard let content = win.contentView else { return win }
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor),
        ])
        return win
    }

    /// The monospaced build line. When a commit URL was stamped at build time, the trailing
    /// SHA is a clickable hyperlink to the commit on GitHub; otherwise it's plain text.
    private func buildLine(_ displayVersion: String, commitURL: String?) -> NSTextField {
        let mono = NSFont.monospacedSystemFont(ofSize: 17, weight: .regular)
        let attr = NSMutableAttributedString(
            string: displayVersion,
            attributes: [.font: mono, .foregroundColor: NSColor.labelColor])
        // Hyperlink only the trailing SHA — the token after the final " · " separator.
        if let s = commitURL, let url = URL(string: s),
           let sep = displayVersion.range(of: " · ", options: .backwards) {
            let shaRange = NSRange(sep.upperBound..<displayVersion.endIndex, in: displayVersion)
            attr.addAttributes([
                .link: url,
                .foregroundColor: NSColor.linkColor,
                .underlineStyle: NSUnderlineStyle.single.rawValue,
            ], range: shaRange)
        }
        let field = NSTextField(labelWithAttributedString: attr)
        field.alignment = .center
        field.isSelectable = true                 // selectable + allowsEditingTextAttributes is the
        field.allowsEditingTextAttributes = true  // documented recipe for a clickable NSTextField link
        return field
    }

    @objc func navigateToPlaylists() {
        showPage(.playlists)
    }

    @objc func navigateToTracker() {
        showPage(.tracker)
    }

    @objc func navigateToQueue() {
        showPage(.queue)
    }

    @objc func reloadPage() {
        webViewController.reload()
    }

    @objc func zoomIn() {
        webViewController.zoomIn()
    }

    @objc func zoomOut() {
        webViewController.zoomOut()
    }

    @objc func resetZoom() {
        webViewController.resetZoom()
    }

    @objc func toggleFloatOnTop(_ sender: NSMenuItem) {
        let newState = !isFloatOnTop
        setFloatOnTop(newState)
        sender.state = newState ? .on : .off
        settingsWindowController.noteFloatOnTop(newState)
    }
}

// MARK: - NSMenuDelegate (Themes)

extension AppDelegate: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        if menu === themesMenu { rebuildThemesMenu() }
    }
}

// MARK: - WKScriptMessageHandler (dashboard page → app)

extension AppDelegate: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "dashboard",
              let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        if type == "theme", let theme = body["theme"] as? String {
            setTheme(theme, fromDashboard: true)
        }
    }
}

// MARK: - NSWindowDelegate

extension AppDelegate: NSWindowDelegate {
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // Hide instead of closing so AppleScript can toggle
        hideWindow()
        return false
    }
}

// MARK: - HotkeyManagerDelegate

extension AppDelegate: HotkeyManagerDelegate {
    func hotkeyTriggered(for page: DashboardPage) {
        togglePage(page)
    }
}

// MARK: - SettingsDelegate

extension AppDelegate: SettingsDelegate {
    func settingsDidChangeAppMode(menuBarMode: Bool) {
        setMenuBarMode(menuBarMode)
    }

    func settingsDidChangeFloatOnTop(enabled: Bool) {
        setFloatOnTop(enabled)
        // Update the View menu checkmark
        if let viewMenu = NSApp.mainMenu?.item(withTitle: "View")?.submenu,
           let floatItem = viewMenu.item(withTitle: "Float on Top") {
            floatItem.state = enabled ? .on : .off
        }
    }

    func settingsDidChangeTheme(_ theme: String) {
        setTheme(theme)
    }

    func settingsDidChangeGridShortcuts() {
        webViewController.webView.evaluateJavaScript(
            "typeof reloadGridShortcuts === 'function' && reloadGridShortcuts()",
            completionHandler: nil
        )
    }

    func settingsDidChangeSidebarShortcut() {
        loadInternalSidebarShortcut()
    }
}

// MARK: - StatusBarDelegate

extension AppDelegate: StatusBarDelegate {
    func statusBarShowPage(_ page: DashboardPage) {
        showPage(page)
    }

    func statusBarOpenSettings() {
        openSettings()
    }

    func statusBarQuit() {
        NSApp.terminate(nil)
    }
}
