const std = @import("std");

pub const Key = struct { virtualKey: u16, extended: bool };
pub const Action = struct {
    kind: []const u8,
    keys: ?[]const Key = null,
    holdMs: ?u32 = null,
    waitMs: ?u32 = null,
};

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
        // The shared key parser normalizes generic Ctrl/Shift/Alt to left-sided keys.
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
    if (std.mem.eql(u8, action.kind, "wait")) return state;
    var next = state;
    const keys = action.keys orelse return error.InvalidInput;
    const down = std.mem.eql(u8, action.kind, "down");
    const up = std.mem.eql(u8, action.kind, "up");
    const press = std.mem.eql(u8, action.kind, "press");
    if (!down and !up and !press) return error.InvalidInput;
    for (keys) |key| {
        if (key.virtualKey == 0 or key.virtualKey >= 256) return error.InvalidInput;
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
