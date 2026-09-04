const std = @import("std");
const builtin = @import("builtin");
const windows = @import("native_input/windows.zig");
const config = @import("generated_config.zig");

pub const Point = struct { x: f64, y: f64 };
pub const Viewport = struct { width: f64, height: f64 };

pub const ClickRequest = struct {
    marker: []const u8,
    point: Point,
    viewport: Viewport,
    timeout_ms: u32,
};

pub const KeyboardKey = struct {
    virtualKey: u16,
    extended: bool,
};

pub const KeyboardAction = struct {
    kind: []const u8,
    keys: ?[]const KeyboardKey = null,
    holdMs: ?u32 = null,
    waitMs: ?u32 = null,
};

pub const HumanMistake = struct {
    index: u32,
    wrong: []const u8,
    beforeBackspaceMs: u32,
    beforeCorrectionMs: u32,
};

pub const KeyboardOperation = struct {
    kind: []const u8,
    actions: ?[]const KeyboardAction = null,
    text: ?[]const u8 = null,
    delaysMs: ?[]const u32 = null,
    mistakes: ?[]const HumanMistake = null,
};

pub const KeyboardRequest = struct {
    marker: ?[]const u8,
    operation: KeyboardOperation,
    timeout_ms: u32,
};

pub const Phase = enum { prepare, input };
pub const ClickState = enum { not_sent, unknown };
pub const InputState = enum { not_sent, partially_sent, unknown };

pub const ClickFailure = struct {
    reason: []const u8,
    phase: Phase,
    click_state: ClickState,
};

pub const ClickOutcome = union(enum) {
    input_sent,
    failure: ClickFailure,
};

pub const KeyboardFailure = struct {
    reason: []const u8,
    phase: Phase,
    input_state: InputState,
    completed_actions: u32,
};

pub const KeyboardSuccess = struct {
    completed_actions: u32,
    submitted_scalars: u32,
    corrected_mistakes: u32,
    held_virtual_keys: [256]u16,
    held_count: usize,
};

pub const KeyboardOutcome = union(enum) {
    success: KeyboardSuccess,
    failure: KeyboardFailure,
};

var input_mutex: std.Io.Mutex = .init;
var key_owners = [_]u64{0} ** 256;
var key_extended = [_]bool{false} ** 256;

fn clickFailed(reason: []const u8, phase: Phase, click_state: ClickState) ClickOutcome {
    return .{ .failure = .{ .reason = reason, .phase = phase, .click_state = click_state } };
}

fn keyboardFailed(
    reason: []const u8,
    phase: Phase,
    input_state: InputState,
    completed_actions: u32,
) KeyboardOutcome {
    return .{ .failure = .{
        .reason = reason,
        .phase = phase,
        .input_state = input_state,
        .completed_actions = completed_actions,
    } };
}

fn failureState(any_input: bool) InputState {
    return if (any_input) .partially_sent else .not_sent;
}

fn runtimeUnsafeReason(marker: []const u8) ?[]const u8 {
    windows.keyboardTargetReady(marker) catch return "target_lost";
    return if (windows.hasUntrackedUserInput(&key_owners)) "user_input_conflict" else null;
}

fn validMarker(marker: []const u8) bool {
    if (marker.len < 12 or marker.len > 96) return false;
    for (marker) |byte| if (byte < 0x20 or byte > 0x7e) return false;
    return true;
}

fn validKey(key: KeyboardKey) bool {
    return key.virtualKey > 0 and key.virtualKey < 256;
}

fn validUniqueKeys(keys: []const KeyboardKey) bool {
    if (keys.len == 0 or keys.len > config.native_keyboard_maximum_chord_keys) return false;
    var index: usize = 0;
    while (index < keys.len) : (index += 1) {
        if (!validKey(keys[index])) return false;
        var other = index + 1;
        while (other < keys.len) : (other += 1) {
            if (keys[index].virtualKey == keys[other].virtualKey) return false;
        }
    }
    return true;
}

fn scalarCount(text: []const u8) ?usize {
    if (text.len == 0 or text.len > config.native_keyboard_maximum_text_bytes) return null;
    return std.unicode.utf8CountCodepoints(text) catch null;
}

