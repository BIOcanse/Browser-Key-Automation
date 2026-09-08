const std = @import("std");
const config = @import("generated_config.zig");

pub const RouteStatus = enum {
    pending,
    completed,
    extension_disconnected,
};

pub const Route = struct {
    id: u64,
    target_instance_number: u64,
    event: std.Io.Event = .unset,
    status: RouteStatus = .pending,
    response: []u8,
    response_length: usize = 0,
    // Null: the forwarding waiter owns this route. Local routes belong to the
    // table and may only be used before this App-owned monotonic deadline.
    local_deadline_ns: ?i96 = null,
};

pub const RouteTable = struct {
    io: std.Io,
    allocator: std.mem.Allocator,
    mutex: std.Io.Mutex = .init,
    next_route_id: u64 = 1,
    slots: [config.maximum_pending_routes]?*Route = [_]?*Route{null} ** config.maximum_pending_routes,

    pub fn init(io: std.Io, allocator: std.mem.Allocator) RouteTable {
        return .{ .io = io, .allocator = allocator };
    }

    pub fn create(table: *RouteTable, target_instance_number: u64) !*Route {
        table.mutex.lockUncancelable(table.io);
        defer table.mutex.unlock(table.io);
        return table.allocateLocked(target_instance_number, null);
    }

    pub fn openLocal(table: *RouteTable, instance_number: u64, duration_ms: u32) !u64 {
        if (duration_ms == 0 or duration_ms > config.local_route_maximum_duration_ms) return error.InvalidRouteDuration;
        table.mutex.lockUncancelable(table.io);
        defer table.mutex.unlock(table.io);
        const deadline = std.Io.Clock.awake.now(table.io).nanoseconds + @as(i96, duration_ms) * std.time.ns_per_ms;
        const route = try table.allocateLocked(instance_number, deadline);
        return route.id;
    }

    pub fn closeLocal(table: *RouteTable, instance_number: u64, route_id: u64) bool {
        table.mutex.lockUncancelable(table.io);
        defer table.mutex.unlock(table.io);
        for (&table.slots) |*slot| {
            const route = slot.* orelse continue;
            if (route.id != route_id) continue;
            if (route.target_instance_number != instance_number or route.local_deadline_ns == null) return false;
            table.freeLocalLocked(slot);
            return true;
        }
        return false;
    }

    fn freeLocalLocked(table: *RouteTable, slot: *?*Route) void {
        const route = slot.*.?;
        std.debug.assert(route.local_deadline_ns != null);
        slot.* = null;
        table.allocator.free(route.response);
        table.allocator.destroy(route);
    }

    fn expireLocalLocked(table: *RouteTable, now: i96) void {
        for (&table.slots) |*slot| {
            const route = slot.* orelse continue;
            if (route.local_deadline_ns) |deadline| {
                if (deadline <= now) table.freeLocalLocked(slot);
            }
        }
    }

    fn allocateLocked(table: *RouteTable, target_instance_number: u64, local_deadline_ns: ?i96) !*Route {
        table.expireLocalLocked(std.Io.Clock.awake.now(table.io).nanoseconds);

        var free_index: ?usize = null;
        for (table.slots, 0..) |slot, index| {
            if (slot == null) {
                free_index = index;
                break;
            }
        }
        const index = free_index orelse return error.RouteCapacityReached;
        if (table.next_route_id == std.math.maxInt(u64)) return error.RouteIdExhausted;
        const route = try table.allocator.create(Route);
        errdefer table.allocator.destroy(route);
        const response = try table.allocator.alloc(u8, if (local_deadline_ns == null) config.maximum_message_bytes else 0);
        route.* = .{
            .id = table.next_route_id,
            .target_instance_number = target_instance_number,
            .response = response,
            .local_deadline_ns = local_deadline_ns,
        };
        table.next_route_id += 1;
        table.slots[index] = route;
        return route;
    }

    pub fn destroy(table: *RouteTable, route: *Route) void {
        table.mutex.lockUncancelable(table.io);
        for (&table.slots) |*slot| {
            if (slot.* == route) {
                slot.* = null;
                break;
            }
        }
        table.mutex.unlock(table.io);
        table.allocator.free(route.response);
        table.allocator.destroy(route);
    }

    pub fn complete(table: *RouteTable, route_id: u64, instance_number: u64, response: []const u8) !void {
        table.mutex.lockUncancelable(table.io);
        defer table.mutex.unlock(table.io);
        const route = table.findLocked(route_id) orelse return error.StaleRoute;
        if (route.status != .pending or route.local_deadline_ns != null or route.target_instance_number != instance_number) return error.StaleRoute;
        if (response.len > route.response.len) return error.ResponseTooLarge;
        @memcpy(route.response[0..response.len], response);
        route.response_length = response.len;
        route.status = .completed;
        route.event.set(table.io);
    }

    pub fn isPendingForInstance(table: *RouteTable, route_id: u64, instance_number: u64) bool {
        return table.remainingTimeoutForInstance(route_id, instance_number, 1) != null;
    }

    pub fn remainingTimeoutForInstance(table: *RouteTable, route_id: u64, instance_number: u64, requested_ms: u32) ?u32 {
        table.mutex.lockUncancelable(table.io);
        defer table.mutex.unlock(table.io);
        const now = std.Io.Clock.awake.now(table.io).nanoseconds;
        table.expireLocalLocked(now);
        const route = table.findLocked(route_id) orelse return null;
        if (route.status != .pending or route.target_instance_number != instance_number) return null;
        if (route.local_deadline_ns) |deadline| {
            const remaining_ms = @divTrunc(deadline - now, std.time.ns_per_ms);
            if (remaining_ms <= 0) return null;
            return @intCast(@min(@as(i96, requested_ms), remaining_ms));
        }
        return requested_ms;
    }

    pub fn failInstance(table: *RouteTable, instance_number: u64) void {
        table.mutex.lockUncancelable(table.io);
        defer table.mutex.unlock(table.io);
        for (&table.slots) |*slot| {
            const route = slot.* orelse continue;
            if (route.status == .pending and route.target_instance_number == instance_number) {
                if (route.local_deadline_ns != null) table.freeLocalLocked(slot) else {
                    route.status = .extension_disconnected;
                    route.event.set(table.io);
                }
            }
        }
    }

    fn findLocked(table: *RouteTable, route_id: u64) ?*Route {
        for (table.slots) |slot| {
            const route = slot orelse continue;
            if (route.id == route_id) return route;
        }
        return null;
    }
};

