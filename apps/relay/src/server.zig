const std = @import("std");
const builtin = @import("builtin");
const net = std.Io.net;
const config = @import("generated_config.zig");
const registry_module = @import("registry.zig");
const route_table_module = @import("route_table.zig");
const websocket = @import("websocket.zig");
const native_input = @import("native_input.zig");

const role_hello_extension = "{\"kind\":\"role.hello\",\"role\":\"extension\",\"protocolVersion\":1}";
const role_hello_client = "{\"kind\":\"role.hello\",\"role\":\"client\",\"protocolVersion\":1}";
const role_ready_extension = if (builtin.os.tag == .windows)
    "{\"kind\":\"role.ready\",\"role\":\"extension\",\"capabilities\":[\"" ++ config.native_input_click_capability ++ "\",\"" ++ config.native_input_keyboard_capability ++ "\"]}"
else
    "{\"kind\":\"role.ready\",\"role\":\"extension\",\"capabilities\":[]}";
const role_ready_client = "{\"kind\":\"role.ready\",\"role\":\"client\"}";
const instances_list = "{\"kind\":\"instances.list\"}";
const relay_stop = "{\"kind\":\"relay.stop\"}";
const relay_stopping = "{\"kind\":\"relay.stopping\"}";
const unsupported_message = "{\"kind\":\"transport.error\",\"error\":\"UNSUPPORTED_MESSAGE\"}";
const stale_instance = "{\"kind\":\"transport.error\",\"error\":\"STALE_INSTANCE\"}";
const extension_disconnected = "{\"kind\":\"transport.error\",\"error\":\"EXTENSION_DISCONNECTED\"}";

const TargetInstance = struct {
    relayEpoch: []const u8,
    instanceNumber: []const u8,
};

const ForwardRequest = struct {
    kind: []const u8,
    clientRequestId: []const u8,
    targetInstance: TargetInstance,
    auth: struct { apiKey: []const u8 },
    command: std.json.Value,
};

const RouteResponse = struct {
    kind: []const u8,
    routeId: []const u8,
    payload: std.json.Value,
};

const NativeClickMessage = struct {
    kind: []const u8,
    requestId: []const u8,
    routeId: []const u8,
    timeoutMs: u32,
    marker: []const u8,
    point: native_input.Point,
    viewport: native_input.Viewport,
};

const NativeKeyboardMessage = struct {
    kind: []const u8,
    requestId: []const u8,
    routeId: []const u8,
    timeoutMs: u32,
    marker: ?[]const u8,
    operation: native_input.KeyboardOperation,
};

const ServerState = struct {
    io: std.Io,
    allocator: std.mem.Allocator,
    running: std.atomic.Value(bool) = .init(true),
    registry: registry_module.Registry,
    routes: route_table_module.RouteTable,

    fn requestStop(state: *ServerState) void {
        if (!state.running.swap(false, .acq_rel)) return;
        // Zig 0.16's Windows threaded I/O treats closing a socket during accept as
        // unreachable. A loopback self-connect wakes accept; only the main task
        // closes the listener after it observes the stop flag.
        const address = net.IpAddress.parse(config.loopback_host, config.loopback_port) catch return;
        const wake_stream = address.connect(state.io, .{ .mode = .stream, .protocol = .tcp }) catch return;
        wake_stream.close(state.io);
    }
};

pub fn run(io: std.Io, allocator: std.mem.Allocator) !void {
    const address = try net.IpAddress.parse(config.loopback_host, config.loopback_port);
    var listener = try address.listen(io, .{});
    defer listener.deinit(io);
    var state: ServerState = .{
        .io = io,
        .allocator = allocator,
        .registry = .init(io),
        .routes = .init(io, allocator),
    };

    std.log.info(
        "relay listening on ws://{s}:{d} profile={s} relayEpoch={s}",
        .{ config.loopback_host, config.loopback_port, config.profile_id, state.registry.relay_epoch },
    );

    var connections: std.Io.Group = .init;
    defer connections.cancel(io);

    while (state.running.load(.acquire)) {
        const stream = listener.accept(io) catch |err| {
            if (!state.running.load(.acquire)) break;
            return err;
        };
        if (!state.running.load(.acquire)) {
            stream.close(io);
            break;
        }
        connections.concurrent(io, handleConnection, .{ &state, stream }) catch |err| {
            stream.close(io);
            std.log.warn("relay connection capacity reached: {t}", .{err});
        };
    }
}

fn handleConnection(state: *ServerState, stream: net.Stream) void {
    defer stream.close(state.io);
    serveConnection(state, stream) catch |err| switch (err) {
        error.EndOfStream, error.ReadFailed, error.WriteFailed => {},
        else => std.log.warn("relay rejected connection: {t}", .{err}),
    };
}

