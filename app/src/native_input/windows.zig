const std = @import("std");

const BOOL = i32;
const UINT = u32;
const DWORD = u32;
const WPARAM = usize;
const LPARAM = isize;
const HWND = ?*anyopaque;

const RECT = extern struct { left: i32, top: i32, right: i32, bottom: i32 };
const POINT = extern struct { x: i32, y: i32 };
const MOUSEINPUT = extern struct {
    dx: i32,
    dy: i32,
    mouse_data: DWORD,
    flags: DWORD,
    time: DWORD,
    extra_info: usize,
};
const KEYBDINPUT = extern struct {
    virtual_key: u16,
    scan_code: u16,
    flags: DWORD,
    time: DWORD,
    extra_info: usize,
};
const HARDWAREINPUT = extern struct { message: DWORD, parameter_low: u16, parameter_high: u16 };
const INPUT_VALUE = extern union { mouse: MOUSEINPUT, keyboard: KEYBDINPUT, hardware: HARDWAREINPUT };
const INPUT = extern struct { kind: DWORD, value: INPUT_VALUE };
const EnumProc = *const fn (HWND, LPARAM) callconv(.winapi) BOOL;

extern "user32" fn EnumWindows(callback: EnumProc, value: LPARAM) callconv(.winapi) BOOL;
extern "user32" fn EnumChildWindows(parent: HWND, callback: EnumProc, value: LPARAM) callconv(.winapi) BOOL;
extern "user32" fn GetClassNameW(window: HWND, buffer: [*]u16, maximum: i32) callconv(.winapi) i32;
extern "user32" fn GetWindowTextW(window: HWND, buffer: [*]u16, maximum: i32) callconv(.winapi) i32;
extern "user32" fn GetClientRect(window: HWND, rect: *RECT) callconv(.winapi) BOOL;
extern "user32" fn MapWindowPoints(from: HWND, to: HWND, points: *POINT, count: UINT) callconv(.winapi) i32;
extern "user32" fn ChildWindowFromPointEx(parent: HWND, point: POINT, flags: UINT) callconv(.winapi) HWND;
extern "user32" fn GetWindowLongPtrW(window: HWND, index: i32) callconv(.winapi) isize;
extern "user32" fn GetAncestor(window: HWND, flags: UINT) callconv(.winapi) HWND;
extern "user32" fn IsWindow(window: HWND) callconv(.winapi) BOOL;
extern "user32" fn IsWindowVisible(window: HWND) callconv(.winapi) BOOL;
extern "user32" fn IsIconic(window: HWND) callconv(.winapi) BOOL;
extern "user32" fn GetAsyncKeyState(key: i32) callconv(.winapi) i16;
extern "user32" fn GetForegroundWindow() callconv(.winapi) HWND;
extern "user32" fn GetWindowThreadProcessId(window: HWND, process_id: ?*DWORD) callconv(.winapi) DWORD;
extern "user32" fn GetKeyboardLayout(thread_id: DWORD) callconv(.winapi) ?*anyopaque;
extern "user32" fn MapVirtualKeyExW(code: UINT, kind: UINT, layout: ?*anyopaque) callconv(.winapi) UINT;
extern "user32" fn PostMessageW(window: HWND, message: UINT, wparam: WPARAM, lparam: LPARAM) callconv(.winapi) BOOL;
extern "user32" fn SendInput(count: UINT, inputs: [*]const INPUT, size: i32) callconv(.winapi) UINT;
extern "user32" fn SetThreadDpiAwarenessContext(value: HWND) callconv(.winapi) HWND;
extern "user32" fn GetDpiForWindow(window: HWND) callconv(.winapi) UINT;

pub const ClickError = error{
    WindowNotMatched,
    ContentNotMatched,
    InvalidCoordinates,
    GeometryChanged,
    UserInputConflict,
    MoveFailed,
    DownFailed,
    UpFailed,
};

pub const KeyboardTargetError = error{
    WindowNotMatched,
    ForegroundMismatch,
};

pub const SendResult = struct {
    accepted: usize,
    total: usize,
};

const TopContext = struct {
    marker: []const u8,
    count: usize = 0,
    selected: HWND = null,
};

const ContentContext = struct {
    root: HWND,
    viewport_width: f64,
    viewport_height: f64,
    count: usize = 0,
    selected: HWND = null,
    width: i32 = 0,
    height: i32 = 0,
    hit_test: bool = false,
};

fn pointerFrom(value: LPARAM) *anyopaque {
    return @ptrFromInt(@as(usize, @intCast(value)));
}

