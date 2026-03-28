import Cocoa

/// A native loading screen shown while the Flask backend starts up.
/// Uses Core Animation for smooth, GPU-accelerated visuals.
class LoadingViewController: NSObject {

    private let containerView: NSView
    private let progressLayer = CAShapeLayer()
    private let glowLayer = CAShapeLayer()
    private let statusLabel: NSTextField
    private let titleLabel: NSTextField
    private let subtitleLabel: NSTextField
    private let progressBackgroundLayer = CAShapeLayer()

    private var startTime: Date = Date()
    private var statusTimer: Timer?
    private var progressValue: CGFloat = 0.0

    // Status messages to cycle through
    private let statusMessages = [
        "Initializing backend…",
        "Starting Flask server…",
        "Connecting to Spotify…",
        "Loading playlists…",
        "Caching data…",
        "Almost ready…"
    ]
    private var currentMessageIndex = 0

    init(parentView: NSView) {
        // Container fills the entire parent
        containerView = NSView(frame: parentView.bounds)
        containerView.autoresizingMask = [.width, .height]
        containerView.wantsLayer = true
        containerView.layer?.backgroundColor = NSColor(red: 0.04, green: 0.04, blue: 0.04, alpha: 1.0).cgColor

        // Title: "SPOTIFY DASHBOARD"
        titleLabel = NSTextField(labelWithString: "SPOTIFY DASHBOARD")
        titleLabel.font = NSFont(name: "Menlo-Bold", size: 18) ?? NSFont.boldSystemFont(ofSize: 18)
        titleLabel.textColor = NSColor(red: 0.52, green: 1.0, blue: 0.0, alpha: 1.0) // neon green #84ff00
        titleLabel.alignment = .center
        titleLabel.isBezeled = false
        titleLabel.isEditable = false
        titleLabel.drawsBackground = false

        // Subtitle: "Loading…"
        subtitleLabel = NSTextField(labelWithString: "Launching…")
        subtitleLabel.font = NSFont(name: "Menlo", size: 11) ?? NSFont.systemFont(ofSize: 11)
        subtitleLabel.textColor = NSColor(white: 0.5, alpha: 1.0)
        subtitleLabel.alignment = .center
        subtitleLabel.isBezeled = false
        subtitleLabel.isEditable = false
        subtitleLabel.drawsBackground = false

        // Status label
        statusLabel = NSTextField(labelWithString: "Initializing backend…")
        statusLabel.font = NSFont(name: "Menlo", size: 12) ?? NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        statusLabel.textColor = NSColor(white: 0.6, alpha: 1.0)
        statusLabel.alignment = .center
        statusLabel.isBezeled = false
        statusLabel.isEditable = false
        statusLabel.drawsBackground = false

        super.init()

        parentView.addSubview(containerView, positioned: .above, relativeTo: nil)
        containerView.addSubview(titleLabel)
        containerView.addSubview(subtitleLabel)
        containerView.addSubview(statusLabel)

        layoutViews()
        setupProgressRing()
        startAnimations()
    }

    private func layoutViews() {
        let centerX = containerView.bounds.midX
        let centerY = containerView.bounds.midY

        // Title above the ring
        titleLabel.sizeToFit()
        titleLabel.frame = NSRect(
            x: centerX - titleLabel.frame.width / 2,
            y: centerY + 70,
            width: titleLabel.frame.width,
            height: titleLabel.frame.height
        )

        // Subtitle just below title
        subtitleLabel.sizeToFit()
        subtitleLabel.frame = NSRect(
            x: centerX - subtitleLabel.frame.width / 2,
            y: centerY + 50,
            width: subtitleLabel.frame.width,
            height: subtitleLabel.frame.height
        )

        // Status below the ring
        statusLabel.frame = NSRect(
            x: 0,
            y: centerY - 90,
            width: containerView.bounds.width,
            height: 20
        )
        statusLabel.autoresizingMask = [.width]
    }

