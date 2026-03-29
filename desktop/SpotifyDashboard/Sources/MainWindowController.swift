import Cocoa
import WebKit

/// Represents the three dashboard pages
enum DashboardPage: String, CaseIterable {
    case playlists = "playlist"
    case tracker = "tracker"
    case queue = "queue"

    var path: String {
        switch self {
        case .playlists: return "/"
        case .tracker: return "/tracker"
        case .queue: return "/queue"
        }
    }

    var displayName: String {
        switch self {
        case .playlists: return "Playlists"
        case .tracker: return "Tracker"
        case .queue: return "Queue"
        }
    }

    /// Parse from a string (AppleScript input)
    static func from(_ string: String) -> DashboardPage? {
        let lowered = string.lowercased().trimmingCharacters(in: .whitespaces)
        switch lowered {
        case "playlist", "playlists", "index": return .playlists
        case "tracker": return .tracker
        case "queue": return .queue
        default: return nil
        }
    }
}

class MainWindowController: NSObject {

    private let window: NSWindow
    let webView: WKWebView
    private(set) var currentPage: DashboardPage = .playlists

    private let baseURL = "http://127.0.0.1:8888"

    init(window: NSWindow) {
        self.window = window

        // Configure WKWebView
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        // Allow inline media playback and autoplay
        config.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]

        // Transparent background to match the app aesthetic
        webView.setValue(false, forKey: "drawsBackground")
        
        // Custom User Agent to ensure reCAPTCHA works without blocking WKWebView
        webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"

        super.init()

        webView.navigationDelegate = self
        window.contentView?.addSubview(webView)
    }

    /// Load a specific dashboard page
    func loadPage(_ page: DashboardPage) {
        currentPage = page
        let urlString = baseURL + page.path
        if let url = URL(string: urlString) {
            let request = URLRequest(url: url)
            webView.load(request)
        }
    }

    /// Reload the current page
    func reload() {
        webView.reload()
    }

    // MARK: - Zoom

    private static let zoomStep: CGFloat = 0.1
    private static let minZoom: CGFloat = 0.5
    private static let maxZoom: CGFloat = 3.0
    private static let defaultZoom: CGFloat = 1.0

    private var savedZoom: CGFloat {
        let val = UserDefaults.standard.double(forKey: "webViewZoom")
        return val > 0 ? CGFloat(val) : MainWindowController.defaultZoom
    }

    /// Zoom in (⌘+)
    func zoomIn() {
        let newZoom = min(webView.pageZoom + MainWindowController.zoomStep, MainWindowController.maxZoom)
        webView.pageZoom = newZoom
        UserDefaults.standard.set(Double(newZoom), forKey: "webViewZoom")
    }

    /// Zoom out (⌘-)
    func zoomOut() {
        let newZoom = max(webView.pageZoom - MainWindowController.zoomStep, MainWindowController.minZoom)
        webView.pageZoom = newZoom
        UserDefaults.standard.set(Double(newZoom), forKey: "webViewZoom")
    }

    /// Reset zoom to default (⌘0)
    func resetZoom() {
        webView.pageZoom = MainWindowController.defaultZoom
        UserDefaults.standard.set(Double(MainWindowController.defaultZoom), forKey: "webViewZoom")
    }

    /// Restore saved zoom level (called after page loads)
    private func restoreZoom() {
        webView.pageZoom = savedZoom
    }
}

// MARK: - WKNavigationDelegate

extension MainWindowController: WKNavigationDelegate {

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }

        // Allow internal schemes often used by iframes (e.g. reCAPTCHA)
        if url.scheme == "about" || url.scheme == "data" || url.scheme == "blob" {
            decisionHandler(.allow)
            return
        }

        // Handle Spotify OAuth callback and localhost
        if let host = url.host {
            if host == "127.0.0.1" || host == "localhost" {
                decisionHandler(.allow)
                return
            }
            
            // Allow Spotify auth architecture, social logins, and captcha
            let allowedDomains = ["spotify.com", "google.com", "recaptcha", "gstatic.com", "facebook.com", "apple.com"]
            if allowedDomains.contains(where: { host.contains($0) }) {
                decisionHandler(.allow)
                return
            }
        }

        // External URLs - open in default browser
        NSWorkspace.shared.open(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        // Ignore cancelled navigations
        if nsError.code == NSURLErrorCancelled { return }
        print("WebView navigation failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Restore saved zoom level after each page load
        restoreZoom()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        if nsError.code == NSURLErrorCancelled { return }
        print("WebView provisional navigation failed: \(error.localizedDescription)")

        // If backend isn't ready yet, retry after a delay
        if nsError.code == NSURLErrorCannotConnectToHost || nsError.code == NSURLErrorNetworkConnectionLost {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                guard let self = self else { return }
                self.loadPage(self.currentPage)
            }
        }
    }
}
