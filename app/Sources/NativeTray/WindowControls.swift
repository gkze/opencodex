import AppKit
import WebKit
import ObjectiveC

private var layoutAssociation: UInt8 = 0

/// AppKit owns drawing and tracking; this observer owns only windowed placement.
private final class WindowControlsLayout: NSObject {
    private weak var window: NSWindow?
    private var updateObserver: NSObjectProtocol?
    private var frameObservers: [NSObjectProtocol] = []
    private var views: [NSView] = []
    private var applying = false
    private weak var titlebarContainer: NSView?
    private var nativeTitlebarHeight: CGFloat = 0

    init(window: NSWindow) {
        self.window = window
        super.init()
        updateObserver = NotificationCenter.default.addObserver(forName: NSWindow.didUpdateNotification,
                                                                object: window, queue: .main) { [weak self] _ in
            self?.update()
        }
        update()
    }

    private func update() {
        guard let window, !applying, !window.styleMask.contains(.fullScreen) else { return }
        applying = true
        defer { applying = false }
        let container = window.standardWindowButton(.closeButton)?.superview?.superview
        if titlebarContainer !== container {
            titlebarContainer = container
            nativeTitlebarHeight = container?.frame.height ?? 0
        }
        var current: [NSView] = []
        for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            var view: NSView? = window.standardWindowButton(kind)
            while let item = view {
                if !current.contains(where: { $0 === item }) { current.append(item) }
                view = item.superview
            }
        }
        if current != views {
            frameObservers.forEach(NotificationCenter.default.removeObserver)
            views = current
            frameObservers = current.map { view in
                view.postsFrameChangedNotifications = true
                return NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification,
                                                               object: view, queue: .main) { [weak self] _ in
                    self?.update()
                }
            }
        }
        layoutWindowControls(window, nativeTitlebarHeight: nativeTitlebarHeight)
    }

    deinit {
        if let updateObserver { NotificationCenter.default.removeObserver(updateObserver) }
        frameObservers.forEach(NotificationCenter.default.removeObserver)
    }
}

@_cdecl("ocx_layout_window_controls")
public func ocxLayoutWindowControls(_ pointer: UnsafeMutableRawPointer) {
    installWindowControlsLayout(Unmanaged<NSWindow>.fromOpaque(pointer).takeUnretainedValue())
}

public func installWindowControlsLayout(_ window: NSWindow) {
    precondition(Thread.isMainThread)
    guard objc_getAssociatedObject(window, &layoutAssociation) == nil else { return }
    objc_setAssociatedObject(window, &layoutAssociation, WindowControlsLayout(window: window), .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
}

private func layoutWindowControls(_ window: NSWindow, nativeTitlebarHeight: CGFloat) {
    precondition(Thread.isMainThread)
    guard !window.styleMask.contains(.fullScreen) else { return }
    func webView(in view: NSView) -> WKWebView? {
        if let web = view as? WKWebView { return web }
        return view.subviews.lazy.compactMap { webView(in: $0) }.first
    }
    let zoom = window.contentView.flatMap { webView(in: $0) }?.pageZoom ?? 1
    let centerY = titlebarCenter(pageZoom: zoom, backingScale: window.backingScaleFactor)
    let kinds: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
    // A button drawn below its titlebar ancestor cannot receive mouse events.
    // Grow the same container Wry uses, keeping its top edge fixed and restoring
    // AppKit's original height when zoom returns to normal. Never resize buttons.
    if let container = window.standardWindowButton(.closeButton)?.superview?.superview {
        let halfButtonHeight = kinds.compactMap { window.standardWindowButton($0)?.frame.height }.max().map { $0 / 2 } ?? 0
        let height = max(nativeTitlebarHeight, ceil(centerY + halfButtonHeight))
        var frame = container.frame
        frame.origin.y = window.frame.height - height
        frame.size.height = height
        if container.frame != frame { container.frame = frame }
    }
    for (index, kind) in kinds.enumerated() {
        guard let button = window.standardWindowButton(kind), let parent = button.superview else { continue }
        // Match the 40-point CSS row, excluding its one-point bottom border.
        let center = parent.convert(NSPoint(x: centerY + CGFloat(index) * 23,
                                             y: window.frame.height - centerY), from: nil)
        let origin = NSPoint(x: center.x - button.frame.width / 2,
                             y: center.y - button.frame.height / 2)
        guard button.frame.origin != origin else { continue }
        button.setFrameOrigin(origin)
        button.updateTrackingAreas()
        parent.updateTrackingAreas()
    }
}

/// Match watchMacTitlebarMetrics: the CSS row has a 40px floor and a 1px border.
public func titlebarCenter(pageZoom: Double, backingScale: Double) -> Double {
    let zoom = pageZoom.isFinite && pageZoom > 0 ? pageZoom : 1
    let scale = backingScale.isFinite && backingScale > 0 ? backingScale : 1
    let center = (ceil(40 * max(1, 1 / zoom)) - 1) * zoom / 2
    // A half-point is crisp on Retina but soft on a 1x display. Keep the native
    // 14pt buttons on physical pixels without changing their size or drawing.
    return (center * scale).rounded() / scale
}
