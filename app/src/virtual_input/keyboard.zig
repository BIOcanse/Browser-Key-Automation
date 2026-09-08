const std = @import("std");

pub const Key = struct { virtualKey: u16, extended: bool, scanCode: ?u16 = null, layout: ?[]const u8 = null };
pub const Message = struct { message: u32, value: u32, bits: u32, layout: ?[]const u8 = null };
pub const Action = struct {
    kind: []const u8,
    keys: ?[]const Key = null,
    holdMs: ?u32 = null,
    waitMs: ?u32 = null,
    text: ?[]const u8 = null,
    message: ?Message = null,
};

pub fn messageKey(message: Message) !?Key {
    switch (message.message) {
        0x100, 0x101, 0x104, 0x105 => {},
        0x102, 0x103, 0x106, 0x107 => return if (message.value <= 0xffff) null else error.InvalidInput,
        0x109 => return if (message.value <= 0x10ffff) null else error.InvalidInput,
        else => return error.InvalidInput,
    }
    if (message.value == 0 or message.value > 255) return error.InvalidInput;
    var vk: u16 = @intCast(message.value);
    const scan: u16 = @intCast((message.bits >> 16) & 0xff);
    const extended = message.bits & 0x1000000 != 0;
    if (vk == 0x10) {
        if (extended or (scan != 0x2a and scan != 0x36)) return error.InvalidInput;
        vk = if (scan == 0x36) 0xa1 else 0xa0;
    } else if (vk == 0x11) {
        vk = if (extended) 0xa3 else 0xa2;
    } else if (vk == 0x12) {
        vk = if (extended) 0xa5 else 0xa4;
    }
    return .{ .virtualKey = vk, .extended = extended, .scanCode = scan, .layout = message.layout };
}

/// One logical keyboard, independent of HWND, browser tab and physical input.
/// Bytes have the Win32 keyboard-state shape: high bit held, low bit toggled.
pub const State = struct {
    keys: [256]u8 = @splat(0),
    extended: [256]bool = @splat(false),
    known: bool = true,

    pub fn held(self: *const State, key: u16) bool { return self.keys[key] & 0x80 != 0; }
    pub fn set(self: *State, key: Key, down: bool) void {
        const vk = key.virtualKey;
        if (down and !self.held(vk) and (vk == 0x14 or vk == 0x90 or vk == 0x91)) self.keys[vk] ^= 1;
        self.keys[vk] = (self.keys[vk] & 1) | @as(u8, if (down) 0x80 else 0);
        self.extended[vk] = down and key.extended;
        // Boundaries normalize generic modifiers to their scan/extended side.
        if (vk >= 0xa0 and vk <= 0xa5) {
            const left: u16 = vk & 0xfffe;
            const aggregate: u16 = 0x10 + (left - 0xa0) / 2;
            self.keys[aggregate] = (self.keys[left] | self.keys[left + 1]) & 0x80;
        }
    }
    pub fn reset(self: *State) void {
        for (&self.keys) |*value| value.* &= 1;
        self.extended = @splat(false);
        self.known = true;
    }
};

pub fn isModifier(key: u16) bool { return key == 0x5b or key == 0x5c or (key >= 0xa0 and key <= 0xa5); }
pub fn isAggregate(key: usize) bool { return key == 0x10 or key == 0x11 or key == 0x12; }