fn lparamFor(pointer: *anyopaque) LPARAM {
    return @intCast(@intFromPtr(pointer));
}

fn equalsAsciiWide(value: []const u16, expected: []const u8) bool {
    if (value.len != expected.len) return false;
    for (value, expected) |wide, ascii| if (wide != ascii) return false;
    return true;
}

fn containsAsciiWide(value: []const u16, needle: []const u8) bool {
    if (needle.len == 0 or needle.len > value.len) return false;
    var start: usize = 0;
    while (start + needle.len <= value.len) : (start += 1) {
        if (equalsAsciiWide(value[start .. start + needle.len], needle)) return true;
    }
    return false;
}

fn classIs(window: HWND, expected: []const u8) bool {
    var buffer: [128]u16 = undefined;
    const length = GetClassNameW(window, &buffer, buffer.len);
    return length > 0 and equalsAsciiWide(buffer[0..@intCast(length)], expected);
}

fn topCallback(window: HWND, raw: LPARAM) callconv(.winapi) BOOL {
    const context: *TopContext = @ptrCast(@alignCast(pointerFrom(raw)));
    if (IsWindowVisible(window) == 0 or IsIconic(window) != 0 or !classIs(window, "Chrome_WidgetWin_1")) return 1;
    var title: [768]u16 = undefined;
    const length = GetWindowTextW(window, &title, title.len);
    if (length <= 0 or !containsAsciiWide(title[0..@intCast(length)], context.marker)) return 1;
    context.count += 1;
    if (context.count == 1) context.selected = window;
    return 1;
}

fn positiveClientRect(window: HWND) ?struct { width: i32, height: i32 } {
    var rect: RECT = undefined;
    if (GetClientRect(window, &rect) == 0) return null;
    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    return if (width > 0 and height > 0) .{ .width = width, .height = height } else null;
}

fn viewportMatches(width: i32, height: i32, css_width: f64, css_height: f64) bool {
    const left = @as(f64, @floatFromInt(width)) * css_height;
    const right = @as(f64, @floatFromInt(height)) * css_width;
    const rounding_bound = 2.0 * (css_width + css_height);
    return @abs(left - right) <= rounding_bound;
}

fn contentCallback(window: HWND, raw: LPARAM) callconv(.winapi) BOOL {
    const context: *ContentContext = @ptrCast(@alignCast(pointerFrom(raw)));
    if (IsWindowVisible(window) == 0 or !classIs(window, "Chrome_RenderWidgetHostHWND") or
        GetAncestor(window, 2) != context.root) return 1;
    const rect = positiveClientRect(window) orelse return 1;
    if (!viewportMatches(rect.width, rect.height, context.viewport_width, context.viewport_height)) return 1;
    if (context.hit_test and !isHitContent(context.root, window, rect.width, rect.height)) return 1;
    context.count += 1;
    if (context.count == 1) {
        context.selected = window;
        context.width = rect.width;
        context.height = rect.height;
    }
    return 1;
}

fn isHitContent(root: HWND, candidate: HWND, width: i32, height: i32) bool {
    var point: POINT = .{ .x = @divTrunc(width, 2), .y = @divTrunc(height, 2) };
    _ = MapWindowPoints(candidate, root, &point, 1);
    var parent = root;
    var depth: usize = 0;
    while (depth < 64) : (depth += 1) {
        // Parent-local hit testing is unaffected by other desktop windows and
        // follows the OS's child Z order. IsWindowVisible alone includes the
        // inactive Chromium tab hosts which remain stacked behind the active one.
        // Chromium's legacy input host deliberately has WS_EX_TRANSPARENT for
        // painting, but still handles mouse messages. Do not skip that style.
        const child = ChildWindowFromPointEx(parent, point, 0x0001 | 0x0002);
        if (child == candidate) return true;
        if (child == null or child == parent) return false;
        _ = MapWindowPoints(parent, child, &point, 1);
        parent = child;
    }
    return false;
}

fn held(key: i32) bool {
    return (GetAsyncKeyState(key) & @as(i16, @bitCast(@as(u16, 0x8000)))) != 0;
}

fn markedTopWindow(marker: []const u8) ?HWND {
    var top: TopContext = .{ .marker = marker };
    _ = EnumWindows(topCallback, lparamFor(&top));
    return if (top.count == 1 and top.selected != null) top.selected else null;
}

