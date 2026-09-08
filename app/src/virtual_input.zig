const std = @import("std");
const builtin = @import("builtin");
const config = @import("generated_config.zig");
const mouse = @import("virtual_mouse/core.zig");
const keyboard = @import("virtual_input/keyboard.zig");
const windows = @import("virtual_mouse/windows/backend.zig");
const browser = @import("native_input/windows.zig");
const native = @import("native_input.zig");

pub const supported = builtin.os.tag == .windows and builtin.cpu.arch == .x86_64;
pub const Viewport = struct { width: f64, height: f64 };
pub const Action = struct {
    kind: enum { move, moveWindow, button, wheel, wait }, x: ?i32 = null, y: ?i32 = null,
    button: ?mouse.Button = null, action: ?mouse.ButtonAction = null,
    deltaX: ?i16 = null, deltaY: ?i16 = null,
    waitMs: ?u32 = null,
};
pub const Operation = struct {
    kind: enum { create, get, calibrate, input, keyboard, interception, reset, keyboardReset, destroy, releaseWindow, cleanup },
    inputId: ?[]const u8 = null, windowId: ?i32 = null,
    marker: ?[]const u8 = null, viewport: ?Viewport = null,
    documentId: ?[]const u8 = null, refresh: bool = true,
    actions: ?[]const Action = null, keyboardActions: ?[]const keyboard.Action = null, enabled: ?bool = null,
};
const maximum = config.virtual_mouse_maximum_objects;
const Object = struct {
    id: u64, namespace: u64,
    retired: bool = false,
    mouse: mouse.State = .{ .point = .{ .x = 0, .y = 0 } },
    keyboard: keyboard.State = .{},
};
const Target = struct {
    input_id: u64, window_id: i32, backend: windows.Mouse, viewport: ?Viewport = null,
    root: usize = 0, calibration: ?browser.InputCalibration = null, document: ?[32]u8 = null,
    // Resource receipts, not another logical device: release only events actually delivered here.
    last_native_point: mouse.Point = .{ .x = 0, .y = 0 }, last_coordinates: @FieldType(mouse.State, "coordinates") = .css_viewport, delivered_buttons: u8 = 0,
    delivered_keys: [256]bool = @splat(false), key_extended: [256]bool = @splat(false),
    key_scan: [256]?u16 = @splat(null), key_layout: [256]usize = @splat(0),
};
pub const Snapshot = struct {
    id: u64, mouse: mouse.State,
    // u16 forces JSON numeric array: Zig encodes u8 arrays as strings.
    keyboard: struct { keys: [256]u16, extended: [256]bool, known: bool },
    windows: [maximum]?struct { windowId: i32, alive: bool, interception: bool } = @splat(null),
};
pub const Result = struct { completedActions: usize = 0, submittedScalars: usize = 0, input: ?Snapshot = null, calibration: ?struct { updated: bool } = null };
var mutex: std.Io.Mutex = .init;
var objects: [maximum]?Object = @splat(null);
var targets: [maximum]?Target = @splat(null);
var next_id: u64 = 1;