fn serveConnection(state: *ServerState, stream: net.Stream) !void {
    var read_buffer: [4096]u8 = undefined;
    var write_buffer: [4096]u8 = undefined;
    var http_head: [config.maximum_http_head_bytes]u8 = undefined;
    var message_buffer: [config.maximum_message_bytes]u8 = undefined;
    var stream_reader = stream.reader(state.io, &read_buffer);
    var stream_writer = stream.writer(state.io, &write_buffer);
    const reader = &stream_reader.interface;
    const writer = &stream_writer.interface;

    const head = try websocket.readHttpHead(reader, &http_head);
    var expected_host_buffer: [64]u8 = undefined;
    const expected_host = try std.fmt.bufPrint(
        &expected_host_buffer,
        "{s}:{d}",
        .{ config.loopback_host, config.loopback_port },
    );
    const upgrade = try websocket.parseUpgradeRequest(head, .{
        .host = expected_host,
        .extension_path = config.extension_path,
        .client_path = config.client_path,
        .extension_subprotocol = config.extension_subprotocol,
        .client_subprotocol = config.client_subprotocol,
        .expected_extension_origin = config.expected_extension_origin,
    });
    try websocket.writeUpgradeResponse(writer, upgrade.key, upgrade.subprotocol);

    var hello_buffer: [512]u8 = undefined;
    var hello_writer: std.Io.Writer = .fixed(&hello_buffer);
    try state.registry.writeRelayHello(&hello_writer);
    try websocket.writeServerFrame(writer, .binary, hello_buffer[0..hello_writer.end]);

    const role_payload = (try readApplicationMessage(reader, writer, &message_buffer)) orelse return;
    switch (upgrade.role) {
        .extension => {
            if (!std.mem.eql(u8, role_payload, role_hello_extension)) return error.BadRoleHello;
            try serveExtension(state, reader, writer, &message_buffer);
        },
        .client => {
            if (!std.mem.eql(u8, role_payload, role_hello_client)) return error.BadRoleHello;
            try serveClient(state, reader, writer, &message_buffer);
        },
    }
}

fn serveExtension(
    state: *ServerState,
    reader: *std.Io.Reader,
    writer: *std.Io.Writer,
    message_buffer: []u8,
) !void {
    const instance_ref = try state.registry.registerExtension(writer);
    defer {
        // Retire the writer before the final scan: every successful write must
        // already have created its route, and no new write may escape the scan.
        state.registry.unregisterExtension(instance_ref);
        state.routes.failInstance(instance_ref.instance_number);
        native_input.cleanupInstance(state.io, instance_ref.instance_number);
    }

    // The extension receives no instanceNumber; hello's relayEpoch is not a route identity it owns.
    try state.registry.writeToConnected(instance_ref, .binary, role_ready_extension);
    try state.registry.activateExtension(instance_ref);
    while (true) {
        const payload = (try readExtensionApplicationMessage(
            state,
            instance_ref,
            reader,
            message_buffer,
        )) orelse return;
        var value = try std.json.parseFromSlice(std.json.Value, state.allocator, payload, .{});
        defer value.deinit();
        const object = switch (value.value) {
            .object => |object| object,
            else => return error.BadExtensionMessage,
        };
        const kind_value = object.get("kind") orelse return error.BadExtensionMessage;
        const kind = switch (kind_value) {
            .string => |string| string,
            else => return error.BadExtensionMessage,
        };
        if (std.mem.eql(u8, kind, "route.response")) {
            var parsed = try std.json.parseFromSlice(RouteResponse, state.allocator, payload, .{});
            defer parsed.deinit();
            const route_id = try std.fmt.parseUnsigned(u64, parsed.value.routeId, 10);
            try state.routes.complete(route_id, payload);
        } else if (std.mem.eql(u8, kind, "native.input.click")) {
            try serveNativeClick(state, instance_ref, payload);
        } else if (std.mem.eql(u8, kind, "native.input.keyboard")) {
            try serveNativeKeyboard(state, instance_ref, payload);
        } else return error.BadExtensionMessage;
    }
}

