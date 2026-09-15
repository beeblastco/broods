// broods-desktop: screenshots, mouse and keyboard for `broods machine --computer`.
//
// One JSON request per line on stdin, one JSON reply per line on stdout.
// Coordinates are screenshot pixels: the main display scaled to fit
// MAX_SHOT_EDGE, mapped to display points both ways in this file. Needs Screen
// Recording and Accessibility for the terminal that runs the daemon.

import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let MAX_SHOT_EDGE: CGFloat = 1280
// Past this a PNG of the screen is re-encoded as JPEG; text stays legible and
// the model reads a fraction of the bytes.
let MAX_PNG_BYTES = 500 * 1024
let JPEG_QUALITY = 0.85
let TYPING_DELAY_US: UInt32 = 12_000
let CLICK_DELAY_US: UInt32 = 60_000

struct Request: Decodable {
  let id: String
  let action: String
  let coordinate: [Double]?
  let startCoordinate: [Double]?
  let text: String?
  let scrollDirection: String?
  let scrollAmount: Double?
  let duration: Double?
  let region: [Double]?
  let repeatCount: Int?
  let request: Bool?

  enum CodingKeys: String, CodingKey {
    case id, action, coordinate, text, duration, region, request
    case startCoordinate = "start_coordinate"
    case scrollDirection = "scroll_direction"
    case scrollAmount = "scroll_amount"
    case repeatCount = "repeat"
  }
}

struct Reply: Encodable {
  let id: String
  var text: String? = nil
  var image: EncodedImage? = nil
  var app: String? = nil
  var error: String? = nil
  var display: Display? = nil
  var permissions: Permissions? = nil
}

struct EncodedImage: Encodable {
  let data: String
  let mediaType: String
}

struct Display: Encodable {
  let width: Int
  let height: Int
  let scale: Double
}

struct Permissions: Encodable {
  let screenRecording: Bool
  let accessibility: Bool
}

struct ActionError: Error {
  let message: String
}

// xdotool key names to macOS virtual key codes (ANSI US layout).
let KEY_CODES: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
  "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
  "3": 20, "4": 21, "6": 22, "5": 23, "equal": 24, "=": 24, "9": 25, "7": 26,
  "minus": 27, "-": 27, "8": 28, "0": 29, "bracketright": 30, "]": 30, "o": 31,
  "u": 32, "bracketleft": 33, "[": 33, "i": 34, "p": 35, "return": 36, "l": 37,
  "j": 38, "apostrophe": 39, "'": 39, "k": 40, "semicolon": 41, ";": 41,
  "backslash": 42, "\\": 42, "comma": 43, ",": 43, "slash": 44, "/": 44, "n": 45,
  "m": 46, "period": 47, ".": 47, "tab": 48, "space": 49, "grave": 50, "`": 50,
  "backspace": 51, "delete": 51, "escape": 53, "esc": 53, "super": 55, "cmd": 55,
  "command": 55, "meta": 55, "shift": 56, "caps_lock": 57, "alt": 58, "option": 58,
  "ctrl": 59, "control": 59, "f17": 64, "kp_decimal": 65, "kp_multiply": 67,
  "kp_add": 69, "kp_divide": 75, "kp_enter": 76, "kp_subtract": 78, "kp_equal": 81,
  "kp_0": 82, "kp_1": 83, "kp_2": 84, "kp_3": 85, "kp_4": 86, "kp_5": 87, "kp_6": 88,
  "kp_7": 89, "kp_8": 91, "kp_9": 92, "f5": 96, "f6": 97, "f7": 98, "f3": 99,
  "f8": 100, "f9": 101, "f11": 103, "f13": 105, "f14": 107, "f10": 109, "f12": 111,
  "f15": 113, "help": 114, "insert": 114, "home": 115, "prior": 116, "page_up": 116,
  "kp_delete": 117, "f4": 118, "end": 119, "f2": 120, "next": 121, "page_down": 121,
  "f1": 122, "left": 123, "right": 124, "down": 125, "up": 126,
]
let MODIFIER_FLAGS: [String: CGEventFlags] = [
  "shift": .maskShift, "ctrl": .maskControl, "control": .maskControl,
  "alt": .maskAlternate, "option": .maskAlternate, "super": .maskCommand,
  "cmd": .maskCommand, "command": .maskCommand, "meta": .maskCommand,
]

// --- main loop --------------------------------------------------------------