fn snapshot(object: *const Object) Snapshot {
    var value: Snapshot = .{ .id = object.id, .mouse = object.mouse, .keyboard = .{ .keys = undefined, .extended = object.keyboard.extended, .known = object.keyboard.known } };
    for (object.keyboard.keys, 0..) |key, index| value.keyboard.keys[index] = key;
    var count: usize = 0;
    for (&targets) |*item| if (item.*) |*target| {
        if (target.input_id != object.id) continue;
        value.windows[count] = .{ .windowId = target.window_id, .alive = target.backend.alive(), .interception = target.backend.intercepting() };
        count += 1;
    };
    return value;
}
fn get(namespace: u64, id: u64) !*Object {
    for (&objects) |*item| if (item.*) |*object| { if (!object.retired and object.namespace == namespace and object.id == id) return object; };
    return error.InputNotFound;
}
fn allocate(namespace: u64) !*Object {
    if (next_id > 9007199254740991 or next_id == 0) return error.ObjectLimit;
    for (&objects) |*item| if (item.* == null) {
        item.* = .{ .id = next_id, .namespace = namespace };
        next_id += 1;
        return &item.*.?;
    };
    return error.ObjectLimit;
}
fn remaining(io: std.Io, started: i96, timeout: u32) !u32 {
    const elapsed = @divTrunc(std.Io.Clock.awake.now(io).nanoseconds - started, std.time.ns_per_ms);
    if (elapsed >= timeout) return error.InputTimeout;
    return timeout - @as(u32, @intCast(@max(0, elapsed)));
}
fn validateWindowTarget(operation: Operation) !void {
    const marker = operation.marker orelse return error.InvalidInput;
    if (marker.len < 12 or marker.len > 96 or (operation.windowId orelse 0) <= 0) return error.InvalidInput;
    for (marker) |byte| if (byte < 0x20 or byte > 0x7e) return error.InvalidInput;
}
fn validateTarget(operation: Operation) ![32]u8 {
    try validateWindowTarget(operation);
    const viewport = operation.viewport orelse return error.InvalidInput;
    if (!std.math.isFinite(viewport.width) or !std.math.isFinite(viewport.height) or viewport.width <= 0 or viewport.height <= 0) return error.InvalidInput;
    const document = operation.documentId orelse return error.InvalidInput;
    if (document.len == 0 or (operation.windowId orelse 0) <= 0) return error.InvalidInput;
    var hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(document, &hash, .{});
    return hash;
}
fn measure(io: std.Io, operation: Operation, started: i96, timeout: u32) !browser.InputCalibration {
    return browser.measureInputReady(io, operation.marker.?, operation.viewport.?, started, timeout, config.native_input_window_match_poll_ms);
}
fn targetFor(io: std.Io, object: *Object, operation: Operation, started: i96, timeout: u32) !*Target {
    const document = try validateTarget(operation);
    for (&targets) |*item| if (item.*) |*target| {
        if (target.input_id != object.id or target.window_id != operation.windowId.?) continue;
        if (target.document == null or !std.mem.eql(u8, &target.document.?, &document) or !std.meta.eql(target.viewport, operation.viewport)) return error.CalibrationStale;
        target.backend.begin(try remaining(io, started, timeout));
        if (!target.backend.alive() or (target.calibration == null or !browser.inputGeometryCurrent(target.calibration.?))) return error.CalibrationStale;
        while (true) {
            browser.verifyInputMarker(operation.marker.?, target.calibration.?) catch |err| {
                if (err != error.WindowNotMatched) return err;
                const budget = remaining(io, started, timeout) catch return err;
                try io.sleep(.fromMilliseconds(@intCast(@min(budget, config.native_input_window_match_poll_ms))), .awake);
                continue;
            };
            return target;
        }
    };
    return error.CalibrationRequired;
}
fn calibrate(io: std.Io, object: *Object, operation: Operation, started: i96, timeout: u32, updated: *bool) !*Target {
    const document = try validateTarget(operation);
    if (!operation.refresh) {
        if (targetFor(io, object, operation, started, timeout)) |target| { updated.* = false; return target; } else |err| {
            if (err != error.CalibrationRequired and err != error.CalibrationStale) return err;
        }
    }
    const value = try measure(io, operation, started, timeout);
    const window_id = operation.windowId.?;
    var vacant: ?*?Target = null;
    var was_intercepting = false;
    for (&targets) |*item| {
        if (item.*) |*target| {
            if (target.input_id == object.id and target.window_id == window_id) {
                target.backend.begin(try remaining(io, started, timeout));
                if (target.root == value.root and target.backend.alive()) {
                    target.viewport = operation.viewport.?;
                    target.calibration = value;
                    target.document = document;
                    updated.* = true;
                    return target;
                }
                was_intercepting = target.backend.intercepting();
                // Retarget resources, never synthesize old document down/up events.
                try target.backend.detach();
                target.backend.close();
                item.* = null;
                vacant = item;
            }
        } else if (vacant == null) vacant = item;
    }
    const slot = vacant orelse return error.ObjectLimit;
    const backend = try windows.Mouse.open(value.root, try remaining(io, started, timeout));
    slot.* = .{ .input_id = object.id, .window_id = window_id, .backend = backend, .viewport = operation.viewport.?, .root = value.root, .calibration = value, .document = document };
    if (was_intercepting) try backend.intercept(true);
    updated.* = true;
    return &slot.*.?;
}
fn windowTarget(io: std.Io, object: *Object, operation: Operation, started: i96, timeout: u32) !*Target {
    try validateWindowTarget(operation);
    const root = try browser.resolveRootWindowReady(io, operation.marker.?, started, timeout, config.native_input_window_match_poll_ms);
    var vacant: ?*?Target = null;
    for (&targets) |*item| {
        if (item.*) |*target| {
            if (target.input_id != object.id or target.window_id != operation.windowId.?) continue;
            target.backend.begin(try remaining(io, started, timeout));
            if (target.root == root and target.backend.alive()) return target;
            return error.TargetLost;
        } else if (vacant == null) vacant = item;
    }
    const slot = vacant orelse return error.ObjectLimit;
    slot.* = .{ .input_id = object.id, .window_id = operation.windowId.?, .backend = try windows.Mouse.open(root, try remaining(io, started, timeout)),
        .root = root };
    return &slot.*.?;
}
fn verifyTarget(target: *Target, marker: []const u8, page_coordinates: bool) !void {
    if (!target.backend.alive()) return error.TargetLost;
    if (page_coordinates) {
        const value = target.calibration orelse return error.CalibrationRequired;
        if (!browser.inputGeometryCurrent(value)) return error.CalibrationStale;
    }
    try browser.verifyRootMarker(marker, target.root);
}
fn projectPoint(point: mouse.Point, target: *Target) !mouse.Point {
    const value = target.calibration orelse return error.CalibrationRequired;
    const exact_x = @as(f64, @floatFromInt(value.x)) + @as(f64, @floatFromInt(point.x)) * @as(f64, @floatFromInt(value.width)) / target.viewport.?.width;
    const exact_y = @as(f64, @floatFromInt(value.y)) + @as(f64, @floatFromInt(point.y)) * @as(f64, @floatFromInt(value.height)) / target.viewport.?.height;
    // Do not round an interior fractional pixel onto the exclusive root edge.
    // Genuinely out-of-bounds CSS/native points remain invalid, not clamped.
    const x = if (exact_x >= 0 and exact_x < value.root_width) @min(@round(exact_x), value.root_width - 1) else @round(exact_x);
    const y = if (exact_y >= 0 and exact_y < value.root_height) @min(@round(exact_y), value.root_height - 1) else @round(exact_y);
    if (!std.math.isFinite(x) or !std.math.isFinite(y) or x < std.math.minInt(i32) or y < std.math.minInt(i32) or x > std.math.maxInt(i32) or y > std.math.maxInt(i32)) return error.InvalidInput;
    return .{ .x = @intFromFloat(x), .y = @intFromFloat(y) };
}
fn pointerContext(object: *const Object, target: *Target) !mouse.State {
    var value = object.mouse;
    if (value.coordinates == .css_viewport) value.point = try projectPoint(value.point, target);
    return value;
}
fn nativePoint(state: mouse.State, target: *Target) !mouse.Point {
    const point = state.point;
    if (state.coordinates == .window) {
        const size = try target.backend.windowBounds();
        if (point.x < 0 or point.y < 0 or point.x >= size.width or point.y >= size.height or point.x > 32767 or point.y > 32767) return error.InvalidInput;
        return point;
    }
    const projected = try projectPoint(point, target);
    const x = projected.x; const y = projected.y;
    const size = target.backend.bounds();
    if (point.x < 0 or point.y < 0 or @as(f64, @floatFromInt(point.x)) >= target.viewport.?.width or
        @as(f64, @floatFromInt(point.y)) >= target.viewport.?.height or x < 0 or y < 0 or x > 32767 or y > 32767 or
        x >= size.width or y >= size.height) return error.InvalidInput;
    return projected;
}
fn actionFor(wire: Action) !mouse.Action {
    if (wire.waitMs != null) return error.InvalidInput;
    return switch (wire.kind) {
        .move, .moveWindow => if (wire.button == null and wire.action == null and wire.deltaX == null and wire.deltaY == null)
            if (wire.kind == .moveWindow) .{ .moveWindow = .{ .x = wire.x orelse return error.InvalidInput, .y = wire.y orelse return error.InvalidInput } } else .{ .move = .{ .x = wire.x orelse return error.InvalidInput, .y = wire.y orelse return error.InvalidInput } } else error.InvalidInput,
        .button => if (wire.x == null and wire.y == null and wire.deltaX == null and wire.deltaY == null)
            .{ .button = .{ .button = wire.button orelse return error.InvalidInput, .action = wire.action orelse return error.InvalidInput } } else error.InvalidInput,
        .wheel => if (wire.x == null and wire.y == null and wire.button == null and wire.action == null)
            .{ .wheel = .{ .delta_x = wire.deltaX orelse return error.InvalidInput, .delta_y = wire.deltaY orelse return error.InvalidInput } } else error.InvalidInput,
        .wait => error.InvalidInput,
    };
}
fn sendMouse(object: *Object, target: *Target, marker: []const u8, event: mouse.Event) !void {
    try verifyTarget(target, marker, event.state.coordinates == .css_viewport);
    var native_event = event;
    native_event.state.point = try nativePoint(event.state, target);
    try target.backend.context(&object.keyboard.keys, @intCast(object.id), native_event.state);
    target.backend.send(native_event) catch |err| { object.mouse.known = false; return err; };
    object.mouse = event.state; // One pointer, with an explicit coordinate space.
    target.last_native_point = native_event.state.point;
    target.last_coordinates = native_event.state.coordinates;
    target.delivered_buttons = event.state.buttons;
}
fn sendKey(io: std.Io, object: *Object, target: *Target, marker: []const u8, key: keyboard.Key, down: bool, repeated: bool) !void {
    try verifyTarget(target, marker, object.mouse.coordinates == .css_viewport);
    var next = object.keyboard;
    next.set(key, down);
    try target.backend.context(&next.keys, @intCast(object.id), try pointerContext(object, target));
    if (!down) try native.releaseKeyOwned(io, object.id, key.virtualKey);
    const releasing_receipt = !down and target.delivered_keys[key.virtualKey];
    const layout = if (releasing_receipt) target.key_layout[key.virtualKey] else if (key.layout) |value| try std.fmt.parseUnsigned(usize, value, 16) else 0;
    const scan = if (releasing_receipt) target.key_scan[key.virtualKey] else key.scanCode;
    target.backend.keyExact(key.virtualKey, key.extended, down, scan, layout, repeated) catch |err| { object.keyboard.known = false; return err; };
    object.keyboard = next;
    target.delivered_keys[key.virtualKey] = down;
    target.key_extended[key.virtualKey] = key.extended;
    target.key_scan[key.virtualKey] = target.backend.lastKeyScan();
    target.key_layout[key.virtualKey] = layout;
}
fn sendKeyboardMessage(io: std.Io, object: *Object, target: *Target, marker: []const u8, message: keyboard.Message) !void {
    try verifyTarget(target, marker, object.mouse.coordinates == .css_viewport);
    const next = try keyboard.project(object.keyboard, .{ .kind = "message", .message = message });
    const key = try keyboard.messageKey(message);
    const down = message.message == 0x100 or message.message == 0x104;
    if (key) |value| if (!down) try native.releaseKeyOwned(io, object.id, value.virtualKey);
    const layout = if (message.layout) |value| try std.fmt.parseUnsigned(usize, value, 16) else 0;
    try target.backend.context(&next.keys, @intCast(object.id), try pointerContext(object, target));
    target.backend.keyboardMessage(message.message, message.value, message.bits, layout) catch |err| { object.keyboard.known = false; return err; };
    object.keyboard = next;
    if (key) |value| {
        target.delivered_keys[value.virtualKey] = down;
        target.key_extended[value.virtualKey] = value.extended;
        target.key_scan[value.virtualKey] = value.scanCode;
        target.key_layout[value.virtualKey] = layout;
    }
}

