const std = @import("std");

const BOOL = i32;
const UINT = u32;
const WPARAM = usize;
const LPARAM = isize;
const HWND = ?*anyopaque;

const RECT = extern struct { left: i32, top: i32, right: i32, bottom: i32 };
const EnumProc = *const fn (HWND, LPARAM) callconv(.winapi) BOOL;

extern "user32" fn EnumWindows(callback: EnumProc, value: LPARAM) callconv(.winapi) BOOL;
extern "user32" fn EnumChildWindows(parent: HWND, callback: EnumProc, value: LPARAM) callconv(.winapi) BOOL;
extern "user32" fn GetClassNameW(window: HWND, buffer: [*]u16, maximum: i32) callconv(.winapi) i32;
extern "user32" fn GetWindowTextW(window: HWND, buffer: [*]u16, maximum: i32) callconv(.winapi) i32;
extern "user32" fn GetClientRect(window: HWND, rect: *RECT) callconv(.winapi) BOOL;
extern "user32" fn GetAncestor(window: HWND, flags: UINT) callconv(.winapi) HWND;
extern "user32" fn IsWindow(window: HWND) callconv(.winapi) BOOL;
extern "user32" fn IsWindowVisible(window: HWND) callconv(.winapi) BOOL;
extern "user32" fn IsIconic(window: HWND) callconv(.winapi) BOOL;
extern "user32" fn GetAsyncKeyState(key: i32) callconv(.winapi) i16;
extern "user32" fn PostMessageW(window: HWND, message: UINT, wparam: WPARAM, lparam: LPARAM) callconv(.winapi) BOOL;
extern "user32" fn SetThreadDpiAwarenessContext(value: HWND) callconv(.winapi) HWND;

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
    context.count += 1;
    if (context.count == 1) {
        context.selected = window;
        context.width = rect.width;
        context.height = rect.height;
    }
    return 1;
}

fn held(key: i32) bool {
    return (GetAsyncKeyState(key) & @as(i16, @bitCast(@as(u16, 0x8000)))) != 0;
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

    var top: TopContext = .{ .marker = request.marker };
    _ = EnumWindows(topCallback, lparamFor(&top));
    if (top.count != 1 or top.selected == null) return error.WindowNotMatched;

    var content: ContentContext = .{
        .root = top.selected,
        .viewport_width = request.viewport.width,
        .viewport_height = request.viewport.height,
    };
    _ = EnumChildWindows(top.selected, contentCallback, lparamFor(&content));
    if (content.count != 1 or content.selected == null) return error.ContentNotMatched;

    if (held(1) or held(2) or held(4) or held(16) or held(17) or held(18)) return error.UserInputConflict;
    if (IsWindow(top.selected) == 0 or IsWindowVisible(top.selected) == 0 or IsIconic(top.selected) != 0 or
        IsWindow(content.selected) == 0 or IsWindowVisible(content.selected) == 0 or
        GetAncestor(content.selected, 2) != top.selected) return error.GeometryChanged;
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