fn singleScalar(text: []const u8) ?u21 {
    if (!std.unicode.utf8ValidateSlice(text)) return null;
    var view = std.unicode.Utf8View.initUnchecked(text);
    var iterator = view.iterator();
    const codepoint = iterator.nextCodepoint() orelse return null;
    return if (iterator.nextCodepoint() == null) codepoint else null;
}

fn validateKeyboard(request: KeyboardRequest) bool {
    if (request.timeout_ms == 0) return false;
    const operation = request.operation;
    if (std.mem.eql(u8, operation.kind, "reset")) {
        return request.marker == null and operation.actions == null and operation.text == null and
            operation.delaysMs == null and operation.mistakes == null;
    }
    const marker = request.marker orelse return false;
    if (!validMarker(marker)) return false;
    if (std.mem.eql(u8, operation.kind, "type")) {
        return operation.actions == null and operation.delaysMs == null and operation.mistakes == null and
            scalarCount(operation.text orelse return false) != null;
    }
    if (std.mem.eql(u8, operation.kind, "type_human")) {
        if (operation.actions != null) return false;
        const text = operation.text orelse return false;
        const count = scalarCount(text) orelse return false;
        const delays = operation.delaysMs orelse return false;
        const mistakes = operation.mistakes orelse return false;
        if (delays.len != count or mistakes.len > count) return false;
        for (delays) |delay| if (delay > config.native_keyboard_maximum_wait_ms) return false;
        var last_index: ?u32 = null;
        for (mistakes) |mistake| {
            if (mistake.index >= count or (last_index != null and mistake.index <= last_index.?) or
                mistake.beforeBackspaceMs > config.native_keyboard_maximum_wait_ms or
                mistake.beforeCorrectionMs > config.native_keyboard_maximum_wait_ms or
                singleScalar(mistake.wrong) == null) return false;
            last_index = mistake.index;
        }
        return true;
    }
    if (!std.mem.eql(u8, operation.kind, "press") or operation.text != null or
        operation.delaysMs != null or operation.mistakes != null) return false;
    const actions = operation.actions orelse return false;
    if (actions.len == 0 or actions.len > config.native_keyboard_maximum_wire_actions) return false;
    for (actions) |action| {
        if (std.mem.eql(u8, action.kind, "press")) {
            if (action.waitMs != null or action.holdMs == null or
                action.holdMs.? > config.native_keyboard_maximum_wait_ms or
                !validUniqueKeys(action.keys orelse return false)) return false;
        } else if (std.mem.eql(u8, action.kind, "down") or std.mem.eql(u8, action.kind, "up")) {
            if (action.waitMs != null or action.holdMs != null or
                !validUniqueKeys(action.keys orelse return false)) return false;
        } else if (std.mem.eql(u8, action.kind, "wait")) {
            if (action.keys != null or action.holdMs != null or action.waitMs == null or
                action.waitMs.? > config.native_keyboard_maximum_wait_ms) return false;
        } else return false;
    }
    return true;
}

fn deadlineReached(io: std.Io, started: i96, timeout_ms: u32) bool {
    return std.Io.Clock.awake.now(io).nanoseconds - started >= @as(i96, timeout_ms) * std.time.ns_per_ms;
}

fn waitWithin(io: std.Io, started: i96, timeout_ms: u32, wait_ms: u32) bool {
    const elapsed = std.Io.Clock.awake.now(io).nanoseconds - started;
    if (elapsed + @as(i96, wait_ms) * std.time.ns_per_ms >= @as(i96, timeout_ms) * std.time.ns_per_ms) return false;
    if (wait_ms == 0) return true;
    io.sleep(.fromMilliseconds(@intCast(wait_ms)), .awake) catch return false;
    return !deadlineReached(io, started, timeout_ms);
}

fn anyHeldBy(instance_number: u64) bool {
    for (key_owners) |owner| if (owner == instance_number) return true;
    return false;
}

fn anyHeldByOther(instance_number: u64) bool {
    for (key_owners) |owner| if (owner != 0 and owner != instance_number) return true;
    return false;
}

fn isModifier(virtual_key: u16) bool {
    return virtual_key == 0x5b or virtual_key == 0x5c or (virtual_key >= 0xa0 and virtual_key <= 0xa5);
}