fn sendText(io: std.Io, object: *Object, target: *Target, operation: Operation, started: i96, timeout: u32, text: []const u8, progress: *Result) !void {
    var iterator = (try std.unicode.Utf8View.init(text)).iterator();
    while (iterator.nextCodepoint()) |scalar| {
        target.backend.begin(try remaining(io, started, timeout));
        try verifyTarget(target, operation.marker.?, object.mouse.coordinates == .css_viewport);
        try target.backend.context(&object.keyboard.keys, @intCast(object.id), try pointerContext(object, target));
        if (scalar <= 0xffff) try target.backend.character(@intCast(scalar)) else {
            const value = scalar - 0x10000;
            try target.backend.character(@intCast(0xd800 + (value >> 10)));
            try target.backend.character(@intCast(0xdc00 + (value & 0x3ff)));
        }
        progress.submittedScalars += 1;
    }
}
fn wait(io: std.Io, started: i96, timeout: u32, duration: u32) !void {
    if (duration >= try remaining(io, started, timeout)) return error.InputTimeout;
    if (duration > 0) try io.sleep(.fromMilliseconds(duration), .awake);
    _ = try remaining(io, started, timeout);
}
fn releaseTargets(object: *Object, window_id: ?i32, timeout: u32, release_buttons: bool) !void {
    for (&targets) |*item| if (item.*) |*target| {
        if (target.input_id != object.id or (window_id != null and target.window_id != window_id.?)) continue;
        target.backend.begin(timeout);
        if (release_buttons and target.backend.alive()) {
            const reset = mouse.resetPlan(.{ .point = target.last_native_point, .coordinates = target.last_coordinates, .buttons = target.delivered_buttons });
            for (reset.events[0..reset.count]) |event| {
                // Cleanup uses the last target point; a resize cannot strand a held input.
                var native_event = event;
                native_event.state.point = target.last_native_point;
                try target.backend.context(&object.keyboard.keys, @intCast(object.id), native_event.state);
                try target.backend.release(native_event);
                target.delivered_buttons = event.state.buttons;
            }
        }
        try releaseTargetKeys(object, target);
        try target.backend.detach();
        target.backend.close();
        item.* = null;
    };
}
fn releaseTargetKeys(object: *Object, target: *Target) !void {
    if (!target.backend.alive()) return;
    var next = object.keyboard;
    for (target.delivered_keys, 0..) |held, vk| {
        if (!held) continue;
        next.set(.{ .virtualKey = @intCast(vk), .extended = target.key_extended[vk] }, false);
        try target.backend.context(&next.keys, @intCast(object.id), .{ .point = target.last_native_point, .coordinates = target.last_coordinates, .buttons = target.delivered_buttons });
        try target.backend.keyExact(@intCast(vk), target.key_extended[vk], false, target.key_scan[vk], target.key_layout[vk], false);
        target.delivered_keys[vk] = false;
    }
}
fn resetKeyboard(io: std.Io, object: *Object, timeout: u32) !void {
    try native.releaseOwned(io, object.id, null);
    for (&targets) |*item| if (item.*) |*target| {
        if (target.input_id != object.id or !target.backend.alive()) continue;
        target.backend.begin(timeout);
        try releaseTargetKeys(object, target);
    };
    object.keyboard.reset();
}
pub fn execute(io: std.Io, namespace: u64, timeout: u32, operation: Operation, progress: *Result) !Result {
    if (!supported) return error.PlatformUnsupported;
    if (namespace == 0 or timeout == 0 or timeout > config.virtual_mouse_maximum_timeout_ms) return error.InvalidInput;
    const started = std.Io.Clock.awake.now(io).nanoseconds;
    mutex.lockUncancelable(io);
    defer mutex.unlock(io);
    _ = try remaining(io, started, timeout);
    if (operation.kind == .create) {
        if (operation.inputId != null or operation.marker != null or operation.actions != null) return error.InvalidInput;
        return .{ .input = snapshot(try allocate(namespace)) };
    }
    if (operation.kind == .cleanup and operation.inputId == null) { cleanupLocked(io, namespace, timeout); return .{}; }
    const id = try std.fmt.parseUnsigned(u64, operation.inputId orelse return error.InvalidInput, 10);
    const object = get(namespace, id) catch |err| find_retired: {
        if (operation.kind == .releaseWindow) {
            for (objects) |item| if (item) |candidate| { if (candidate.id == id) return err; };
            return .{}; // An already retired/expired object has no remaining resource.
        }
        if (operation.kind != .cleanup) return err;
        // Internal cleanup may finish an exact retired object after reconnect. Live foreign objects are never eligible.
        for (&objects) |*item| if (item.*) |*candidate| {
            if (candidate.id == id) {
                if (!candidate.retired) return error.InputOwnerMismatch;
                break :find_retired candidate;
            }
        };
        return .{};
    };
    defer { if (get(namespace, id)) |current| { progress.input = snapshot(current); } else |_| { progress.input = null; } }
    switch (operation.kind) {
        .get => {},
        .calibrate => {
            var updated = false;
            _ = try calibrate(io, object, operation, started, timeout, &updated);
            return .{ .input = snapshot(object), .calibration = .{ .updated = updated } };
        },
        .destroy, .cleanup => {
            try native.releaseOwned(io, object.id, null);
            try releaseTargets(object, null, timeout, true);
            for (&objects) |*item| if (item.*) |current| { if (current.id == id) { item.* = null; break; } };
            return .{};
        },
        .releaseWindow => {
            const window_id = operation.windowId orelse return error.InvalidInput;
            try native.releaseOwned(io, object.id, window_id);
            try releaseTargets(object, window_id, timeout, true);
        },
        .reset => {
            try releaseTargets(object, null, timeout, true);
            object.mouse.buttons = 0;
            object.mouse.known = true;
        },
        .keyboardReset => try resetKeyboard(io, object, timeout),
        .input, .keyboard, .interception => {
            var window_coordinates = object.mouse.coordinates == .window;
            if (operation.actions) |actions| {
                for (actions) |action| {
                    if (action.kind == .move) { window_coordinates = false; break; }
                    if (action.kind == .moveWindow) window_coordinates = true;
                }
            }
            const target = if (window_coordinates) try windowTarget(io, object, operation, started, timeout) else try targetFor(io, object, operation, started, timeout);
            if (operation.kind == .interception) {
                try target.backend.context(&object.keyboard.keys, @intCast(object.id), try pointerContext(object, target));
                try target.backend.intercept(operation.enabled orelse return error.InvalidInput);
            } else if (operation.kind == .input) {
                if (!object.keyboard.known) return error.StateUnknown;
                const actions = operation.actions orelse return error.InvalidInput;
                if (actions.len == 0 or actions.len > config.virtual_mouse_maximum_actions) return error.InvalidInput;
                var projected = object.mouse;
                for (actions) |action| {
                    if (action.kind == .wait) {
                        if (action.x != null or action.y != null or action.button != null or action.action != null or action.deltaX != null or action.deltaY != null or action.waitMs == null or action.waitMs.? > config.virtual_mouse_maximum_wait_ms) return error.InvalidInput;
                        continue;
                    }
                    const steps = try mouse.plan(projected, try actionFor(action));
                    for (steps.events[0..steps.count]) |event| { _ = try nativePoint(event.state, target); projected = event.state; }
                }
                for (actions) |action| {
                    if (action.kind == .wait) { try wait(io, started, timeout, action.waitMs.?); progress.completedActions += 1; continue; }
                    target.backend.begin(try remaining(io, started, timeout));
                    const steps = try mouse.plan(object.mouse, try actionFor(action));
                    for (steps.events[0..steps.count]) |event| try sendMouse(object, target, operation.marker.?, event);
                    progress.completedActions += 1;
                }
            } else {
                const actions = operation.keyboardActions orelse return error.InvalidInput;
                if (!native.validKeyboardActions(actions, true)) return error.InvalidInput;
                var projected = object.keyboard;
                for (actions) |action| {
                    if (action.message) |message| if (message.message == 0x100 or message.message == 0x104) {
                        if (message.layout) |layout| if (!windows.layoutAvailable(try std.fmt.parseUnsigned(usize, layout, 16))) return error.KeyboardLayoutUnavailable;
                    };
                    if (!std.mem.eql(u8, action.kind, "up")) if (action.keys) |keys| for (keys) |key| {
                        if (key.layout) |layout| if (!windows.layoutAvailable(try std.fmt.parseUnsigned(usize, layout, 16))) return error.KeyboardLayoutUnavailable;
                    };
                    projected = try keyboard.project(projected, action);
                }
                for (actions) |action| {
                    target.backend.begin(try remaining(io, started, timeout));
                    if (std.mem.eql(u8, action.kind, "wait")) { try wait(io, started, timeout, action.waitMs.?); }
                    else if (std.mem.eql(u8, action.kind, "text")) { try sendText(io, object, target, operation, started, timeout, action.text.?, progress); }
                    else if (std.mem.eql(u8, action.kind, "message")) { try sendKeyboardMessage(io, object, target, operation.marker.?, action.message.?); }
                    else {
                        const keys = action.keys.?;
                        const before = object.keyboard;
                        const up = std.mem.eql(u8, action.kind, "up");
                        if (up) {
                            var index = keys.len;
                            while (index > 0) { index -= 1; if (object.keyboard.held(keys[index].virtualKey)) try sendKey(io, object, target, operation.marker.?, keys[index], false, false); }
                        } else {
                            const repeated = std.mem.eql(u8, action.kind, "repeat");
                            for (keys) |key| if (repeated or !object.keyboard.held(key.virtualKey)) { try sendKey(io, object, target, operation.marker.?, key, true, repeated); };
                            if (std.mem.eql(u8, action.kind, "press")) {
                                try wait(io, started, timeout, action.holdMs.?);
                                var index = keys.len;
                                while (index > 0) { index -= 1; if (!before.held(keys[index].virtualKey)) try sendKey(io, object, target, operation.marker.?, keys[index], false, false); }
                            }
                        }
                    }
                    progress.completedActions += 1;
                }
            }
        },
        .create => unreachable,
    }
    return .{ .completedActions = progress.completedActions, .submittedScalars = progress.submittedScalars, .input = snapshot(object) };
}