    private func setupProgressRing() {
        guard let layer = containerView.layer else { return }

        let center = CGPoint(x: containerView.bounds.midX, y: containerView.bounds.midY)
        let radius: CGFloat = 30
        let lineWidth: CGFloat = 3.0

        // Create circular path (starts from top, goes clockwise)
        let circlePath = NSBezierPath()
        circlePath.appendArc(
            withCenter: center,
            radius: radius,
            startAngle: 90,
            endAngle: -270,
            clockwise: true
        )
        let cgPath = circlePath.cgPath

        // Background ring
        progressBackgroundLayer.path = cgPath
        progressBackgroundLayer.strokeColor = NSColor(white: 1.0, alpha: 0.08).cgColor
        progressBackgroundLayer.fillColor = NSColor.clear.cgColor
        progressBackgroundLayer.lineWidth = lineWidth
        progressBackgroundLayer.lineCap = .round
        layer.addSublayer(progressBackgroundLayer)

        // Glow layer (under progress)
        glowLayer.path = cgPath
        glowLayer.strokeColor = NSColor(red: 0.52, green: 1.0, blue: 0.0, alpha: 0.3).cgColor
        glowLayer.fillColor = NSColor.clear.cgColor
        glowLayer.lineWidth = lineWidth + 4
        glowLayer.lineCap = .round
        glowLayer.strokeEnd = 0
        layer.addSublayer(glowLayer)

        // Progress ring
        progressLayer.path = cgPath
        progressLayer.strokeColor = NSColor(red: 0.52, green: 1.0, blue: 0.0, alpha: 1.0).cgColor
        progressLayer.fillColor = NSColor.clear.cgColor
        progressLayer.lineWidth = lineWidth
        progressLayer.lineCap = .round
        progressLayer.strokeEnd = 0
        layer.addSublayer(progressLayer)
    }

    private func startAnimations() {
        startTime = Date()

        // Pulse animation on the glow layer
        let pulseAnimation = CABasicAnimation(keyPath: "opacity")
        pulseAnimation.fromValue = 0.3
        pulseAnimation.toValue = 0.8
        pulseAnimation.duration = 1.5
        pulseAnimation.autoreverses = true
        pulseAnimation.repeatCount = .greatestFiniteMagnitude
        pulseAnimation.timingFunction = CAMediaTimingFunction(name: CAMediaTimingFunctionName(rawValue: "easeInEaseOut"))
        glowLayer.add(pulseAnimation, forKey: "pulse")

        // Fade in the container
        containerView.alphaValue = 0
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.4
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            containerView.animator().alphaValue = 1.0
        })

        // Status update timer
        statusTimer = Timer.scheduledTimer(withTimeInterval: 1.2, repeats: true) { [weak self] _ in
            self?.advanceStatus()
        }
    }

    private func advanceStatus() {
        currentMessageIndex = min(currentMessageIndex + 1, statusMessages.count - 1)
        let message = statusMessages[currentMessageIndex]

        DispatchQueue.main.async { [weak self] in
            // Animate text change
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = 0.2
                self?.statusLabel.animator().alphaValue = 0.3
            }) {
                self?.statusLabel.stringValue = message
                NSAnimationContext.runAnimationGroup({ context in
                    context.duration = 0.2
                    self?.statusLabel.animator().alphaValue = 1.0
                })
            }
        }
    }

    /// Update progress (0.0 to 1.0) — called from BackendManager polling
    func setProgress(_ value: CGFloat) {
        progressValue = min(max(value, 0), 1.0)

        CATransaction.begin()
        CATransaction.setAnimationDuration(0.4)
        CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeOut))
        progressLayer.strokeEnd = progressValue
        glowLayer.strokeEnd = progressValue
        CATransaction.commit()

        // Update subtitle with elapsed time
        let elapsed = Date().timeIntervalSince(startTime)
        let elapsedStr = String(format: "%.1fs", elapsed)
        subtitleLabel.stringValue = "Elapsed: \(elapsedStr)"
    }

    /// Dismiss the loading screen with a smooth fade out
    func dismiss(completion: (() -> Void)? = nil) {
        statusTimer?.invalidate()
        statusTimer = nil

        // Complete the progress ring
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.3)
        progressLayer.strokeEnd = 1.0
        glowLayer.strokeEnd = 1.0
        CATransaction.commit()

        // Brief pause to show completion, then fade out
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = 0.5
                context.timingFunction = CAMediaTimingFunction(name: .easeIn)
                self?.containerView.animator().alphaValue = 0
            }) {
                self?.containerView.removeFromSuperview()
                completion?()
            }
        }
    }
}

// MARK: - NSBezierPath → CGPath extension

extension NSBezierPath {
    var cgPath: CGPath {
        let path = CGMutablePath()
        var points = [CGPoint](repeating: .zero, count: 3)
        for i in 0..<elementCount {
            let type = element(at: i, associatedPoints: &points)
            switch type {
            case .moveTo:
                path.move(to: points[0])
            case .lineTo:
                path.addLine(to: points[0])
            case .curveTo:
                path.addCurve(to: points[2], control1: points[0], control2: points[1])
            case .closePath:
                path.closeSubpath()
            @unknown default:
                break
            }
        }
        return path
    }
}