fn success(instance_number: u64, completed: u32, submitted: u32, corrected: u32) KeyboardOutcome {
    var result: KeyboardSuccess = .{
        .completed_actions = completed,
        .submitted_scalars = submitted,
        .corrected_mistakes = corrected,
        .held_virtual_keys = [_]u16{0} ** 256,
        .held_count = 0,
    };
    var virtual_key: usize = 1;
    while (virtual_key < key_owners.len) : (virtual_key += 1) {
        if (key_owners[virtual_key] == instance_number) {
            result.held_virtual_keys[result.held_count] = @intCast(virtual_key);
            result.held_count += 1;
        }
    }
    return .{ .success = result };
}

const EventDelivery = enum { accepted, rejected, partial };

fn delivery(result: windows.SendResult) EventDelivery {
    if (result.accepted == result.total) return .accepted;
    return if (result.accepted == 0) .rejected else .partial;
}

fn sendKey(instance_number: u64, key: KeyboardKey, down: bool, any_input: *bool) EventDelivery {
    const result = windows.sendVirtualKey(key.virtualKey, key.extended, down);
    switch (delivery(result)) {
        .accepted => {
            any_input.* = true;
            key_owners[key.virtualKey] = if (down) instance_number else 0;
            key_extended[key.virtualKey] = if (down) key.extended else false;
            return .accepted;
        },
        .rejected => return .rejected,
        .partial => {
            any_input.* = any_input.* or result.accepted > 0;
            return .partial;
        },
    }
}

fn releaseNewly(instance_number: u64, keys: []const KeyboardKey, any_input: *bool) bool {
    var complete = true;
    var index = keys.len;
    while (index > 0) {
        index -= 1;
        const key = keys[index];
        if (key_owners[key.virtualKey] != instance_number) continue;
        if (sendKey(instance_number, key, false, any_input) != .accepted) complete = false;
    }
    return complete;
}

fn executePress(
    io: std.Io,
    instance_number: u64,
    request: KeyboardRequest,
    started: i96,
    any_input: *bool,
) KeyboardOutcome {
    var completed: u32 = 0;
    const actions = request.operation.actions.?;
    for (actions) |action| {
        if (deadlineReached(io, started, request.timeout_ms)) {
            return keyboardFailed("timeout", .input, failureState(any_input.*), completed);
        }
        if (std.mem.eql(u8, action.kind, "wait")) {
            if (!waitWithin(io, started, request.timeout_ms, action.waitMs.?)) {
                return keyboardFailed("timeout", .input, failureState(any_input.*), completed);
            }
            completed += 1;
            continue;
        }
        if (!std.mem.eql(u8, action.kind, "up")) {
            if (runtimeUnsafeReason(request.marker.?)) |reason| {
                return keyboardFailed(reason, .input, failureState(any_input.*), completed);
            }
        }
        const keys = action.keys.?;
        if (std.mem.eql(u8, action.kind, "down")) {
            for (keys) |key| {
                const owner = key_owners[key.virtualKey];
                if (owner == instance_number) continue;
                if (owner != 0) return keyboardFailed("key_owned_by_other_instance", .input, failureState(any_input.*), completed);
                switch (sendKey(instance_number, key, true, any_input)) {
                    .accepted => {},
                    .rejected => return keyboardFailed("input_rejected", .input, failureState(any_input.*), completed),
                    .partial => return keyboardFailed("partial_input", .input, .unknown, completed),
                }
            }
            completed += 1;
            continue;
        }
        if (std.mem.eql(u8, action.kind, "up")) {
            var index = keys.len;
            while (index > 0) {
                index -= 1;
                const key = keys[index];
                const owner = key_owners[key.virtualKey];
                if (owner == 0) continue;
                if (owner != instance_number) return keyboardFailed("key_owned_by_other_instance", .input, failureState(any_input.*), completed);
                switch (sendKey(instance_number, key, false, any_input)) {
                    .accepted => {},
                    .rejected => return keyboardFailed("input_rejected", .input, failureState(any_input.*), completed),
                    .partial => return keyboardFailed("partial_input", .input, .unknown, completed),
                }
            }
            completed += 1;
            continue;
        }

        var newly_pressed: [config.native_keyboard_maximum_chord_keys]KeyboardKey = undefined;
        var newly_count: usize = 0;
        for (keys) |key| {
            const owner = key_owners[key.virtualKey];
            if (owner == instance_number) {
                if (isModifier(key.virtualKey)) continue;
                _ = releaseNewly(instance_number, newly_pressed[0..newly_count], any_input);
                return keyboardFailed("key_already_held", .input, failureState(any_input.*), completed);
            }
            if (owner != 0) {
                _ = releaseNewly(instance_number, newly_pressed[0..newly_count], any_input);
                return keyboardFailed("key_owned_by_other_instance", .input, failureState(any_input.*), completed);
            }
            switch (sendKey(instance_number, key, true, any_input)) {
                .accepted => {
                    newly_pressed[newly_count] = key;
                    newly_count += 1;
                },
                .rejected => {
                    _ = releaseNewly(instance_number, newly_pressed[0..newly_count], any_input);
                    return keyboardFailed("input_rejected", .input, failureState(any_input.*), completed);
                },
                .partial => {
                    _ = releaseNewly(instance_number, newly_pressed[0..newly_count], any_input);
                    return keyboardFailed("partial_input", .input, .unknown, completed);
                },
            }
        }
        if (!waitWithin(io, started, request.timeout_ms, action.holdMs.?)) {
            const released = releaseNewly(instance_number, newly_pressed[0..newly_count], any_input);
            return keyboardFailed("timeout", .input, if (released) .partially_sent else .unknown, completed);
        }
        const unsafe_reason = runtimeUnsafeReason(request.marker.?);
        if (!releaseNewly(instance_number, newly_pressed[0..newly_count], any_input)) {
            return keyboardFailed("partial_input", .input, .unknown, completed);
        }
        if (unsafe_reason) |reason| {
            return keyboardFailed(reason, .input, .partially_sent, completed + 1);
        }
        completed += 1;
    }
    return success(instance_number, completed, 0, 0);
}