pub fn executeRealKeyboard(io: std.Io, namespace: u64, input_id: u64, window_id: ?i32, viewport: Viewport, document_id: ?[]const u8, request: native.KeyboardRequest) native.KeyboardOutcome {
    if (!supported) return .{ .failure = .{ .reason = "backend_unavailable", .phase = .prepare, .input_state = .not_sent, .completed_actions = 0 } };
    const started = std.Io.Clock.awake.now(io).nanoseconds;
    mutex.lockUncancelable(io);
    defer mutex.unlock(io);
    const timeout_failure: native.KeyboardOutcome = .{ .failure = .{ .reason = "timeout", .phase = .prepare, .input_state = .not_sent, .completed_actions = 0 } };
    _ = remaining(io, started, request.timeout_ms) catch return timeout_failure;
    const object = get(namespace, input_id) catch return .{ .failure = .{ .reason = "input_not_found", .phase = .prepare, .input_state = .not_sent, .completed_actions = 0 } };
    var backend: ?windows.Mouse = null;
    var pointer = object.mouse;
    for (&targets) |*item| if (item.*) |*target| {
        if (target.input_id == object.id and window_id != null and target.window_id == window_id.?) {
            // Real keyboard retains its existing foreground/target preparation.
            // Refresh its optional virtual context without resetting held keys.
            var updated = false;
            const current = calibrate(io, object, .{ .kind = .calibrate, .windowId = window_id, .marker = request.marker, .viewport = viewport, .documentId = document_id, .refresh = false }, started, request.timeout_ms, &updated)
                catch return .{ .failure = .{ .reason = "target_changed", .phase = .prepare, .input_state = .not_sent, .completed_actions = 0 } };
            pointer = pointerContext(object, current) catch return .{ .failure = .{ .reason = "target_changed", .phase = .prepare, .input_state = .not_sent, .completed_actions = 0 } };
            backend = current.backend; break;
        }
    };
    var bounded_request = request;
    bounded_request.timeout_ms = remaining(io, started, request.timeout_ms) catch return timeout_failure;
    return native.executeKeyboard(io, object.id, bounded_request, .{ .state = &object.keyboard, .window_id = window_id, .backend = backend, .pointer = pointer });
}
fn cleanupLocked(io: std.Io, namespace: u64, timeout: u32) void {
    for (&objects) |*item| if (item.*) |*object| {
        if (object.namespace != namespace) continue;
        object.retired = true;
        native.releaseOwned(io, object.id, null) catch continue;
        releaseTargets(object, null, timeout, true) catch continue;
        item.* = null;
    };
}
pub fn cleanupInstance(io: std.Io, namespace: u64) void {
    if (!supported) return;
    mutex.lockUncancelable(io);
    defer mutex.unlock(io);
    cleanupLocked(io, namespace, config.virtual_mouse_cleanup_timeout_ms);
}