setvbuf(stdout, nil, _IOLBF, 0)
let decoder = JSONDecoder()
let encoder = JSONEncoder()
while let line = readLine(strippingNewline: true) {
  guard let data = line.data(using: .utf8), !line.isEmpty else { continue }
  var reply: Reply
  do {
    let request = try decoder.decode(Request.self, from: data)
    reply = Reply(id: request.id)
    do {
      try perform(request, into: &reply)
    } catch let failure as ActionError {
      reply.error = failure.message
    }
    if reply.error == nil, reply.display == nil, reply.permissions == nil {
      reply.app = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    }
  } catch {
    reply = Reply(id: "", error: "malformed request: \(error)")
  }
  if let encoded = try? encoder.encode(reply), let text = String(data: encoded, encoding: .utf8) {
    print(text)
  }
}

// --- actions ----------------------------------------------------------------

func perform(_ request: Request, into reply: inout Reply) throws {
  switch request.action {
  case "display":
    reply.display = displayInfo()
  case "permissions":
    reply.permissions = permissions(request: request.request ?? false)
  case "screenshot":
    reply.image = try screenshot(region: nil)
  case "zoom":
    guard let region = request.region, region.count == 4 else {
      throw ActionError(message: "zoom needs region [x0, y0, x1, y1]")
    }
    reply.image = try screenshot(region: region)
  case "cursor_position":
    let pixel = toShot(cursor())
    reply.text = "X=\(Int(pixel.x.rounded())),Y=\(Int(pixel.y.rounded()))"
  case "mouse_move":
    post(mouse: .mouseMoved, at: try point(request.coordinate, "coordinate"), button: .left)
    // The window server applies the move asynchronously; a cursor_position
    // that follows at once would still read the old spot.
    usleep(CLICK_DELAY_US)
    reply.text = "OK"
  case "left_click", "right_click", "middle_click", "double_click", "triple_click":
    try click(request)
    reply.text = "OK"
  case "left_mouse_down":
    let at = request.coordinate != nil ? try point(request.coordinate, "coordinate") : cursor()
    post(mouse: .leftMouseDown, at: at, button: .left)
    reply.text = "OK"
  case "left_mouse_up":
    let at = request.coordinate != nil ? try point(request.coordinate, "coordinate") : cursor()
    post(mouse: .leftMouseUp, at: at, button: .left)
    reply.text = "OK"
  case "left_click_drag":
    let from = try point(request.startCoordinate, "start_coordinate")
    let to = try point(request.coordinate, "coordinate")
    try withModifiers(request.text) {
      post(mouse: .mouseMoved, at: from, button: .left)
      post(mouse: .leftMouseDown, at: from, button: .left)
      usleep(CLICK_DELAY_US)
      post(mouse: .leftMouseDragged, at: to, button: .left)
      usleep(CLICK_DELAY_US)
      post(mouse: .leftMouseUp, at: to, button: .left)
    }
    reply.text = "OK"
  case "scroll":
    try scroll(request)
    reply.text = "OK"
  case "key":
    guard let chord = request.text, !chord.isEmpty else {
      throw ActionError(message: "key needs text, e.g. \"Return\" or \"cmd+s\"")
    }
    for _ in 0..<max(1, min(request.repeatCount ?? 1, 100)) {
      try pressChord(chord)
    }
    reply.text = "OK"
  case "hold_key":
    guard let chord = request.text, !chord.isEmpty else {
      throw ActionError(message: "hold_key needs text")
    }
    let seconds = min(max(request.duration ?? 1, 0), 300)
    let (code, flags) = try parseChord(chord)
    keyEvent(code, flags: flags, down: true)
    usleep(UInt32(seconds * 1_000_000))
    keyEvent(code, flags: flags, down: false)
    reply.text = "OK"
  case "type":
    guard let text = request.text else { throw ActionError(message: "type needs text") }
    typeText(text)
    reply.text = "OK"
  case "wait":
    let seconds = min(max(request.duration ?? 1, 0), 300)
    usleep(UInt32(seconds * 1_000_000))
    reply.text = "OK"
  default:
    throw ActionError(message: "unknown action \(request.action)")
  }
}

func click(_ request: Request) throws {
  let at = request.coordinate != nil ? try point(request.coordinate, "coordinate") : cursor()
  let (down, up, button): (CGEventType, CGEventType, CGMouseButton)
  switch request.action {
  case "right_click": (down, up, button) = (.rightMouseDown, .rightMouseUp, .right)
  case "middle_click": (down, up, button) = (.otherMouseDown, .otherMouseUp, .center)
  default: (down, up, button) = (.leftMouseDown, .leftMouseUp, .left)
  }
  let count = request.action == "double_click" ? 2 : request.action == "triple_click" ? 3 : 1
  try withModifiers(request.text) {
    post(mouse: .mouseMoved, at: at, button: button)
    usleep(CLICK_DELAY_US)
    for state in 1...count {
      post(mouse: down, at: at, button: button, clickState: state)
      post(mouse: up, at: at, button: button, clickState: state)
      if state < count { usleep(CLICK_DELAY_US) }
    }
  }
}

