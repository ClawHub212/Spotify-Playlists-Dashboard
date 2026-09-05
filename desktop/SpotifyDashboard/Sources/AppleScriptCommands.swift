import Cocoa

// MARK: - Show Page Command
// AppleScript: tell application "Spotify Dashboard (old)" to show page "playlist"

class ShowPageCommand: NSScriptCommand {
    override func performDefaultImplementation() -> Any? {
        guard let pageStr = directParameter as? String,
              let page = DashboardPage.from(pageStr) else {
            scriptErrorNumber = -1
            scriptErrorString = "Invalid page. Use: playlist, tracker, or queue"
            return nil
        }

        DispatchQueue.main.async {
            if let delegate = NSApp.delegate as? AppDelegate {
                delegate.showPage(page)
            }
        }
        return nil
    }
}

// MARK: - Hide App Command
// AppleScript: tell application "Spotify Dashboard (old)" to hide app

class HideAppCommand: NSScriptCommand {
    override func performDefaultImplementation() -> Any? {
        DispatchQueue.main.async {
            if let delegate = NSApp.delegate as? AppDelegate {
                delegate.hideWindow()
            }
        }
        return nil
    }
}

// MARK: - Toggle Page Command
// AppleScript: tell application "Spotify Dashboard (old)" to toggle page "tracker"

class TogglePageCommand: NSScriptCommand {
    override func performDefaultImplementation() -> Any? {
        guard let pageStr = directParameter as? String,
              let page = DashboardPage.from(pageStr) else {
            scriptErrorNumber = -1
            scriptErrorString = "Invalid page. Use: playlist, tracker, or queue"
            return nil
        }

        DispatchQueue.main.async {
            if let delegate = NSApp.delegate as? AppDelegate {
                delegate.togglePage(page)
            }
        }
        return nil
    }
}