test "input snapshot always serializes keyboard bytes as a numeric array" {
    const object: Object = .{ .id = 1, .namespace = 1 };
    const value = snapshot(&object);
    const json = try std.json.Stringify.valueAlloc(std.testing.allocator, value, .{});
    defer std.testing.allocator.free(json);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"keys\":[0,0,") != null);
}

test "calibration projects CSS into the page region, not the whole browser client" {
    var target: Target = .{
        .input_id = 1, .window_id = 1, .backend = undefined,
        .viewport = .{ .width = 886, .height = 500 }, .document = @splat(0),
        .calibration = .{ .root = 1, .content = 2, .process_id = 3,
            .root_width = 1328, .root_height = 964, .dpi = 144,
            .x = 0, .y = 214, .width = 1329, .height = 751 },
    };
    try std.testing.expectEqual(mouse.Point{ .x = 0, .y = 214 }, try projectPoint(.{ .x = 0, .y = 0 }, &target));
    try std.testing.expectEqual(mouse.Point{ .x = 150, .y = 514 }, try projectPoint(.{ .x = 100, .y = 200 }, &target));
    try std.testing.expectEqual(mouse.Point{ .x = 1327, .y = 214 }, try projectPoint(.{ .x = 885, .y = 0 }, &target));
    target.calibration.?.x = 40;
    try std.testing.expectEqual(mouse.Point{ .x = 190, .y = 514 }, try projectPoint(.{ .x = 100, .y = 200 }, &target));
}

