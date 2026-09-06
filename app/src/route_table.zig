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
        const route = try table.allocator.create(Route);
        errdefer table.allocator.destroy(route);
        const response = try table.allocator.alloc(u8, config.maximum_message_bytes);
        errdefer table.allocator.free(response);

        table.mutex.lockUncancelable(table.io);
        defer table.mutex.unlock(table.io);

        var free_index: ?usize = null;
        for (table.slots, 0..) |slot, index| {
            if (slot == null) {
                free_index = index;
                break;
            }
        }
        const index = free_index orelse return error.RouteCapacityReached;
        if (table.next_route_id == std.math.maxInt(u64)) return error.RouteIdExhausted;
        route.* = .{
            .id = table.next_route_id,
            .target_instance_number = target_instance_number,
            .response = response,
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

    pub fn complete(table: *RouteTable, route_id: u64, response: []const u8) !void {
        table.mutex.lockUncancelable(table.io);
        defer table.mutex.unlock(table.io);
        const route = table.findLocked(route_id) orelse return error.StaleRoute;
        if (route.status != .pending) return error.StaleRoute;
        if (response.len > route.response.len) return error.ResponseTooLarge;
        @memcpy(route.response[0..response.len], response);
        route.response_length = response.len;
        route.status = .completed;
        route.event.set(table.io);
    }

    pub fn isPendingForInstance(table: *RouteTable, route_id: u64, instance_number: u64) bool {
        table.mutex.lockUncancelable(table.io);
        defer table.mutex.unlock(table.io);
        const route = table.findLocked(route_id) orelse return false;
        return route.status == .pending and route.target_instance_number == instance_number;
    }

    pub fn failInstance(table: *RouteTable, instance_number: u64) void {
        table.mutex.lockUncancelable(table.io);
        defer table.mutex.unlock(table.io);
        for (table.slots) |slot| {
            const route = slot orelse continue;
            if (route.status == .pending and route.target_instance_number == instance_number) {
                route.status = .extension_disconnected;
                route.event.set(table.io);
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
    try table.complete(route.id, "response");
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
    try table.complete(route.id, "response");
    try std.testing.expect(!table.isPendingForInstance(route.id, 9));
}
