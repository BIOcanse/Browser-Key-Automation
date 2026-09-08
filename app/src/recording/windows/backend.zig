const std = @import("std");
const config = @import("../../generated_config.zig");
const browser = @import("../../native_input/windows.zig");
const c = @cImport({ @cInclude("recording/windows/client.h"); });

pub const Operation = struct {
    kind: enum { open, read, stop, close },
    resourceId: []const u8,
    marker: ?[]const u8 = null,
    capacity: ?u32 = null,
    durationMs: ?u32 = null,
    acknowledgeThrough: ?u32 = null,
    limit: ?u32 = null,
    discardUnacknowledged: ?bool = null,
};
pub const Outcome = enum { ok, invalid, target, conflict, install_failed, pending, cursor, unacknowledged, thread_limit };
const Resource = struct { id: [36]u8, namespace: u64, client: *c.RcClient };
var resources: [c.RC_MAX_CONTEXTS]?Resource = @splat(null);
var mutex: std.Io.Mutex = .init;

const Hex = struct {
    value: u64,
    pub fn jsonStringify(self: Hex, writer: anytype) !void {
        var buffer: [16]u8 = undefined;
        try writer.write(std.fmt.bufPrint(&buffer, "{x:0>16}", .{self.value}) catch unreachable);
    }
};
const Decimal = struct {
    value: i64,
    pub fn jsonStringify(self: Decimal, writer: anytype) !void {
        var buffer: [21]u8 = undefined;
        try writer.write(std.fmt.bufPrint(&buffer, "{d}", .{self.value}) catch unreachable);
    }
};
pub const Event = struct {
    raw: c.RcEvent,
    pub fn jsonStringify(self: Event, writer: anytype) !void {
        const value = self.raw;
        try writer.write(.{
            .sequence = value.sequence, .kind = value.kind, .phase = value.phase, .coordinates = "window",
            .message = value.message, .threadId = value.tid, .messageTime = value.message_time,
            .dpi = value.dpi, .hwnd = Hex{ .value = value.hwnd },
            .keyboardLayout = Hex{ .value = value.keyboard_layout }, .qpc = Decimal{ .value = value.qpc },
            .window = value.window, .clientScreen = value.client_screen,
            .contentScreen = if (value.content_valid != 0) @as(?c.RcRect, value.content_screen) else null,
            .visible = value.visible != 0, .iconic = value.iconic != 0,
            .point = if (value.point_valid != 0) @as(?struct { x: i32, y: i32 }, .{ .x = value.x, .y = value.y }) else null,
            .wParam = Hex{ .value = value.wparam }, .keyLParam = Hex{ .value = value.key_lparam },
            .position = .{ .x = value.position_x, .y = value.position_y, .width = value.position_width,
                .height = value.position_height, .flags = value.position_flags },
            .suggestedRect = value.suggested_rect,
        });
    }
};
pub const Status = struct {
    raw: c.RcStatus,
    pub fn jsonStringify(self: Status, writer: anytype) !void {
        const value = self.raw;
        try writer.write(.{
            .reason = value.reason, .reserved = value.reserved, .acknowledged = value.acknowledged,
            .delivered = value.delivered, .lost = value.lost, .attached = value.attached,
            .detached = value.detached, .callbacks = value.callbacks, .cleanup = value.cleanup != 0,
            .snapshotValid = value.snapshot_valid != 0, .enrolledThreadsOnly = value.enrolled_threads_only != 0,
            .pendingInstallations = value.pending_installations,
            .startedQpc = Decimal{ .value = value.started_qpc }, .qpcFrequency = Decimal{ .value = value.qpc_frequency },
            .startedUnixMs = value.started_unix_ms,
            .geometry = if (value.geometry_valid != 0) @as(?Geometry, .{ .raw = value.geometry }) else null,
        });
    }
};
const Geometry = struct {
    raw: c.RcEvent,
    pub fn jsonStringify(self: Geometry, writer: anytype) !void {
        const value = self.raw;
        try writer.write(.{ .qpc = Decimal{ .value = value.qpc }, .dpi = value.dpi,
            .window = value.window, .clientScreen = value.client_screen,
            .contentScreen = if (value.content_valid != 0) @as(?c.RcRect, value.content_screen) else null,
            .visible = value.visible != 0, .iconic = value.iconic != 0 });
    }
};
pub const Result = struct {
    resourceId: ?[]const u8 = null,
    outcome: Outcome = .ok,
    status: ?Status = null,
    events: []const Event = &.{},
    calibration: ?Calibration = null,
};
const Calibration = struct {
    raw: browser.InputCalibration,
    pub fn jsonStringify(self: Calibration, writer: anytype) !void {
        const value = self.raw;
        try writer.write(.{ .root = Hex{ .value = value.root }, .content = Hex{ .value = value.content },
            .processId = value.process_id, .rootWidth = value.root_width, .rootHeight = value.root_height,
            .dpi = value.dpi, .x = value.x, .y = value.y, .width = value.width, .height = value.height });
    }
};

