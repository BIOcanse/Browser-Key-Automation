//! Platform-neutral mouse primitives. Planning is pure; only the owner commits
//! a state after the backend acknowledges that exact event. No implicit input.
const std = @import("std");

pub const Point = struct { x: i32, y: i32 };
pub const Button = enum(u8) {
    left = 1,
    right = 2,
    middle = 4,
    back = 8,
    forward = 16,

    pub fn mask(self: Button) u8 {
        return @intFromEnum(self);
    }
};
pub const ButtonAction = enum { press, down, up };
pub const State = struct {
    point: Point,
    coordinates: enum { css_viewport, window } = .css_viewport,
    buttons: u8 = 0,
    known: bool = true,
};
pub const Action = union(enum) {
    move: Point,
    moveWindow: Point,
    button: struct { button: Button, action: ButtonAction },
    wheel: struct { delta_x: i16, delta_y: i16 },
};
pub const Event = struct {
    kind: enum { move, down, up, wheel },
    state: State,
    button: ?Button = null,
    delta_x: i16 = 0,
    delta_y: i16 = 0,
};
pub const Plan = struct {
    events: [5]Event = undefined,
    count: usize = 0,

    fn append(self: *Plan, event: Event) void {
        std.debug.assert(self.count < self.events.len);
        self.events[self.count] = event;
        self.count += 1;
    }
};
pub const PlanError = error{ StateUnknown, ButtonAlreadyDown };

pub fn plan(state: State, action: Action) PlanError!Plan {
    if (!state.known) return error.StateUnknown;
    var result: Plan = .{};
    switch (action) {
        .move => |point| result.append(.{ .kind = .move, .state = .{ .point = point, .buttons = state.buttons } }),
        .moveWindow => |point| result.append(.{ .kind = .move, .state = .{ .point = point, .coordinates = .window, .buttons = state.buttons } }),
        .button => |button| {
            const held = (state.buttons & button.button.mask()) != 0;
            switch (button.action) {
                .down => if (!held) {
                    var next = state;
                    next.buttons |= button.button.mask();
                    result.append(.{ .kind = .down, .state = next, .button = button.button });
                },
                .up => if (held) {
                    var next = state;
                    next.buttons &= ~button.button.mask();
                    result.append(.{ .kind = .up, .state = next, .button = button.button });
                },
                .press => {
                    if (held) return error.ButtonAlreadyDown;
                    var next = state;
                    next.buttons |= button.button.mask();
                    result.append(.{ .kind = .down, .state = next, .button = button.button });
                    result.append(.{ .kind = .up, .state = state, .button = button.button });
                },
            }
        },
        .wheel => |wheel| {
            if (wheel.delta_x != 0 or wheel.delta_y != 0) result.append(.{
                .kind = .wheel,
                .state = state,
                .delta_x = wheel.delta_x,
                .delta_y = wheel.delta_y,
            });
        },
    }
    return result;
}

/// An uncertain delivery must be explicitly reset. Releasing every virtual
/// button is safe because this backend never owns the hardware mouse buttons.
pub fn resetPlan(state: State) Plan {
    var result: Plan = .{};
    var next = state;
    const buttons = [_]Button{ .left, .right, .middle, .back, .forward };
    for (buttons) |button| {
        if (state.known and (next.buttons & button.mask()) == 0) continue;
        next.buttons &= ~button.mask();
        result.append(.{ .kind = .up, .state = next, .button = button });
    }
    // Caller marks known=true only after the entire reset is acknowledged.
    return result;
}

test "planning never mutates the owner's mouse" {
    const state: State = .{ .point = .{ .x = 10, .y = 20 } };
    const movement = try plan(state, .{ .move = .{ .x = 30, .y = 40 } });
    try std.testing.expectEqual(@as(i32, 10), state.point.x);
    try std.testing.expectEqual(@as(usize, 1), movement.count);
    try std.testing.expectEqual(@as(i32, 30), movement.events[0].state.point.x);
}