test "calibration requires explicit document identity and valid viewport" {
    var operation: Operation = .{ .kind = .calibrate, .windowId = 1,
        .marker = "BKA input test marker", .documentId = "document-1", .viewport = .{ .width = 900, .height = 600 } };
    const first = try validateTarget(operation);
    operation.documentId = "document-2";
    try std.testing.expect(!std.mem.eql(u8, &first, &try validateTarget(operation)));
    operation.documentId = "";
    try std.testing.expectError(error.InvalidInput, validateTarget(operation));
    operation.documentId = "document-1";
    operation.viewport.?.height = 0;
    try std.testing.expectError(error.InvalidInput, validateTarget(operation));
}

test "real keyboard consumes time waiting for the virtual input lock before native dispatch" {
    if (!supported) return;
    const io = std.testing.io;
    const namespace = 987654;
    mutex.lockUncancelable(io);
    const object = allocate(namespace) catch |err| { mutex.unlock(io); return err; };
    const input_id = object.id;
    mutex.unlock(io);
    defer cleanupInstance(io, namespace);
    const Waiter = struct {
        entered: std.Io.Event = .unset,
        result: native.KeyboardOutcome = .{ .failure = .{ .reason = "not_started", .phase = .prepare, .input_state = .not_sent, .completed_actions = 0 } },
        fn run(waiter: *@This(), context_io: std.Io, id: u64) void {
            waiter.entered.set(context_io);
            // This fresh object has no held keys or target; reset would complete
            // without any physical input if its expired budget were restarted.
            waiter.result = executeRealKeyboard(context_io, namespace, id, null, .{ .width = 1, .height = 1 }, null,
                .{ .marker = null, .operation = .{ .kind = "reset" }, .timeout_ms = 10 });
        }
    };
    var waiter: Waiter = .{};
    var group: std.Io.Group = .init;
    defer group.cancel(io);
    mutex.lockUncancelable(io);
    var locked = true;
    defer if (locked) mutex.unlock(io);
    try group.concurrent(io, Waiter.run, .{ &waiter, io, input_id });
    try waiter.entered.wait(io);
    try io.sleep(.fromMilliseconds(60), .awake);
    mutex.unlock(io); locked = false;
    try group.await(io);
    switch (waiter.result) {
        .failure => |failure| {
            try std.testing.expectEqualStrings("timeout", failure.reason);
            try std.testing.expectEqual(.prepare, failure.phase);
            try std.testing.expectEqual(.not_sent, failure.input_state);
        },
        else => return error.ExpectedLockTimeout,
    }
}