/// Browser adapter only: the reusable mouse backend receives an HWND, not a tab.
pub fn resolveMouseWindow(marker: []const u8, viewport: anytype) !usize {
    const previous_dpi = SetThreadDpiAwarenessContext(@ptrFromInt(@as(usize, @bitCast(@as(isize, -4)))));
    defer if (previous_dpi != null) { _ = SetThreadDpiAwarenessContext(previous_dpi); };
    const top = markedTopWindow(marker) orelse return error.WindowNotMatched;
    var content: ContentContext = .{ .root = top, .viewport_width = viewport.width, .viewport_height = viewport.height, .hit_test = true };
    _ = EnumChildWindows(top, contentCallback, lparamFor(&content));
    if (content.count != 1 or content.selected == null) return error.ContentNotMatched;
    return @intFromPtr(content.selected.?);
}

/// Measured while the active content host is available. Delivery uses the root
/// client area, which Chromium retains when occlusion reparents its legacy host.
pub const InputCalibration = struct {
    root: usize, content: usize, process_id: DWORD,
    root_width: i32, root_height: i32, dpi: UINT,
    x: i32, y: i32, width: i32, height: i32,
};

pub fn measureInput(marker: []const u8, viewport: anytype) !InputCalibration {
    const previous = SetThreadDpiAwarenessContext(@ptrFromInt(@as(usize, @bitCast(@as(isize, -4)))));
    defer if (previous != null) { _ = SetThreadDpiAwarenessContext(previous); };
    const top = markedTopWindow(marker) orelse return error.WindowNotMatched;
    var content: ContentContext = .{ .root = top, .viewport_width = viewport.width, .viewport_height = viewport.height, .hit_test = true };
    _ = EnumChildWindows(top, contentCallback, lparamFor(&content));
    if (content.count != 1 or content.selected == null) return error.ContentNotMatched;
    const root_rect = positiveClientRect(top) orelse return error.GeometryChanged;
    var point: POINT = .{ .x = 0, .y = 0 };
    _ = MapWindowPoints(content.selected, top, &point, 1);
    var pid: DWORD = 0;
    _ = GetWindowThreadProcessId(top, &pid);
    const dpi = GetDpiForWindow(top);
    if (pid == 0 or dpi == 0 or point.x < 0 or point.y < 0 or point.x >= root_rect.width or point.y >= root_rect.height) return error.GeometryChanged;
    return .{ .root = @intFromPtr(top.?), .content = @intFromPtr(content.selected.?), .process_id = pid,
        .root_width = root_rect.width, .root_height = root_rect.height, .dpi = dpi,
        .x = point.x, .y = point.y, .width = content.width, .height = content.height };
}

pub fn inputGeometryCurrent(value: InputCalibration) bool {
    const previous = SetThreadDpiAwarenessContext(@ptrFromInt(@as(usize, @bitCast(@as(isize, -4)))));
    defer if (previous != null) { _ = SetThreadDpiAwarenessContext(previous); };
    const root: HWND = @ptrFromInt(value.root);
    const content: HWND = @ptrFromInt(value.content);
    if (IsWindow(root) == 0 or IsWindowVisible(root) == 0 or IsIconic(root) != 0 or IsWindow(content) == 0) return false;
    var pid: DWORD = 0;
    _ = GetWindowThreadProcessId(root, &pid);
    if (pid != value.process_id or GetDpiForWindow(root) != value.dpi) return false;
    const size = positiveClientRect(root) orelse return false;
    const content_size = positiveClientRect(content) orelse return false;
    if (size.width != value.root_width or size.height != value.root_height or content_size.width != value.width or content_size.height != value.height) return false;
    if (IsWindowVisible(content) != 0) {
        if (GetAncestor(content, 2) != root or !isHitContent(root, content, content_size.width, content_size.height)) return false;
        var point: POINT = .{ .x = 0, .y = 0 };
        _ = MapWindowPoints(content, root, &point, 1);
        if (point.x != value.x or point.y != value.y) return false;
    }
    // A covered legacy host has no meaningful screen origin. Root-relative
    // geometry remains valid; native ClientToScreen reads the current position.
    return true;
}

pub fn verifyInputMarker(marker: []const u8, value: InputCalibration) !void {
    // Calibration already resolved a unique root. Check that exact recipient,
    // including between events of one sequence (a key may switch active tabs).
    var title: [768]u16 = undefined;
    const length = GetWindowTextW(@ptrFromInt(value.root), &title, title.len);
    if (length <= 0 or !containsAsciiWide(title[0..@intCast(length)], marker)) return error.WindowNotMatched;
}

