import AppKit
import WebKit
import NativeTray

let app = NSApplication.shared
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 300),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                      backing: .buffered, defer: false)
window.titleVisibility = .hidden
window.titlebarAppearsTransparent = true
let kinds: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
let buttons = kinds.map { window.standardWindowButton($0)! }
let sizes = buttons.map { $0.frame.size }
let bounds = buttons.map(\.bounds)
let actions = buttons.map(\.action)
let layers = buttons.map(\.layer)
let cells = buttons.map(\.cell)
let layerBacking = buttons.map(\.wantsLayer)
let normalCenter = window.backingScaleFactor == 1 ? 20.0 : 19.5
let originalTitlebarHeight = buttons[0].superview!.superview!.frame.height
installWindowControlsLayout(window)
installWindowControlsLayout(window)
for _ in 0..<3 {
    for button in buttons { button.setFrameOrigin(NSPoint(x: 9, y: 9)) }
    // AppKit can reposition a control without issuing a window update first.
    precondition(buttons[0].frame.origin.x == normalCenter - 7, "Frame resets must be corrected synchronously")
    window.update()
    for (i, button) in buttons.enumerated() {
        let center = button.superview!.convert(NSPoint(x: button.frame.midX, y: button.frame.midY), to: nil)
        let pixelOrigin = button.convert(button.bounds, to: nil).origin.x * window.backingScaleFactor
        precondition(abs(pixelOrigin - pixelOrigin.rounded()) < 0.000001, "Native control origin must land on a physical pixel")
        precondition(center.x == normalCenter + CGFloat(i) * 23)
        precondition(center.y == window.frame.height - normalCenter)
        precondition(button.frame.size == sizes[i] && button.bounds == bounds[i], "Never scale native drawing")
        precondition(button.layer === layers[i] && button.wantsLayer == layerBacking[i], "Never replace native compositing")
        precondition(button.cell === cells[i] && button.action == actions[i], "Keep native behavior")
        precondition(window.standardWindowButton(kinds[i]) === button)
    }
    window.setContentSize(NSSize(width: window.frame.width + 20, height: 400))
}
print("WindowControlsTests passed: centers, resize, idempotence, native sizes, bounds, layers, cells and actions")

// Explicit shared visual contract; do not derive expected positions from production helpers.
let zoomCenters = [(0.5, 20.0, 20.0), (0.9, 20.0, 20.0), (1.0, 20.0, 19.5),
                   (1.1, 21.0, 21.5), (2.0, 39.0, 39.0), (3.0, 59.0, 58.5)]
for (zoom, oneX, twoX) in zoomCenters {
    precondition(abs(titlebarCenter(pageZoom: zoom, backingScale: 1) - oneX) < 0.000001)
    precondition(abs(titlebarCenter(pageZoom: zoom, backingScale: 2) - twoX) < 0.000001)
}

let web = WKWebView(frame: window.contentView!.bounds)
window.contentView!.addSubview(web)
for size in [NSSize(width: 360, height: 320), NSSize(width: 600, height: 400), NSSize(width: 1200, height: 900)] {
    window.setContentSize(size)
    for (zoom, oneX, twoX) in zoomCenters + zoomCenters.reversed() {
        let expectedY = window.backingScaleFactor == 1 ? oneX : twoX
        web.pageZoom = zoom
        window.update()
        var root = window.contentView!
        while let parent = root.superview { root = parent }
        for (index, button) in buttons.enumerated() {
            let rect = button.convert(button.bounds, to: nil)
            precondition(abs(rect.midX - (expectedY + Double(index) * 23)) < 0.000001)
            precondition(abs(window.frame.height - rect.midY - expectedY) < 0.000001)
            for coordinate in [rect.minX, rect.minY, rect.maxX, rect.maxY] {
                let physical = coordinate * window.backingScaleFactor
                precondition(abs(physical - physical.rounded()) < 0.000001, "All control edges must align to physical pixels")
            }
            precondition(button.frame.size == sizes[index] && button.bounds == bounds[index])
            precondition(button.layer === layers[index] && button.wantsLayer == layerBacking[index])
            precondition(button.cell === cells[index] && button.action == actions[index])
            // Enter through the window's root, not the button or its immediate parent:
            // any ancestor that rejects this point makes a visible control unusable.
            for offset in [NSPoint.zero, NSPoint(x: -3, y: 0), NSPoint(x: 3, y: 0), NSPoint(x: 0, y: -3), NSPoint(x: 0, y: 3)] {
                let point = NSPoint(x: rect.midX + offset.x, y: rect.midY + offset.y)
                let hit = root.hitTest(point)
                guard hit === button || hit?.isDescendant(of: button) == true else {
                    print("FAIL hit test: size=\(size) zoom=\(zoom) button=\(index) point=\(point) hit=\(String(describing: hit))")
                    var ancestor: NSView? = button
                    while let view = ancestor {
                        print("\(type(of: view)): frame=\(view.frame) bounds=\(view.bounds)")
                        ancestor = view.superview
                    }
                    exit(1)
                }
            }
        }
        if zoom == 1 {
            precondition(buttons[0].superview!.superview!.frame.height == originalTitlebarHeight,
                         "Returning to 100% must restore the original native titlebar height")
        }
    }
}
print("WebKit page zoom: explicit centers and native hit targets across 50–300% zoom, resize and zoom reset")

weak var releasedWindow: NSWindow?
weak var releasedRoot: NSView?
autoreleasepool {
    let temporary = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                             backing: .buffered, defer: false)
    installWindowControlsLayout(temporary)
    releasedWindow = temporary
    releasedRoot = temporary.contentView?.superview
}
precondition(releasedWindow == nil, "The layout observer must not retain its window")
precondition(releasedRoot == nil, "Window teardown must release the observer's retained view hierarchy")
print("Window teardown releases the window and observed hierarchy")
