const core = @import("core.zig");

/// The host serializes access. Backend owns only platform resources; this
/// collection is the sole owner of mouse position and held-button state.
pub fn Objects(comptime Backend: type, comptime maximum: usize) type {
    return struct {
        const Self = @This();
        pub const Object = struct { id: u64, owner: u64, target: usize, state: core.State, backend: Backend };
        items: [maximum]?Object = @splat(null),
        next_id: u64 = 1,

        pub fn create(self: *Self, owner: u64, target: usize, point: core.Point, timeout_ms: u32) !*Object {
            var vacant: ?usize = null;
            for (&self.items, 0..) |*item, index| {
                if (item.*) |object| {
                    if (object.target == target) return error.TargetConflict;
                } else if (vacant == null) vacant = index;
            }
            const index = vacant orelse return error.ObjectLimit;
            if (self.next_id == 0) return error.ObjectLimit;
            const backend = try Backend.open(target, timeout_ms);
            self.items[index] = .{ .id = self.next_id, .owner = owner, .target = target,
                .state = .{ .point = point }, .backend = backend };
            self.next_id +%= 1;
            return &self.items[index].?;
        }

        pub fn get(self: *Self, owner: u64, id: u64) !*Object {
            for (&self.items) |*item| {
                if (item.*) |*object| if (object.id == id and object.owner == owner) return object;
            }
            return error.MouseNotFound;
        }

        pub fn input(object: *Object, action: core.Action) !void {
            if (!object.backend.alive()) return error.TargetLost;
            const steps = try core.plan(object.state, action);
            for (steps.events[0..steps.count]) |event| {
                object.backend.send(event) catch |err| {
                    // The receiver may have handled a sent message before its
                    // reply was lost. Never continue from guessed button state.
                    object.state.known = false;
                    return err;
                };
                object.state = event.state;
            }
        }

        pub fn reset(object: *Object) !void {
            if (!object.backend.alive()) return error.TargetLost;
            if (!object.state.known) {
                const intercepted = object.backend.intercepting();
                try object.backend.intercept(false);
                if (intercepted) try object.backend.intercept(true);
            }
            const steps = core.resetPlan(object.state);
            for (steps.events[0..steps.count]) |event| {
                object.backend.send(event) catch |err| { object.state.known = false; return err; };
                object.state = event.state;
            }
            object.state.known = true;
        }

        pub fn interception(object: *Object, enabled: bool) !void {
            if (!object.state.known or object.state.buttons != 0) return error.ResetRequired;
            try object.backend.intercept(enabled);
        }

        pub fn destroy(self: *Self, owner: u64, id: u64) !void {
            for (&self.items) |*item| {
                if (item.*) |*object| {
                    if (object.id != id or object.owner != owner) continue;
                    var reset_error: ?anyerror = null;
                    reset(object) catch |err| { reset_error = err; };
                    object.backend.close();
                    item.* = null;
                    if (reset_error) |err| return err;
                    return;
                }
            }
            return error.MouseNotFound;
        }

        pub fn cleanupOwner(self: *Self, owner: u64) void {
            for (&self.items) |*item| {
                if (item.*) |*object| if (object.owner == owner) {
                    reset(object) catch {};
                    object.backend.close();
                    item.* = null;
                };
            }
        }
    };
}

const std = @import("std");
const Fake = struct {
    intercepted: bool = false,
    fail: bool = false,
    events: usize = 0,
    pub fn open(_: usize, _: u32) !Fake { return .{}; }
    pub fn alive(_: Fake) bool { return true; }
    pub fn send(self: *Fake, _: core.Event) !void { if (self.fail) return error.InputTimeout; self.events += 1; }
    pub fn intercept(self: *Fake, value: bool) !void { self.intercepted = value; self.fail = false; }
    pub fn intercepting(self: Fake) bool { return self.intercepted; }
    pub fn close(_: *Fake) void {}
};

test "objects isolate owners, reject target collisions and never reuse a stale id" {
    var store: Objects(Fake, 2) = .{};
    const a = try store.create(1, 111, .{ .x = 0, .y = 0 }, 1000);
    const id = a.id;
    try std.testing.expectError(error.MouseNotFound, store.get(2, id));
    try std.testing.expectError(error.TargetConflict, store.create(2, 111, a.state.point, 1000));
    _ = try store.create(2, 222, a.state.point, 1000);
    try std.testing.expectError(error.ObjectLimit, store.create(1, 333, a.state.point, 1000));
    try store.destroy(1, id);
    const b = try store.create(1, 333, .{ .x = 0, .y = 0 }, 1000);
    try std.testing.expect(b.id != id);
    try std.testing.expectError(error.MouseNotFound, store.get(1, id));
    store.cleanupOwner(1);
    try std.testing.expectEqual(@as(u64, 2), (try store.get(2, 2)).owner);
}

test "failure stops continuation and only explicit reset restores known state" {
    const Store = Objects(Fake, 1);
    var store: Store = .{};
    const a = try store.create(1, 111, .{ .x = 0, .y = 0 }, 1000);
    try Store.input(a, .{ .button = .{ .button = .left, .action = .down } });
    try std.testing.expectError(error.ResetRequired, Store.interception(a, true));
    a.backend.fail = true;
    try std.testing.expectError(error.InputTimeout, Store.input(a, .{ .move = .{ .x = 2, .y = 3 } }));
    try std.testing.expect(!a.state.known);
    try std.testing.expectEqual(@as(i32, 0), a.state.point.x);
    try std.testing.expectError(error.StateUnknown, Store.input(a, .{ .move = .{ .x = 4, .y = 5 } }));
    try Store.reset(a);
    try std.testing.expect(a.state.known);
    try std.testing.expectEqual(@as(u8, 0), a.state.buttons);
    try std.testing.expectEqual(@as(usize, 6), a.backend.events);
}