fn sendScalar(codepoint: u21, any_input: *bool) EventDelivery {
    const result = windows.sendUnicodeScalar(codepoint);
    switch (delivery(result)) {
        .accepted => any_input.* = true,
        .partial => any_input.* = any_input.* or result.accepted > 0,
        .rejected => {},
    }
    return delivery(result);
}

fn tapBackspace(instance_number: u64, any_input: *bool) EventDelivery {
    const key: KeyboardKey = .{ .virtualKey = 0x08, .extended = false };
    switch (sendKey(instance_number, key, true, any_input)) {
        .accepted => {},
        .rejected => return .rejected,
        .partial => return .partial,
    }
    const result = sendKey(instance_number, key, false, any_input);
    if (result != .accepted) {
        _ = sendKey(instance_number, key, false, any_input);
        return .partial;
    }
    return .accepted;
}

fn executeText(
    io: std.Io,
    instance_number: u64,
    request: KeyboardRequest,
    started: i96,
    human: bool,
    any_input: *bool,
) KeyboardOutcome {
    if (anyHeldBy(instance_number) or anyHeldByOther(instance_number)) {
        return keyboardFailed("keyboard_state_conflict", .input, .not_sent, 0);
    }
    const text = request.operation.text.?;
    var view = std.unicode.Utf8View.initUnchecked(text);
    var iterator = view.iterator();
    var index: u32 = 0;
    var corrected: u32 = 0;
    var mistake_index: usize = 0;
    const mistakes = if (human) request.operation.mistakes.? else &[_]HumanMistake{};
    const delays = if (human) request.operation.delaysMs.? else &[_]u32{};
    while (iterator.nextCodepoint()) |codepoint| {
        if (deadlineReached(io, started, request.timeout_ms)) {
            return keyboardFailed("timeout", .input, failureState(any_input.*), index);
        }
        if (human and mistake_index < mistakes.len and mistakes[mistake_index].index == index) {
            if (runtimeUnsafeReason(request.marker.?)) |reason| {
                return keyboardFailed(reason, .input, failureState(any_input.*), index);
            }
            const mistake = mistakes[mistake_index];
            const wrong = singleScalar(mistake.wrong).?;
            switch (sendScalar(wrong, any_input)) {
                .accepted => {},
                .rejected => return keyboardFailed("input_rejected", .input, failureState(any_input.*), index),
                .partial => return keyboardFailed("partial_input", .input, .unknown, index),
            }
            if (!waitWithin(io, started, request.timeout_ms, mistake.beforeBackspaceMs)) {
                return keyboardFailed("timeout", .input, .partially_sent, index);
            }
            if (runtimeUnsafeReason(request.marker.?)) |reason| {
                return keyboardFailed(reason, .input, .partially_sent, index);
            }
            switch (tapBackspace(instance_number, any_input)) {
                .accepted => {},
                .rejected => return keyboardFailed("input_rejected", .input, .partially_sent, index),
                .partial => return keyboardFailed("partial_input", .input, .unknown, index),
            }
            if (!waitWithin(io, started, request.timeout_ms, mistake.beforeCorrectionMs)) {
                return keyboardFailed("timeout", .input, .partially_sent, index);
            }
            mistake_index += 1;
            corrected += 1;
        }
        if (runtimeUnsafeReason(request.marker.?)) |reason| {
            return keyboardFailed(reason, .input, failureState(any_input.*), index);
        }
        switch (sendScalar(codepoint, any_input)) {
            .accepted => {},
            .rejected => return keyboardFailed("input_rejected", .input, failureState(any_input.*), index),
            .partial => return keyboardFailed("partial_input", .input, .unknown, index),
        }
        index += 1;
        if (human and !waitWithin(io, started, request.timeout_ms, delays[index - 1])) {
            return keyboardFailed("timeout", .input, .partially_sent, index);
        }
    }
    return success(instance_number, index, index, corrected);
}