fn outcome(code: c_int) Outcome {
    return switch (code) {
        c.RC_OK => .ok, c.RC_INVALID => .invalid, c.RC_TARGET => .target, c.RC_CONFLICT => .conflict,
        c.RC_INSTALL_FAILED => .install_failed, c.RC_PENDING => .pending, c.RC_CURSOR => .cursor,
        c.RC_UNACKNOWLEDGED => .unacknowledged, c.RC_THREAD_LIMIT => .thread_limit, else => .invalid,
    };
}
fn validate(operation: Operation, timeout: u32) !void {
    if (timeout == 0 or timeout > config.local_route_maximum_duration_ms) return error.InvalidRecordingOperation;
    if (operation.resourceId.len != 36) return error.InvalidRecordingOperation;
    for (operation.resourceId, 0..) |char, index| {
        const hyphen = index == 8 or index == 13 or index == 18 or index == 23;
        if (hyphen and char != '-' or !hyphen and !(char >= '0' and char <= '9' or char >= 'a' and char <= 'f')) return error.InvalidRecordingOperation;
    }
    if (operation.kind == .open) {
        const marker = operation.marker orelse return error.InvalidRecordingOperation;
        if (operation.acknowledgeThrough != null or operation.limit != null or operation.discardUnacknowledged != null or
            marker.len == 0 or marker.len > 256 or
            operation.capacity == null or operation.capacity.? == 0 or operation.capacity.? > c.RC_MAX_CAPACITY or
            operation.durationMs == null or operation.durationMs.? == 0 or operation.durationMs.? > config.recording_maximum_duration_ms)
            return error.InvalidRecordingOperation;
    } else {
        if (operation.marker != null or
            operation.capacity != null or operation.durationMs != null) return error.InvalidRecordingOperation;
        if (operation.kind == .read) {
            if (operation.acknowledgeThrough == null or operation.limit == null or operation.limit.? == 0 or
                operation.limit.? > config.recording_maximum_batch_events or operation.discardUnacknowledged != null) return error.InvalidRecordingOperation;
        } else if (operation.acknowledgeThrough != null or operation.limit != null or
            (operation.kind == .close) != (operation.discardUnacknowledged != null)) return error.InvalidRecordingOperation;
    }
}
fn read(client: *c.RcClient, ack: u32, limit: u32, events: *[config.recording_maximum_batch_events]Event, result: *Result) void {
    var raw: [config.recording_maximum_batch_events]c.RcEvent = undefined;
    var status: c.RcStatus = std.mem.zeroes(c.RcStatus);
    var count: u32 = 0;
    result.outcome = outcome(c.rc_read(client, ack, &raw, limit, &count, &status));
    for (raw[0..count], events[0..count]) |source, *destination| destination.* = .{ .raw = source };
    result.events = events[0..count];
    result.status = .{ .raw = status };
}
fn collectRetired() void {
    // A disconnected owner cannot consume its tail. Keep a pending C resource
    // until close confirms detach; subsequent admissions reclaim finished ones.
    for (&resources) |*slot| if (slot.*) |resource| {
        if (resource.namespace != 0) continue;
        var status: c.RcStatus = std.mem.zeroes(c.RcStatus);
        if (c.rc_close(resource.client, 1, 1, &status) == c.RC_OK) slot.* = null;
    };
}
pub fn execute(io: std.Io, namespace: u64, timeout: u32, operation: Operation, events: *[config.recording_maximum_batch_events]Event) !Result {
    try validate(operation, timeout);
    const started = std.Io.Clock.awake.now(io).nanoseconds;
    if (namespace == 0) return error.RecordingNotFound;
    mutex.lockUncancelable(io);
    defer mutex.unlock(io);
    if (operation.kind == .open) {
        collectRetired();
        var available: ?*?Resource = null;
        for (&resources) |*slot| {
            if (slot.*) |resource| {
                if (resource.namespace == namespace and std.mem.eql(u8, &resource.id, operation.resourceId)) return error.RecordingExists;
            } else if (available == null) available = slot;
        }
        const slot = available orelse return error.RecordingCapacity;
        const root = try browser.resolveRootWindowReady(io, operation.marker.?, started, timeout, config.native_input_window_match_poll_ms);
        const elapsed = @max(0, @divTrunc(std.Io.Clock.awake.now(io).nanoseconds - started, std.time.ns_per_ms));
        if (elapsed >= timeout) return error.InputTimeout;
        const budget = timeout - @as(u32, @intCast(elapsed));
        var client: ?*c.RcClient = null;
        const code = c.rc_open(root, operation.capacity.?, operation.durationMs.?, budget, &client);
        if (client == null) return .{ .outcome = outcome(code) };
        slot.* = .{ .id = operation.resourceId[0..36].*, .namespace = namespace, .client = client.? };
        var result: Result = .{ .resourceId = operation.resourceId };
        read(client.?, 0, @min(operation.capacity.?, config.recording_maximum_batch_events), events, &result);
        if (code != c.RC_OK) result.outcome = outcome(code);
        return result;
    }
    for (&resources) |*slot| if (slot.*) |resource| {
        if (resource.namespace != namespace or !std.mem.eql(u8, &resource.id, operation.resourceId)) continue;
        var result: Result = .{ .resourceId = operation.resourceId };
        if (operation.kind == .read) read(resource.client, operation.acknowledgeThrough.?, operation.limit.?, events, &result) else {
            var status: c.RcStatus = std.mem.zeroes(c.RcStatus);
            const code = if (operation.kind == .stop) c.rc_stop(resource.client, timeout, &status)
                else c.rc_close(resource.client, timeout, @intFromBool(operation.discardUnacknowledged.?), &status);
            result.outcome = outcome(code);
            result.status = .{ .raw = status };
            if (operation.kind == .close and code == c.RC_OK) slot.* = null;
        }
        return result;
    };
    return error.RecordingNotFound;
}
pub fn cleanupInstance(io: std.Io, namespace: u64) void {
    mutex.lockUncancelable(io);
    defer mutex.unlock(io);
    for (&resources) |*slot| if (slot.*) |*resource| {
        if (resource.namespace != namespace) continue;
        resource.namespace = 0;
        var status: c.RcStatus = std.mem.zeroes(c.RcStatus);
        if (c.rc_close(resource.client, config.virtual_mouse_cleanup_timeout_ms, 1, &status) == c.RC_OK) slot.* = null;
    };
}