test "window movement and both side buttons share one pointer and held state" {
    const moved = try plan(.{ .point = .{ .x = 0, .y = 0 } }, .{ .moveWindow = .{ .x = 140, .y = 88 } });
    var state = moved.events[0].state;
    for ([_]Button{ .back, .forward }) |button| {
        const down = try plan(state, .{ .button = .{ .button = button, .action = .down } });
        state = down.events[0].state;
    }
    try std.testing.expectEqual(@as(u8, 24), state.buttons);
    const wheel = try plan(state, .{ .wheel = .{ .delta_x = 120, .delta_y = -120 } });
    try std.testing.expectEqual(.window, wheel.events[0].state.coordinates);
    try std.testing.expectEqual(@as(i32, 140), wheel.events[0].state.point.x);
    const reset = resetPlan(state);
    try std.testing.expectEqual(@as(usize, 2), reset.count);
    try std.testing.expectEqual(.back, reset.events[0].button.?);
    try std.testing.expectEqual(.forward, reset.events[1].button.?);
    try std.testing.expectEqual(@as(u8, 0), reset.events[1].state.buttons);
    const css = try plan(state, .{ .move = .{ .x = 10, .y = 20 } });
    try std.testing.expectEqual(.css_viewport, css.events[0].state.coordinates);
    try std.testing.expectEqual(@as(u8, 24), css.events[0].state.buttons);
}

test "press is exactly down and up without motion" {
    const state: State = .{ .point = .{ .x = -12, .y = 200 }, .buttons = Button.right.mask() };
    const press = try plan(state, .{ .button = .{ .button = .left, .action = .press } });
    try std.testing.expectEqual(@as(usize, 2), press.count);
    try std.testing.expectEqual(.down, press.events[0].kind);
    try std.testing.expectEqual(@as(u8, 3), press.events[0].state.buttons);
    try std.testing.expectEqual(.up, press.events[1].kind);
    try std.testing.expectEqual(state, press.events[1].state);
    try std.testing.expectError(error.ButtonAlreadyDown, plan(state, .{ .button = .{ .button = .right, .action = .press } }));
}

test "down and up are idempotent while different buttons stay independent" {
    const state: State = .{ .point = .{ .x = 0, .y = 0 }, .buttons = 1 };
    try std.testing.expectEqual(@as(usize, 0), (try plan(state, .{ .button = .{ .button = .left, .action = .down } })).count);
    try std.testing.expectEqual(@as(usize, 0), (try plan(state, .{ .button = .{ .button = .right, .action = .up } })).count);
    const other = try plan(state, .{ .button = .{ .button = .forward, .action = .down } });
    try std.testing.expectEqual(@as(u8, 17), other.events[0].state.buttons);
}

test "drag preserves button state across independent calls" {
    var state: State = .{ .point = .{ .x = 1, .y = 2 } };
    const down = try plan(state, .{ .button = .{ .button = .left, .action = .down } });
    state = down.events[0].state;
    const movement = try plan(state, .{ .move = .{ .x = 50, .y = 60 } });
    state = movement.events[0].state;
    try std.testing.expectEqual(@as(u8, 1), state.buttons);
    const up = try plan(state, .{ .button = .{ .button = .left, .action = .up } });
    try std.testing.expectEqual(@as(u8, 0), up.events[0].state.buttons);
    try std.testing.expectEqual(@as(i32, 50), up.events[0].state.point.x);
}

test "wheel is one primitive and never changes point or held buttons" {
    const state: State = .{ .point = .{ .x = 90, .y = 80 }, .buttons = 4 };
    const wheel = try plan(state, .{ .wheel = .{ .delta_x = 120, .delta_y = -120 } });
    try std.testing.expectEqual(state, wheel.events[0].state);
    try std.testing.expectEqual(@as(i16, -120), wheel.events[0].delta_y);
    try std.testing.expectEqual(@as(usize, 0), (try plan(state, .{ .wheel = .{ .delta_x = 0, .delta_y = 0 } })).count);
}

test "unknown state rejects continuation but explicit reset releases all virtual buttons" {
    const state: State = .{ .point = .{ .x = 10, .y = 20 }, .buttons = 1, .known = false };
    try std.testing.expectError(error.StateUnknown, plan(state, .{ .move = .{ .x = 0, .y = 0 } }));
    const reset = resetPlan(state);
    try std.testing.expectEqual(@as(usize, 5), reset.count);
    try std.testing.expectEqual(@as(u8, 0), reset.events[4].state.buttons);
    try std.testing.expectEqual(@as(usize, 1), resetPlan(.{ .point = state.point, .buttons = 4 }).count);
}