fn resetInstance(instance_number: u64, any_input: *bool) KeyboardOutcome {
    var completed: u32 = 0;
    var virtual_key: usize = 1;
    while (virtual_key < key_owners.len) : (virtual_key += 1) {
        if (key_owners[virtual_key] != instance_number) continue;
        const key: KeyboardKey = .{ .virtualKey = @intCast(virtual_key), .extended = key_extended[virtual_key] };
        switch (sendKey(instance_number, key, false, any_input)) {
            .accepted => completed += 1,
            .rejected => return keyboardFailed("input_rejected", .input, failureState(any_input.*), completed),
            .partial => return keyboardFailed("partial_input", .input, .unknown, completed),
        }
    }
    return success(instance_number, completed, 0, 0);
}

pub fn executeClick(io: std.Io, request: ClickRequest) ClickOutcome {
    if (request.timeout_ms == 0 or !validMarker(request.marker) or
        !std.math.isFinite(request.point.x) or !std.math.isFinite(request.point.y) or
        !std.math.isFinite(request.viewport.width) or !std.math.isFinite(request.viewport.height) or
        request.viewport.width <= 0 or request.viewport.height <= 0 or
        request.point.x < 0 or request.point.y < 0 or
        request.point.x >= request.viewport.width or request.point.y >= request.viewport.height)
    {
        return clickFailed("invalid_request", .prepare, .not_sent);
    }

    const started = std.Io.Clock.awake.now(io).nanoseconds;
    input_mutex.lockUncancelable(io);
    defer input_mutex.unlock(io);
    if (deadlineReached(io, started, request.timeout_ms)) return clickFailed("timeout", .prepare, .not_sent);

    if (builtin.os.tag != .windows) return clickFailed("backend_unavailable", .prepare, .not_sent);
    while (true) {
        windows.click(request) catch |err| switch (err) {
            error.WindowNotMatched, error.ContentNotMatched => {
                if (deadlineReached(io, started, request.timeout_ms)) {
                    return clickFailed(
                        if (err == error.WindowNotMatched) "window_not_matched" else "content_not_matched",
                        .prepare,
                        .not_sent,
                    );
                }
                io.sleep(.fromMilliseconds(@intCast(config.native_input_window_match_poll_ms)), .awake) catch
                    return clickFailed("wait_interrupted", .prepare, .not_sent);
                continue;
            },
            error.InvalidCoordinates => return clickFailed("invalid_coordinates", .prepare, .not_sent),
            error.GeometryChanged => return clickFailed("geometry_changed", .input, .not_sent),
            error.UserInputConflict => return clickFailed("user_input_conflict", .input, .not_sent),
            error.MoveFailed, error.DownFailed => return clickFailed("input_rejected", .input, .not_sent),
            error.UpFailed => return clickFailed("partial_input", .input, .unknown),
        };
        return .input_sent;
    }
}

