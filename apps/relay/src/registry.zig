const std = @import("std");
const config = @import("generated_config.zig");
const websocket = @import("websocket.zig");

pub const InstanceRef = struct {
    instance_number: u64,
};

const Entry = struct {
    instance_number: u64 = 0,
    connected: bool = false,
    ready: bool = false,
    writer: ?*std.Io.Writer = null,
    writer_mutex: std.Io.Mutex = .init,
};

pub const Registry = struct {
    io: std.Io,
    mutex: std.Io.Mutex = .init,
    relay_epoch: [22]u8,
    next_instance_number: u64 = 1,
    entries: [config.maximum_online_extensions]Entry = [_]Entry{.{}} ** config.maximum_online_extensions,

    pub fn init(io: std.Io) Registry {
        var random_bytes: [16]u8 = undefined;
        io.random(&random_bytes);
        var relay_epoch: [22]u8 = undefined;
        _ = std.base64.url_safe_no_pad.Encoder.encode(&relay_epoch, &random_bytes);
        return .{
            .io = io,
            .relay_epoch = relay_epoch,
        };
    }

    pub fn registerExtension(registry: *Registry, writer: *std.Io.Writer) !InstanceRef {
        registry.mutex.lockUncancelable(registry.io);
        defer registry.mutex.unlock(registry.io);

        var free_index: ?usize = null;
        for (registry.entries, 0..) |entry, index| {
            if (!entry.connected) {
                free_index = index;
                break;
            }
        }
        const index = free_index orelse return error.ExtensionCapacityReached;
        if (registry.next_instance_number == std.math.maxInt(u64)) return error.InstanceNumberExhausted;

        const instance_number = registry.next_instance_number;
        registry.next_instance_number += 1;
        registry.entries[index] = .{
            .instance_number = instance_number,
            .connected = true,
            .writer = writer,
        };
        return .{ .instance_number = instance_number };
    }

    pub fn activateExtension(registry: *Registry, instance_ref: InstanceRef) !void {
        registry.mutex.lockUncancelable(registry.io);
        defer registry.mutex.unlock(registry.io);
        const entry = registry.findConnectedLocked(instance_ref.instance_number) orelse return error.StaleInstance;
        entry.ready = true;
    }

    pub fn unregisterExtension(registry: *Registry, instance_ref: InstanceRef) void {
        registry.mutex.lockUncancelable(registry.io);
        for (&registry.entries) |*entry| {
            if (entry.connected and entry.instance_number == instance_ref.instance_number) {
                entry.writer_mutex.lockUncancelable(registry.io);
                entry.ready = false;
                entry.connected = false;
                entry.writer = null;
                entry.writer_mutex.unlock(registry.io);
                registry.mutex.unlock(registry.io);
                return;
            }
        }
        registry.mutex.unlock(registry.io);
    }

    pub fn writeToConnected(
        registry: *Registry,
        instance_ref: InstanceRef,
        opcode: websocket.Opcode,
        payload: []const u8,
    ) !void {
        const entry = try registry.lockEntryForWrite(instance_ref.instance_number, false);
        defer entry.writer_mutex.unlock(registry.io);
        try websocket.writeServerFrame(entry.writer orelse return error.StaleInstance, opcode, payload);
    }

    pub fn writeToReady(
        registry: *Registry,
        relay_epoch: []const u8,
        instance_number: u64,
        opcode: websocket.Opcode,
        payload: []const u8,
    ) !void {
        if (!std.mem.eql(u8, relay_epoch, &registry.relay_epoch)) return error.StaleInstance;
        const entry = try registry.lockEntryForWrite(instance_number, true);
        defer entry.writer_mutex.unlock(registry.io);
        try websocket.writeServerFrame(entry.writer orelse return error.StaleInstance, opcode, payload);
    }

    fn lockEntryForWrite(registry: *Registry, instance_number: u64, require_ready: bool) !*Entry {
        registry.mutex.lockUncancelable(registry.io);
        const entry = registry.findConnectedLocked(instance_number) orelse {
            registry.mutex.unlock(registry.io);
            return error.StaleInstance;
        };
        if (require_ready and !entry.ready) {
            registry.mutex.unlock(registry.io);
            return error.StaleInstance;
        }
        entry.writer_mutex.lockUncancelable(registry.io);
        registry.mutex.unlock(registry.io);
        if (!entry.connected or (require_ready and !entry.ready) or entry.writer == null) {
            entry.writer_mutex.unlock(registry.io);
            return error.StaleInstance;
        }
        return entry;
    }

    fn findConnectedLocked(registry: *Registry, instance_number: u64) ?*Entry {
        for (&registry.entries) |*entry| {
            if (entry.connected and entry.instance_number == instance_number) return entry;
        }
        return null;
    }

    pub fn writeRelayHello(registry: *Registry, writer: *std.Io.Writer) !void {
        try writer.print(
            "{{\"kind\":\"relay.hello\",\"product\":\"{s}\",\"buildId\":\"{s}\",\"transportProfile\":\"{s}\",\"protocolVersion\":{d},\"relayEpoch\":\"{s}\"}}",
            .{ config.product, config.build_id, config.profile_id, config.protocol_version, registry.relay_epoch },
        );
    }

    pub fn writeInstancesList(registry: *Registry, writer: *std.Io.Writer) !void {
        registry.mutex.lockUncancelable(registry.io);
        defer registry.mutex.unlock(registry.io);

        try writer.print(
            "{{\"kind\":\"instances.list.result\",\"relayEpoch\":\"{s}\",\"instances\":[",
            .{registry.relay_epoch},
        );
        var first = true;
        for (registry.entries) |entry| {
            if (!entry.ready) continue;
            if (!first) try writer.writeByte(',');
            first = false;
            try writer.print(
                "{{\"relayEpoch\":\"{s}\",\"instanceNumber\":\"{d}\"}}",
                .{ registry.relay_epoch, entry.instance_number },
            );
        }
        try writer.writeAll("]}");
    }
};

test "instance numbers are relay-owned, monotonic, and never reused" {
    var registry = Registry.init(std.testing.io);
    var first_output: [64]u8 = undefined;
    var first_writer: std.Io.Writer = .fixed(&first_output);
    var second_output: [64]u8 = undefined;
    var second_writer: std.Io.Writer = .fixed(&second_output);
    const first = try registry.registerExtension(&first_writer);
    const second = try registry.registerExtension(&second_writer);
    try std.testing.expectEqual(@as(u64, 1), first.instance_number);
    try std.testing.expectEqual(@as(u64, 2), second.instance_number);

    registry.unregisterExtension(first);
    const third = try registry.registerExtension(&first_writer);
    try std.testing.expectEqual(@as(u64, 3), third.instance_number);
}

test "instances list exposes only currently online relay refs" {
    var registry = Registry.init(std.testing.io);
    var first_output: [64]u8 = undefined;
    var first_writer: std.Io.Writer = .fixed(&first_output);
    var second_output: [64]u8 = undefined;
    var second_writer: std.Io.Writer = .fixed(&second_output);
    const first = try registry.registerExtension(&first_writer);
    const second = try registry.registerExtension(&second_writer);
    try registry.activateExtension(first);
    try registry.activateExtension(second);
    registry.unregisterExtension(first);

    var output: [1024]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&output);
    try registry.writeInstancesList(&writer);
    const json = output[0..writer.end];
    try std.testing.expect(std.mem.indexOf(u8, json, "\"instanceNumber\":\"1\"") == null);
    try std.testing.expect(std.mem.indexOf(u8, json, "\"instanceNumber\":\"2\"") != null);
}