func scroll(_ request: Request) throws {
  let amount = Int32(max(1, min(request.scrollAmount ?? 3, 100)))
  var dy: Int32 = 0
  var dx: Int32 = 0
  switch request.scrollDirection ?? "down" {
  case "up": dy = amount
  case "down": dy = -amount
  case "left": dx = amount
  case "right": dx = -amount
  default: throw ActionError(message: "scroll_direction must be up, down, left or right")
  }
  if request.coordinate != nil {
    post(mouse: .mouseMoved, at: try point(request.coordinate, "coordinate"), button: .left)
    usleep(CLICK_DELAY_US)
  }
  try withModifiers(request.text) {
    if let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
      event.post(tap: .cghidEventTap)
    }
  }
}

// --- keyboard ---------------------------------------------------------------

func parseChord(_ chord: String) throws -> (CGKeyCode, CGEventFlags) {
  let parts = chord.split(separator: "+").map { String($0) }
  guard let last = parts.last else { throw ActionError(message: "empty key chord") }
  var flags: CGEventFlags = []
  for modifier in parts.dropLast() {
    guard let flag = MODIFIER_FLAGS[modifier.lowercased()] else {
      throw ActionError(message: "unknown modifier \(modifier)")
    }
    flags.insert(flag)
  }
  guard let code = KEY_CODES[last.lowercased()] else {
    throw ActionError(message: "unknown key \(last); use xdotool names like Return, Tab, ctrl+s")
  }
  if last.count == 1, last.uppercased() == last, last.lowercased() != last {
    flags.insert(.maskShift)
  }

  return (code, flags)
}

func pressChord(_ chord: String) throws {
  let (code, flags) = try parseChord(chord)
  keyEvent(code, flags: flags, down: true)
  keyEvent(code, flags: flags, down: false)
}

func keyEvent(_ code: CGKeyCode, flags: CGEventFlags, down: Bool) {
  guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { return }
  event.flags = flags
  event.post(tap: .cghidEventTap)
  usleep(TYPING_DELAY_US)
}

// Unicode typing: no layout lookup, any script goes in as it is.
func typeText(_ text: String) {
  for unit in text.utf16 {
    var units = [unit]
    if let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
       let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
      down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &units)
      up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &units)
      down.post(tap: .cghidEventTap)
      up.post(tap: .cghidEventTap)
    }
    usleep(TYPING_DELAY_US)
  }
}

func withModifiers(_ chord: String?, _ body: () throws -> Void) throws {
  guard let chord, !chord.isEmpty else {
    try body()
    return
  }
  var codes: [CGKeyCode] = []
  for name in chord.split(separator: "+") {
    guard let code = KEY_CODES[String(name).lowercased()], MODIFIER_FLAGS[String(name).lowercased()] != nil else {
      throw ActionError(message: "unknown modifier \(name)")
    }
    codes.append(code)
  }
  for code in codes { keyEvent(code, flags: [], down: true) }
  defer { for code in codes.reversed() { keyEvent(code, flags: [], down: false) } }
  try body()
}

// --- mouse ------------------------------------------------------------------

func cursor() -> CGPoint {
  return CGEvent(source: nil)?.location ?? .zero
}

func post(mouse type: CGEventType, at point: CGPoint, button: CGMouseButton, clickState: Int = 1) {
  guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
  event.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
  event.post(tap: .cghidEventTap)
}

func point(_ pair: [Double]?, _ field: String) throws -> CGPoint {
  guard let pair, pair.count == 2 else {
    throw ActionError(message: "\(field) must be [x, y] in screenshot pixels")
  }
  let shot = shotSize()
  guard pair[0] >= 0, pair[1] >= 0, pair[0] <= shot.width, pair[1] <= shot.height else {
    throw ActionError(message: "\(field) [\(Int(pair[0])), \(Int(pair[1]))] is outside the \(Int(shot.width))x\(Int(shot.height)) screenshot")
  }

  return fromShot(CGPoint(x: pair[0], y: pair[1]))
}

// --- display and scaling ----------------------------------------------------

func displayBounds() -> CGRect {
  return CGDisplayBounds(CGMainDisplayID())
}