pub fn executeKeyboard(io: std.Io, instance_number: u64, request: KeyboardRequest) KeyboardOutcome {
    if (!validateKeyboard(request) or instance_number == 0) {
        return keyboardFailed("invalid_request", .prepare, .not_sent, 0);
    }
    const started = std.Io.Clock.awake.now(io).nanoseconds;
    input_mutex.lockUncancelable(io);
    defer input_mutex.unlock(io);
    if (deadlineReached(io, started, request.timeout_ms)) return keyboardFailed("timeout", .prepare, .not_sent, 0);
    if (builtin.os.tag != .windows) return keyboardFailed("backend_unavailable", .prepare, .not_sent, 0);

    var any_input = false;
    if (std.mem.eql(u8, request.operation.kind, "reset")) return resetInstance(instance_number, &any_input);
    var last_reason: []const u8 = "window_not_matched";
    while (true) {
        windows.keyboardTargetReady(request.marker.?) catch |err| {
            last_reason = if (err == error.ForegroundMismatch) "foreground_mismatch" else "window_not_matched";
            if (deadlineReached(io, started, request.timeout_ms)) {
                return keyboardFailed(last_reason, .prepare, .not_sent, 0);
            }
            io.sleep(.fromMilliseconds(@intCast(config.native_input_window_match_poll_ms)), .awake) catch
                return keyboardFailed("wait_interrupted", .prepare, .not_sent, 0);
            continue;
        };
        break;
    }
    if (windows.hasUntrackedUserInput(&key_owners)) {
        return keyboardFailed("user_input_conflict", .input, .not_sent, 0);
    }
    if (anyHeldByOther(instance_number)) {
        return keyboardFailed("key_owned_by_other_instance", .input, .not_sent, 0);
    }
    if (std.mem.eql(u8, request.operation.kind, "press")) {
        return executePress(io, instance_number, request, started, &any_input);
    }
    return executeText(
        io,
        instance_number,
        request,
        started,
        std.mem.eql(u8, request.operation.kind, "type_human"),
        &any_input,
    );
}

pub fn cleanupInstance(io: std.Io, instance_number: u64) void {
    if (instance_number == 0) return;
    input_mutex.lockUncancelable(io);
    defer input_mutex.unlock(io);
    if (builtin.os.tag != .windows) return;
    var virtual_key: usize = 1;
    while (virtual_key < key_owners.len) : (virtual_key += 1) {
        if (key_owners[virtual_key] != instance_number) continue;
        const first = windows.sendVirtualKey(@intCast(virtual_key), key_extended[virtual_key], false);
        if (first.accepted != first.total) _ = windows.sendVirtualKey(@intCast(virtual_key), key_extended[virtual_key], false);
        key_owners[virtual_key] = 0;
        key_extended[virtual_key] = false;
    }
}

test "non-Windows builds explicitly decline native click and keyboard input" {
    if (builtin.os.tag == .windows) return;
    const click_result = executeClick(std.testing.io, .{
        .marker = "BKA real test-token",
        .point = .{ .x = 1, .y = 1 },
        .viewport = .{ .width = 10, .height = 10 },
        .timeout_ms = 100,
    });
    try std.testing.expectEqualStrings("backend_unavailable", click_result.failure.reason);
    const keyboard_result = executeKeyboard(std.testing.io, 1, .{
        .marker = null,
        .operation = .{ .kind = "reset" },
        .timeout_ms = 100,
    });
    try std.testing.expectEqualStrings("backend_unavailable", keyboard_result.failure.reason);
}

test "keyboard request validation rejects duplicate chord keys and malformed human plans" {
    const duplicated = [_]KeyboardKey{
        .{ .virtualKey = 0x41, .extended = false },
        .{ .virtualKey = 0x41, .extended = false },
    };
    const actions = [_]KeyboardAction{.{ .kind = "press", .keys = &duplicated, .holdMs = 0 }};
    try std.testing.expect(!validateKeyboard(.{
        .marker = "BKA keys test-token",
        .operation = .{ .kind = "press", .actions = &actions },
        .timeout_ms = 100,
    }));
    const delays = [_]u32{1};
    try std.testing.expect(!validateKeyboard(.{
        .marker = "BKA keys test-token",
        .operation = .{ .kind = "type_human", .text = "ab", .delaysMs = &delays, .mistakes = &.{} },
        .timeout_ms = 100,
    }));
}
