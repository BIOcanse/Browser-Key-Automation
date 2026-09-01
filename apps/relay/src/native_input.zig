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

pub const Phase = enum { prepare, input };
pub const ClickState = enum { not_sent, unknown };

pub const Failure = struct {
    reason: []const u8,
    phase: Phase,
    click_state: ClickState,
};

pub const Outcome = union(enum) {
    input_sent,
    failure: Failure,
};

var input_mutex: std.Io.Mutex = .init;

fn failed(reason: []const u8, phase: Phase, click_state: ClickState) Outcome {
    return .{ .failure = .{ .reason = reason, .phase = phase, .click_state = click_state } };
}

pub fn execute(io: std.Io, request: ClickRequest) Outcome {
    if (request.timeout_ms == 0 or request.marker.len < 12 or request.marker.len > 96 or
        !std.math.isFinite(request.point.x) or !std.math.isFinite(request.point.y) or
        !std.math.isFinite(request.viewport.width) or !std.math.isFinite(request.viewport.height) or
        request.viewport.width <= 0 or request.viewport.height <= 0 or
        request.point.x < 0 or request.point.y < 0 or
        request.point.x >= request.viewport.width or request.point.y >= request.viewport.height)
    {
        return failed("invalid_request", .prepare, .not_sent);
    }
    for (request.marker) |byte| {
        if (byte < 0x20 or byte > 0x7e) return failed("invalid_request", .prepare, .not_sent);
    }

    const started = std.Io.Clock.awake.now(io).nanoseconds;
    input_mutex.lockUncancelable(io);
    defer input_mutex.unlock(io);
    const elapsed = std.Io.Clock.awake.now(io).nanoseconds - started;
    if (elapsed >= @as(i96, request.timeout_ms) * std.time.ns_per_ms) {
        return failed("timeout", .prepare, .not_sent);
    }

    if (builtin.os.tag != .windows) return failed("backend_unavailable", .prepare, .not_sent);
    while (true) {
        windows.click(request) catch |err| switch (err) {
            error.WindowNotMatched, error.ContentNotMatched => {
                const now = std.Io.Clock.awake.now(io).nanoseconds;
                if (now - started >= @as(i96, request.timeout_ms) * std.time.ns_per_ms) {
                    return failed(
                        if (err == error.WindowNotMatched) "window_not_matched" else "content_not_matched",
                        .prepare,
                        .not_sent,
                    );
                }
                io.sleep(
                    .fromMilliseconds(@intCast(config.native_input_window_match_poll_ms)),
                    .awake,
                ) catch return failed("wait_interrupted", .prepare, .not_sent);
                continue;
            },
            error.InvalidCoordinates => return failed("invalid_coordinates", .prepare, .not_sent),
            error.GeometryChanged => return failed("geometry_changed", .input, .not_sent),
            error.UserInputConflict => return failed("user_input_conflict", .input, .not_sent),
            error.MoveFailed, error.DownFailed => return failed("input_rejected", .input, .not_sent),
            error.UpFailed => return failed("partial_input", .input, .unknown),
        };
        return .input_sent;
    }
}

test "non-Windows builds explicitly decline native input" {
    if (builtin.os.tag == .windows) return;
    const result = execute(std.testing.io, .{
        .marker = "BKA real test-token",
        .point = .{ .x = 1, .y = 1 },
        .viewport = .{ .width = 10, .height = 10 },
        .timeout_ms = 100,
    });
    try std.testing.expectEqualStrings("backend_unavailable", result.failure.reason);
}
