import Cocoa
import WebKit

class AppDelegate: NSObject, NSApplicationDelegate {

    // MARK: - Properties
    var mainWindow: NSWindow!
    var webViewController: MainWindowController!
    var settingsWindowController: SettingsWindowController!
    var statusBarController: StatusBarController?
    var backendManager: BackendManager!
    var hotkeyManager: HotkeyManager!
    var loadingViewController: LoadingViewController?

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

    // MARK: - Application Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Start the Flask backend
        backendManager = BackendManager()
        backendManager.start()

        // Create the main window
        createMainWindow()

        // Show the window and loading screen immediately
        showWindowOnCurrentScreen()
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

        // Apply Dock/Menu Bar mode
        applyAppMode()

        // Wait for backend to be ready with progress reporting
        backendManager.waitForReady(progress: { [weak self] progress in
            DispatchQueue.main.async {
                self?.loadingViewController?.setProgress(CGFloat(progress))
            }
        }) { [weak self] in
            DispatchQueue.main.async {
                self?.webViewController.loadPage(.playlists)
                // Dismiss loading screen after a brief moment for the WebView to render
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    self?.loadingViewController?.dismiss {
                        self?.loadingViewController = nil
                    }
                }
            }
        }

        // Build the app menu
        buildMenu()
    }

    func applicationWillTerminate(_ notification: Notification) {
        hotkeyManager.unregisterAll()
        backendManager.stop()
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

        mainWindow.title = "Spotify Dashboard"
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

    /// Show the window and navigate to a specific page
    func showPage(_ page: DashboardPage) {
        webViewController.loadPage(page)
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
        appMenu.addItem(withTitle: "About Spotify Dashboard", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Settings...", action: #selector(openSettings), keyEquivalent: ",")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Hide Spotify Dashboard", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit Spotify Dashboard", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

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

        // Window menu
        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)

        NSApp.mainMenu = mainMenu
    }

    @objc func openSettings() {
        settingsWindowController.showWindow()
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
        settingsWindowController.updateFloatOnTopState(newState)
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