test "recording boundary has no point and 64-bit native fields stay exact JSON strings" {
    var raw = std.mem.zeroes(c.RcEvent);
    raw.kind = c.RC_EXIT;
    raw.keyboard_layout = 0xfedcba9876543210;
    raw.qpc = 9007199254740993;
    const json = try std.json.Stringify.valueAlloc(std.testing.allocator, Event{ .raw = raw }, .{});
    defer std.testing.allocator.free(json);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"point\":null") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"keyboardLayout\":\"fedcba9876543210\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"qpc\":\"9007199254740993\"") != null);
}
test "recording operation validates its own fields before native work" {
    const id = "4ac9818f-f09f-408c-b0c6-c87e3046659b";
    try validate(.{ .kind = .read, .resourceId = id, .acknowledgeThrough = 0, .limit = 1 }, 100);
    try std.testing.expectError(error.InvalidRecordingOperation, validate(.{ .kind = .read, .resourceId = id, .acknowledgeThrough = 0, .limit = 1, .marker = "extra" }, 100));
    try std.testing.expectError(error.InvalidRecordingOperation, validate(.{ .kind = .close, .resourceId = id }, 100));
    try std.testing.expectError(error.InvalidRecordingOperation, validate(.{ .kind = .stop, .resourceId = id, .discardUnacknowledged = true }, 100));
}

test "recording resource ownership and duplicate admission precede native calls" {
    const id = "4ac9818f-f09f-408c-b0c6-c87e3046659b";
    // No live resource: either guard must return before dereferencing this value.
    resources[0] = .{ .id = id.*, .namespace = 7, .client = @ptrFromInt(1) };
    defer resources[0] = null;
    var events: [config.recording_maximum_batch_events]Event = undefined;
    try std.testing.expectError(error.RecordingNotFound, execute(std.testing.io, 8, 100,
        .{ .kind = .read, .resourceId = id, .acknowledgeThrough = 0, .limit = 1 }, &events));
    try std.testing.expectError(error.RecordingExists, execute(std.testing.io, 7, 100,
        .{ .kind = .open, .resourceId = id, .marker = "marker", .capacity = 16, .durationMs = 1000 }, &events));
}
test "a maximum native event fits the configured transport batch budget" {
    var raw = std.mem.zeroes(c.RcEvent);
    inline for (.{ "sequence", "kind", "phase", "message", "tid", "message_time", "dpi", "hwnd", "keyboard_layout", "qpc", "wparam", "key_lparam", "position_flags" }) |field|
        @field(raw, field) = std.math.maxInt(@TypeOf(@field(raw, field)));
    inline for (.{ "x", "y", "position_x", "position_y", "position_width", "position_height" }) |field| @field(raw, field) = std.math.minInt(i32);
    const rect: c.RcRect = .{ .left = std.math.minInt(i32), .top = std.math.minInt(i32), .right = std.math.maxInt(i32), .bottom = std.math.maxInt(i32) };
    raw.window = rect; raw.client_screen = rect; raw.suggested_rect = rect; raw.point_valid = 1;
    const json = try std.json.Stringify.valueAlloc(std.testing.allocator, Event{ .raw = raw }, .{});
    defer std.testing.allocator.free(json);
    try std.testing.expect(json.len <= 1600);
    try std.testing.expect(config.recording_maximum_batch_events * 1600 + 8192 <= config.maximum_message_bytes);
}