fn mouseDiagnosticCallback(window: HWND, raw: LPARAM) callconv(.winapi) BOOL {
    const context: *TopContext = @ptrCast(@alignCast(pointerFrom(raw)));
    var name: [128]u16 = undefined;
    const length = GetClassNameW(window, &name, name.len);
    const rect = positiveClientRect(window);
    // Only the already-marked test/command target's native geometry, no page text.
    if (length > 0 and classIs(window, "Chrome_RenderWidgetHostHWND")) {
        var title: [768]u16 = undefined;
        const count = GetWindowTextW(window, &title, title.len);
        var pt: POINT = .{ .x = if (rect) |r| @divTrunc(r.width, 2) else 0, .y = if (rect) |r| @divTrunc(r.height, 2) else 0 };
        _ = MapWindowPoints(window, context.selected, &pt, 1);
        const hit = ChildWindowFromPointEx(context.selected, pt, 0);
        std.log.warn("mouse target child hwnd={d} visible={d} size={any} style={x} ex={x} titleMarker={any} hit={d} activeHit={any}", .{
            @intFromPtr(window.?), IsWindowVisible(window), rect, GetWindowLongPtrW(window, -16), GetWindowLongPtrW(window, -20),
            count > 0 and containsAsciiWide(title[0..@intCast(count)], context.marker), if (hit) |w| @intFromPtr(w) else 0,
            if (rect) |r| isHitContent(context.selected, window, r.width, r.height) else false });
    }
    return 1;
}

pub fn diagnoseMouseWindow(marker: []const u8, viewport: anytype) void {
    const previous_dpi = SetThreadDpiAwarenessContext(@ptrFromInt(@as(usize, @bitCast(@as(isize, -4)))));
    defer if (previous_dpi != null) { _ = SetThreadDpiAwarenessContext(previous_dpi); };
    if (markedTopWindow(marker)) |top| {
        std.log.warn("mouse target viewport={any}", .{viewport});
        var context: TopContext = .{ .marker = marker, .selected = top };
        _ = EnumChildWindows(top, mouseDiagnosticCallback, lparamFor(&context));
    }
}

pub fn keyboardTargetReady(marker: []const u8) KeyboardTargetError!void {
    const top = markedTopWindow(marker) orelse return error.WindowNotMatched;
    if (GetForegroundWindow() != top) return error.ForegroundMismatch;
}

fn trackedModifierFamily(owners: *const [256]u64, virtual_key: usize) bool {
    return switch (virtual_key) {
        0x10 => owners[0xa0] != 0 or owners[0xa1] != 0,
        0x11 => owners[0xa2] != 0 or owners[0xa3] != 0,
        0x12 => owners[0xa4] != 0 or owners[0xa5] != 0,
        0xa0, 0xa1 => owners[0x10] != 0,
        0xa2, 0xa3 => owners[0x11] != 0,
        0xa4, 0xa5 => owners[0x12] != 0,
        else => false,
    };
}

pub fn hasUntrackedUserInput(owners: *const [256]u64) bool {
    var virtual_key: usize = 1;
    while (virtual_key < owners.len) : (virtual_key += 1) {
        if (owners[virtual_key] == 0 and !trackedModifierFamily(owners, virtual_key) and held(@intCast(virtual_key))) return true;
    }
    return false;
}

test "aggregate and sided modifier virtual keys share one tracked family" {
    var owners = [_]u64{0} ** 256;
    try std.testing.expect(!trackedModifierFamily(&owners, 0x11));
    owners[0xa2] = 7;
    try std.testing.expect(trackedModifierFamily(&owners, 0x11));
    owners[0xa2] = 0;
    owners[0x11] = 7;
    try std.testing.expect(trackedModifierFamily(&owners, 0xa2));
    try std.testing.expect(trackedModifierFamily(&owners, 0xa3));
}

fn keyboardInput(virtual_key: u16, scan_code: u16, flags: DWORD, source_tag: usize) INPUT {
    return .{
        .kind = 1,
        .value = .{ .keyboard = .{
            .virtual_key = virtual_key,
            .scan_code = scan_code,
            .flags = flags,
            .time = 0,
            .extra_info = source_tag,
        } },
    };
}

pub fn sendVirtualKey(virtual_key: u16, extended: bool, down: bool, source_tag: usize) SendResult {
    const extended_flag: DWORD = if (extended) 0x0001 else 0;
    const up_flag: DWORD = if (down) 0 else 0x0002;
    const target_thread = GetWindowThreadProcessId(GetForegroundWindow(), null);
    const scan: u16 = @intCast(MapVirtualKeyExW(virtual_key, 0, GetKeyboardLayout(target_thread)) & 0xff);
    // Keep virtual-key semantics, but include its layout-specific physical code
    // so consumers of KeyboardEvent.code receive the same key identity.
    const input = keyboardInput(virtual_key, scan, extended_flag | up_flag, source_tag);
    return .{ .accepted = SendInput(1, @ptrCast(&input), @sizeOf(INPUT)), .total = 1 };
}