test "route completion wakes the exact waiter" {
    var table = RouteTable.init(std.testing.io, std.testing.allocator);
    const route = try table.create(7);
    defer table.destroy(route);
    try table.complete(route.id, 7, "response");
    try route.event.wait(std.testing.io);
    try std.testing.expectEqual(RouteStatus.completed, route.status);
    try std.testing.expectEqualStrings("response", route.response[0..route.response_length]);
}

test "disconnect fails only routes for that instance" {
    var table = RouteTable.init(std.testing.io, std.testing.allocator);
    const first = try table.create(1);
    defer table.destroy(first);
    const second = try table.create(2);
    defer table.destroy(second);
    table.failInstance(1);
    try std.testing.expectEqual(RouteStatus.extension_disconnected, first.status);
    try std.testing.expectEqual(RouteStatus.pending, second.status);
}

test "native subrequests can only reference their instance pending route" {
    var table = RouteTable.init(std.testing.io, std.testing.allocator);
    const route = try table.create(9);
    defer table.destroy(route);
    try std.testing.expect(table.isPendingForInstance(route.id, 9));
    try std.testing.expect(!table.isPendingForInstance(route.id, 8));
    try table.complete(route.id, 9, "response");
    try std.testing.expect(!table.isPendingForInstance(route.id, 9));
}

test "local routes share IDs but cannot close or complete forwarding waiters" {
    var table = RouteTable.init(std.testing.io, std.testing.allocator);
    const forwarded = try table.create(7);
    defer table.destroy(forwarded);
    const local = try table.openLocal(7, 1000);
    defer _ = table.closeLocal(7, local);
    try std.testing.expect(local > forwarded.id);
    try std.testing.expect(!table.closeLocal(7, forwarded.id));
    try std.testing.expect(!table.closeLocal(8, local));
    try std.testing.expectError(error.StaleRoute, table.complete(local, 7, "response"));
    try std.testing.expectError(error.StaleRoute, table.complete(forwarded.id, 8, "response"));
    try std.testing.expect(table.isPendingForInstance(local, 7));
    try table.complete(forwarded.id, 7, "response");
    try std.testing.expectEqual(RouteStatus.completed, forwarded.status);
    try std.testing.expect(table.closeLocal(7, local));
    try std.testing.expect(!table.closeLocal(7, local));
}

test "local expiry limits native duration and releases capacity without a reader" {
    var table = RouteTable.init(std.testing.io, std.testing.allocator);
    defer table.failInstance(7);
    const first = try table.openLocal(7, 1000);
    const duration = table.remainingTimeoutForInstance(first, 7, 10000).?;
    try std.testing.expect(duration > 0 and duration <= 1000);
    try std.testing.expect(table.remainingTimeoutForInstance(first, 8, 1) == null);
    for (1..config.maximum_pending_routes) |_| _ = try table.openLocal(7, config.local_route_maximum_duration_ms);
    try std.testing.expectError(error.RouteCapacityReached, table.openLocal(7, 1000));
    // Model a passed App deadline without sleeping or depending on wall-clock timing.
    table.findLocked(first).?.local_deadline_ns = std.Io.Clock.awake.now(table.io).nanoseconds - 1;
    const replacement = try table.openLocal(7, 1000);
    try std.testing.expect(replacement > first);
    try std.testing.expect(!table.isPendingForInstance(first, 7));
    table.findLocked(replacement).?.local_deadline_ns = std.Io.Clock.awake.now(table.io).nanoseconds - 1;
    try std.testing.expect(table.remainingTimeoutForInstance(replacement, 7, 1000) == null);
}

test "disconnect frees local resources but leaves each forwarding waiter to its owner" {
    var table = RouteTable.init(std.testing.io, std.testing.allocator);
    const forwarded = try table.create(7);
    defer table.destroy(forwarded);
    const local = try table.openLocal(7, 1000);
    const other = try table.openLocal(8, 1000);
    defer _ = table.closeLocal(8, other);
    table.failInstance(7);
    try std.testing.expectEqual(RouteStatus.extension_disconnected, forwarded.status);
    try std.testing.expect(!table.closeLocal(7, local));
    try std.testing.expect(table.isPendingForInstance(other, 8));
    try std.testing.expectError(error.InvalidRouteDuration, table.openLocal(7, 0));
    try std.testing.expectError(error.InvalidRouteDuration, table.openLocal(7, config.local_route_maximum_duration_ms + 1));
}