fn serveNativeClick(state: *ServerState, instance_ref: registry_module.InstanceRef, payload: []const u8) !void {
    var parsed = try std.json.parseFromSlice(NativeClickMessage, state.allocator, payload, .{});
    defer parsed.deinit();
    const request = &parsed.value;
    const route_id = std.fmt.parseUnsigned(u64, request.routeId, 10) catch 0;
    const outcome: native_input.ClickOutcome = if (route_id == 0 or
        !state.routes.isPendingForInstance(route_id, instance_ref.instance_number))
        .{ .failure = .{ .reason = "stale_route", .phase = .prepare, .click_state = .not_sent } }
    else
        native_input.executeClick(state.io, .{
            .marker = request.marker,
            .point = request.point,
            .viewport = request.viewport,
            .timeout_ms = request.timeoutMs,
        });

    var response_buffer: [2048]u8 = undefined;
    var response: std.Io.Writer = .fixed(&response_buffer);
    try response.writeAll("{\"kind\":\"native.input.result\",\"requestId\":");
    try std.json.Stringify.value(request.requestId, .{}, &response);
    switch (outcome) {
        .input_sent => try response.writeAll(",\"ok\":true,\"result\":{\"status\":\"input_sent\"}}"),
        .failure => |failure| {
            try response.writeAll(",\"ok\":false,\"error\":{\"reason\":");
            try std.json.Stringify.value(failure.reason, .{}, &response);
            try response.print(",\"phase\":\"{s}\",\"clickState\":\"{s}\"}}}}", .{
                @tagName(failure.phase), @tagName(failure.click_state),
            });
        },
    }
    try state.registry.writeToConnected(instance_ref, .binary, response_buffer[0..response.end]);
}

fn serveNativeKeyboard(state: *ServerState, instance_ref: registry_module.InstanceRef, payload: []const u8) !void {
    var parsed = try std.json.parseFromSlice(NativeKeyboardMessage, state.allocator, payload, .{});
    defer parsed.deinit();
    const request = &parsed.value;
    const route_id = std.fmt.parseUnsigned(u64, request.routeId, 10) catch 0;
    const outcome: native_input.KeyboardOutcome = if (route_id == 0 or
        !state.routes.isPendingForInstance(route_id, instance_ref.instance_number))
        .{ .failure = .{
            .reason = "stale_route",
            .phase = .prepare,
            .input_state = .not_sent,
            .completed_actions = 0,
        } }
    else
        native_input.executeKeyboard(state.io, instance_ref.instance_number, .{
            .marker = request.marker,
            .operation = request.operation,
            .timeout_ms = request.timeoutMs,
        });

    var response_buffer: [4096]u8 = undefined;
    var response: std.Io.Writer = .fixed(&response_buffer);
    try response.writeAll("{\"kind\":\"native.keyboard.result\",\"requestId\":");
    try std.json.Stringify.value(request.requestId, .{}, &response);
    switch (outcome) {
        .success => |result| {
            try response.print(
                ",\"ok\":true,\"result\":{{\"status\":\"input_sent\",\"completedActions\":{d},\"submittedScalars\":{d},\"correctedMistakes\":{d},\"heldVirtualKeys\":[",
                .{ result.completed_actions, result.submitted_scalars, result.corrected_mistakes },
            );
            var index: usize = 0;
            while (index < result.held_count) : (index += 1) {
                if (index != 0) try response.writeByte(',');
                try response.print("{d}", .{result.held_virtual_keys[index]});
            }
            try response.writeAll("]}}");
        },
        .failure => |failure| {
            try response.writeAll(",\"ok\":false,\"error\":{\"reason\":");
            try std.json.Stringify.value(failure.reason, .{}, &response);
            try response.print(",\"phase\":\"{s}\",\"inputState\":\"{s}\",\"completedActions\":{d}}}}}", .{
                @tagName(failure.phase), @tagName(failure.input_state), failure.completed_actions,
            });
        },
    }
    try state.registry.writeToConnected(instance_ref, .binary, response_buffer[0..response.end]);
}

fn serveClient(
    state: *ServerState,
    reader: *std.Io.Reader,
    writer: *std.Io.Writer,
    message_buffer: []u8,
) !void {
    try websocket.writeServerFrame(writer, .binary, role_ready_client);
    while (true) {
        const payload = (try readApplicationMessage(reader, writer, message_buffer)) orelse return;
        if (std.mem.eql(u8, payload, instances_list)) {
            var response_buffer: [8192]u8 = undefined;
            var response_writer: std.Io.Writer = .fixed(&response_buffer);
            try state.registry.writeInstancesList(&response_writer);
            try websocket.writeServerFrame(writer, .binary, response_buffer[0..response_writer.end]);
        } else if (std.mem.eql(u8, payload, relay_stop)) {
            try websocket.writeServerFrame(writer, .binary, relay_stopping);
            state.requestStop();
            return;
        } else if (std.mem.indexOf(u8, payload, "\"kind\":\"forward\"") != null) {
            serveForward(state, writer, payload) catch |err| switch (err) {
                error.StaleInstance => try websocket.writeServerFrame(writer, .binary, stale_instance),
                error.ExtensionDisconnected => try websocket.writeServerFrame(writer, .binary, extension_disconnected),
                else => try websocket.writeServerFrame(writer, .binary, unsupported_message),
            };
        } else {
            try websocket.writeServerFrame(writer, .binary, unsupported_message);
        }
    }
}