pub fn project(state: State, action: Action) !State {
    if (!state.known) return error.StateUnknown;
    if (std.mem.eql(u8, action.kind, "message")) {
        const message = action.message orelse return error.InvalidInput;
        const key = (try messageKey(message)) orelse return state;
        const down = message.message == 0x100 or message.message == 0x104;
        if (state.held(key.virtualKey) and state.extended[key.virtualKey] != key.extended) return error.KeyIdentityConflict;
        if (down and message.bits & 0x40000000 != 0 and !state.held(key.virtualKey)) return error.KeyNotHeld;
        var next = state;
        next.set(key, down);
        return next;
    }
    if (std.mem.eql(u8, action.kind, "wait")) return state;
    if (std.mem.eql(u8, action.kind, "text")) {
        for ([_]u16{ 0x5b, 0x5c, 0xa2, 0xa3, 0xa4, 0xa5 }) |vk| if (state.held(vk)) return error.TextModifierHeld;
        return state;
    }
    var next = state;
    const keys = action.keys orelse return error.InvalidInput;
    const down = std.mem.eql(u8, action.kind, "down");
    const up = std.mem.eql(u8, action.kind, "up");
    const press = std.mem.eql(u8, action.kind, "press");
    const repeated = std.mem.eql(u8, action.kind, "repeat");
    if (!down and !up and !press and !repeated) return error.InvalidInput;
    for (keys) |key| {
        if (key.virtualKey == 0 or key.virtualKey >= 256 or isAggregate(key.virtualKey)) return error.InvalidInput;
        if (state.held(key.virtualKey) and state.extended[key.virtualKey] != key.extended) return error.KeyIdentityConflict;
        if (repeated and !state.held(key.virtualKey)) return error.KeyNotHeld;
        if (repeated) continue;
        if (press and state.held(key.virtualKey)) {
            if (!isModifier(key.virtualKey)) return error.KeyAlreadyHeld;
            continue;
        }
        next.set(key, !up);
        if (press) next.set(key, false);
    }
    return next;
}

test "keyboard logical state aggregates modifiers, preserves them through presses and retains toggle bits" {
    var state: State = .{};
    state.set(.{ .virtualKey = 0xa2, .extended = false }, true);
    try std.testing.expect(state.held(0x11));
    const keys = [_]Key{.{ .virtualKey = 0xa2, .extended = false }, .{ .virtualKey = 0x41, .extended = false }};
    state = try project(state, .{ .kind = "press", .keys = &keys, .holdMs = 0 });
    try std.testing.expect(state.held(0xa2) and !state.held(0x41));
    state.set(.{ .virtualKey = 0x14, .extended = false }, true);
    state.reset();
    try std.testing.expectEqual(@as(u8, 1), state.keys[0x14]);
    try std.testing.expect(!state.held(0x11));
}

test "repeat preserves held state and requires matching key identity; text never clears modifiers" {
    const keys = [_]Key{.{ .virtualKey = 13, .extended = true, .scanCode = 28 }};
    var state: State = .{};
    try std.testing.expectError(error.KeyNotHeld, project(state, .{ .kind = "repeat", .keys = &keys }));
    state = try project(state, .{ .kind = "down", .keys = &keys });
    const repeated = try project(state, .{ .kind = "repeat", .keys = &keys });
    try std.testing.expectEqualDeep(state, repeated);
    const different = [_]Key{.{ .virtualKey = 13, .extended = false }};
    try std.testing.expectError(error.KeyIdentityConflict, project(state, .{ .kind = "up", .keys = &different }));
    state = try project(state, .{ .kind = "up", .keys = &keys });
    state.set(.{ .virtualKey = 0xa2, .extended = false }, true);
    try std.testing.expectError(error.TextModifierHeld, project(state, .{ .kind = "text", .text = "中文" }));
    try std.testing.expect(state.held(0xa2));
}

test "recorded messages preserve keyboard state independently of character delivery" {
    const down: Action = .{ .kind = "message", .message = .{ .message = 0x100, .value = 65, .bits = 0x001e0001 } };
    var state = try project(.{}, down);
    try std.testing.expect(state.held(65));
    state = try project(state, .{ .kind = "message", .message = .{ .message = 0x102, .value = 97, .bits = 0x001e0001 } });
    try std.testing.expect(state.held(65));
    const repeated: Action = .{ .kind = "message", .message = .{ .message = 0x100, .value = 65, .bits = 0x401e0001 } };
    try std.testing.expectEqualDeep(state, try project(state, repeated));
    state = try project(state, .{ .kind = "message", .message = .{ .message = 0x101, .value = 65, .bits = 0xc01e0001 } });
    try std.testing.expect(!state.held(65));
    try std.testing.expectError(error.KeyNotHeld, project(state, repeated));
    state = try project(state, .{ .kind = "message", .message = .{ .message = 0x104, .value = 18, .bits = 0x21380001 } });
    try std.testing.expect(state.held(0xa5) and state.held(0x12));
    const character: Action = .{ .kind = "message", .message = .{ .message = 0x102, .value = 0xd83d, .bits = 1 } };
    try std.testing.expectEqualDeep(state, try project(state, character));
    try std.testing.expectError(error.InvalidInput, messageKey(.{ .message = 0x10, .value = 0, .bits = 0 }));
}