pub fn sendUnicodeScalar(codepoint: u21, source_tag: usize) SendResult {
    var units: [2]u16 = undefined;
    const unit_count: usize = if (codepoint <= 0xffff) single: {
        units[0] = @intCast(codepoint);
        break :single 1;
    } else supplementary: {
        const value: u32 = @as(u32, codepoint) - 0x10000;
        units[0] = @intCast(0xd800 + (value >> 10));
        units[1] = @intCast(0xdc00 + (value & 0x3ff));
        break :supplementary 2;
    };
    var inputs: [4]INPUT = undefined;
    var input_count: usize = 0;
    var index: usize = 0;
    while (index < unit_count) : (index += 1) {
        inputs[input_count] = keyboardInput(0, units[index], 0x0004, source_tag);
        input_count += 1;
        inputs[input_count] = keyboardInput(0, units[index], 0x0004 | 0x0002, source_tag);
        input_count += 1;
    }
    return .{
        .accepted = SendInput(@intCast(input_count), &inputs, @sizeOf(INPUT)),
        .total = input_count,
    };
}

fn pointLparam(request: anytype, width: i32, height: i32) ClickError!LPARAM {
    const scaled_x = @round(request.point.x * @as(f64, @floatFromInt(width)) / request.viewport.width);
    const scaled_y = @round(request.point.y * @as(f64, @floatFromInt(height)) / request.viewport.height);
    if (!std.math.isFinite(scaled_x) or !std.math.isFinite(scaled_y)) return error.InvalidCoordinates;
    var x: i32 = @intFromFloat(scaled_x);
    var y: i32 = @intFromFloat(scaled_y);
    x = @min(x, width - 1);
    y = @min(y, height - 1);
    if (x < 0 or y < 0 or x > 32767 or y > 32767) return error.InvalidCoordinates;
    const packed_value = (@as(u32, @intCast(y)) << 16) | @as(u32, @intCast(x));
    return @intCast(packed_value);
}

pub fn click(request: anytype) ClickError!void {
    const per_monitor_v2: HWND = @ptrFromInt(@as(usize, @bitCast(@as(isize, -4))));
    const previous_dpi = SetThreadDpiAwarenessContext(per_monitor_v2);
    defer _ = SetThreadDpiAwarenessContext(previous_dpi);

    const top_window = markedTopWindow(request.marker) orelse return error.WindowNotMatched;

    var content: ContentContext = .{
        .root = top_window,
        .viewport_width = request.viewport.width,
        .viewport_height = request.viewport.height,
    };
    _ = EnumChildWindows(top_window, contentCallback, lparamFor(&content));
    if (content.count != 1 or content.selected == null) return error.ContentNotMatched;

    if (held(1) or held(2) or held(4) or held(16) or held(17) or held(18)) return error.UserInputConflict;
    if (IsWindow(top_window) == 0 or IsWindowVisible(top_window) == 0 or IsIconic(top_window) != 0 or
        IsWindow(content.selected) == 0 or IsWindowVisible(content.selected) == 0 or
        GetAncestor(content.selected, 2) != top_window) return error.GeometryChanged;
    const current = positiveClientRect(content.selected) orelse return error.GeometryChanged;
    if (current.width != content.width or current.height != content.height) return error.GeometryChanged;
    const lparam = try pointLparam(request, current.width, current.height);

    if (PostMessageW(content.selected, 0x0200, 0, lparam) == 0) return error.MoveFailed;
    if (PostMessageW(content.selected, 0x0201, 1, lparam) == 0) return error.DownFailed;
    if (PostMessageW(content.selected, 0x0202, 0, lparam) == 0) {
        _ = PostMessageW(content.selected, 0x0202, 0, lparam);
        return error.UpFailed;
    }
}

test "viewport aspect check derives its tolerance only from pixel rounding" {
    try std.testing.expect(viewportMatches(1200, 900, 800, 600));
    try std.testing.expect(!viewportMatches(1200, 800, 800, 600));
}

test "CSS viewport coordinates scale once into the content client" {
    const request = .{
        .point = .{ .x = 250.0, .y = 240.0 },
        .viewport = .{ .width = 800.0, .height = 600.0 },
    };
    const value = try pointLparam(request, 1200, 900);
    try std.testing.expectEqual(@as(LPARAM, (360 << 16) | 375), value);
}