fn serveForward(state: *ServerState, client_writer: *std.Io.Writer, payload: []const u8) !void {
    var parsed = try std.json.parseFromSlice(ForwardRequest, state.allocator, payload, .{});
    defer parsed.deinit();
    const request = &parsed.value;
    if (!std.mem.eql(u8, request.kind, "forward") or request.clientRequestId.len == 0) {
        return error.InvalidForwardRequest;
    }
    const instance_number = try std.fmt.parseUnsigned(u64, request.targetInstance.instanceNumber, 10);
    if (instance_number == 0) return error.InvalidForwardRequest;

    const route = try state.routes.create(instance_number);
    defer state.routes.destroy(route);

    var extension_message_buffer: [config.maximum_message_bytes]u8 = undefined;
    var extension_message_writer: std.Io.Writer = .fixed(&extension_message_buffer);
    try extension_message_writer.print(
        "{{\"kind\":\"route.request\",\"routeId\":\"{d}\",\"payload\":{{\"clientRequestId\":",
        .{route.id},
    );
    try std.json.Stringify.value(request.clientRequestId, .{}, &extension_message_writer);
    try extension_message_writer.writeAll(",\"auth\":{\"apiKey\":");
    try std.json.Stringify.value(request.auth.apiKey, .{}, &extension_message_writer);
    try extension_message_writer.writeAll("},\"command\":");
    try std.json.Stringify.value(request.command, .{}, &extension_message_writer);
    try extension_message_writer.writeAll("}}");

    state.registry.writeToReady(
        request.targetInstance.relayEpoch,
        instance_number,
        .binary,
        extension_message_buffer[0..extension_message_writer.end],
    ) catch return error.StaleInstance;

    try route.event.wait(state.io);
    switch (route.status) {
        .completed => try websocket.writeServerFrame(
            client_writer,
            .binary,
            route.response[0..route.response_length],
        ),
        .extension_disconnected => return error.ExtensionDisconnected,
        .pending => unreachable,
    }
}

fn readExtensionApplicationMessage(
    state: *ServerState,
    instance_ref: registry_module.InstanceRef,
    reader: *std.Io.Reader,
    message_buffer: []u8,
) !?[]u8 {
    while (true) {
        const frame = try websocket.readClientFrame(reader, message_buffer);
        switch (frame.opcode) {
            .binary => {
                if (!std.unicode.utf8ValidateSlice(frame.payload)) return error.InvalidUtf8;
                return frame.payload;
            },
            .ping => try state.registry.writeToConnected(instance_ref, .pong, frame.payload),
            .pong => {},
            .close => {
                try state.registry.writeToConnected(instance_ref, .close, frame.payload);
                return null;
            },
        }
    }
}

fn readApplicationMessage(
    reader: *std.Io.Reader,
    writer: *std.Io.Writer,
    message_buffer: []u8,
) !?[]u8 {
    while (true) {
        const frame = try websocket.readClientFrame(reader, message_buffer);
        switch (frame.opcode) {
            .binary => {
                if (!std.unicode.utf8ValidateSlice(frame.payload)) return error.InvalidUtf8;
                return frame.payload;
            },
            .ping => try websocket.writeServerFrame(writer, .pong, frame.payload),
            .pong => {},
            .close => {
                try websocket.writeServerFrame(writer, .close, frame.payload);
                return null;
            },
        }
    }
}

test "role hello constants contain no instance identity" {
    try std.testing.expect(std.mem.indexOf(u8, role_ready_extension, "instanceNumber") == null);
    try std.testing.expect(std.mem.indexOf(u8, role_ready_extension, "relayEpoch") == null);
}

test "native input capabilities are advertised only by the implemented platform build" {
    if (builtin.os.tag == .windows) {
        try std.testing.expect(std.mem.indexOf(u8, role_ready_extension, config.native_input_click_capability) != null);
        try std.testing.expect(std.mem.indexOf(u8, role_ready_extension, config.native_input_keyboard_capability) != null);
    } else {
        try std.testing.expect(std.mem.indexOf(u8, role_ready_extension, config.native_input_click_capability) == null);
        try std.testing.expect(std.mem.indexOf(u8, role_ready_extension, config.native_input_keyboard_capability) == null);
    }
}