// Deterministic from the display bounds, so input and capture agree with no state.
func shotSize() -> CGSize {
  let bounds = displayBounds()
  let factor = min(1, MAX_SHOT_EDGE / max(bounds.width, bounds.height))

  return CGSize(width: (bounds.width * factor).rounded(), height: (bounds.height * factor).rounded())
}

func fromShot(_ pixel: CGPoint) -> CGPoint {
  let bounds = displayBounds()
  let shot = shotSize()

  return CGPoint(x: bounds.minX + pixel.x * bounds.width / shot.width, y: bounds.minY + pixel.y * bounds.height / shot.height)
}

func toShot(_ point: CGPoint) -> CGPoint {
  let bounds = displayBounds()
  let shot = shotSize()

  return CGPoint(x: (point.x - bounds.minX) * shot.width / bounds.width, y: (point.y - bounds.minY) * shot.height / bounds.height)
}

func displayInfo() -> Display {
  let shot = shotSize()
  let bounds = displayBounds()

  return Display(width: Int(shot.width), height: Int(shot.height), scale: Double(bounds.width / shot.width))
}

func permissions(request: Bool) -> Permissions {
  if request {
    _ = CGRequestScreenCaptureAccess()
    _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary)
  }

  return Permissions(screenRecording: CGPreflightScreenCaptureAccess(), accessibility: AXIsProcessTrusted())
}

// --- capture ----------------------------------------------------------------

// `screencapture` rather than CGDisplayCreateImage: it survives the API's
// deprecation on new macOS and needs the same Screen Recording grant.
func captureDisplay() throws -> CGImage {
  let path = NSTemporaryDirectory() + "broods-desktop-\(UUID().uuidString).png"
  defer { try? FileManager.default.removeItem(atPath: path) }
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  process.arguments = ["-x", "-m", "-t", "png", path]
  try process.run()
  process.waitUntilExit()
  guard process.terminationStatus == 0,
        let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    throw ActionError(message: "screen capture failed; grant Screen Recording to this terminal (broods machine --doctor)")
  }

  return image
}

func screenshot(region: [Double]?) throws -> EncodedImage {
  let full = try captureDisplay()
  let shot = shotSize()
  var source = full
  var frame = shot
  if let region {
    // Region is in screenshot pixels; the crop happens on the physical image.
    let sx = CGFloat(full.width) / shot.width
    let sy = CGFloat(full.height) / shot.height
    let rect = CGRect(x: region[0] * sx, y: region[1] * sy, width: (region[2] - region[0]) * sx, height: (region[3] - region[1]) * sy).integral
    guard rect.width > 0, rect.height > 0, let cropped = full.cropping(to: rect) else {
      throw ActionError(message: "zoom region must be [x0, y0, x1, y1] inside the screenshot with x1 > x0 and y1 > y0")
    }
    source = cropped
    frame = fit(rect.size, into: shot)
  }

  return try encode(try resize(source, to: frame))
}

func fit(_ size: CGSize, into box: CGSize) -> CGSize {
  let factor = min(box.width / size.width, box.height / size.height)

  return CGSize(width: max(1, (size.width * factor).rounded()), height: max(1, (size.height * factor).rounded()))
}

func resize(_ image: CGImage, to size: CGSize) throws -> CGImage {
  guard let context = CGContext(data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
    throw ActionError(message: "could not allocate the screenshot bitmap")
  }
  context.interpolationQuality = .high
  context.draw(image, in: CGRect(origin: .zero, size: size))
  guard let result = context.makeImage() else { throw ActionError(message: "could not scale the screenshot") }

  return result
}

func encode(_ image: CGImage) throws -> EncodedImage {
  let png = try encode(image, as: UTType.png, quality: nil)
  if png.count <= MAX_PNG_BYTES {
    return EncodedImage(data: png.base64EncodedString(), mediaType: "image/png")
  }
  let jpeg = try encode(image, as: UTType.jpeg, quality: JPEG_QUALITY)

  return EncodedImage(data: jpeg.base64EncodedString(), mediaType: "image/jpeg")
}

func encode(_ image: CGImage, as type: UTType, quality: Double?) throws -> Data {
  let data = NSMutableData()
  guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else {
    throw ActionError(message: "could not create the image encoder")
  }
  var options: [CFString: Any] = [:]
  if let quality { options[kCGImageDestinationLossyCompressionQuality] = quality }
  CGImageDestinationAddImage(destination, image, options as CFDictionary)
  guard CGImageDestinationFinalize(destination) else { throw ActionError(message: "could not encode the screenshot") }

  return data as Data
}
