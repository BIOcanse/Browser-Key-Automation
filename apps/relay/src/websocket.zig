const std = @import("std");

pub const Role = enum {
    extension,
    client,
};

pub const UpgradeProfile = struct {
    host: []const u8,
    extension_path: []const u8,
    client_path: []const u8,
    extension_subprotocol: []const u8,
    client_subprotocol: []const u8,
    expected_extension_origin: []const u8,
};

pub const UpgradeRequest = struct {
    role: Role,
    key: []const u8,
    subprotocol: []const u8,
};

pub const Opcode = enum(u4) {
    binary = 0x2,
    close = 0x8,
    ping = 0x9,
    pong = 0xA,
};

pub const Frame = struct {
    opcode: Opcode,
    payload: []u8,
};

pub const ProtocolError = error{
    BadHttpRequest,
    DuplicateHeader,
    ForbiddenHeader,
    HeaderTooLarge,
    InvalidOrigin,
    InvalidWebSocketKey,
    MissingHeader,
    UnsupportedRole,
    InvalidFrame,
    MessageTooLarge,
    NonCanonicalLength,
    UnmaskedClientFrame,
    UnsupportedFragmentation,
    UnsupportedOpcode,
};

const web_socket_guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

pub fn readHttpHead(reader: *std.Io.Reader, buffer: []u8) ![]u8 {
    var length: usize = 0;
    while (length < buffer.len) {
        buffer[length] = try reader.takeByte();
        length += 1;
        if (length >= 4 and std.mem.eql(u8, buffer[length - 4 .. length], "\r\n\r\n")) {
            return buffer[0..length];
        }
    }
    return error.HeaderTooLarge;
}

pub fn parseUpgradeRequest(head: []const u8, profile: UpgradeProfile) !UpgradeRequest {
    if (head.len < 4 or !std.mem.endsWith(u8, head, "\r\n\r\n")) {
        return error.BadHttpRequest;
    }
    if (containsForbiddenHttpByte(head)) return error.BadHttpRequest;

    var lines = std.mem.splitSequence(u8, head[0 .. head.len - 2], "\r\n");
    const request_line = lines.next() orelse return error.BadHttpRequest;
    var request_parts = std.mem.splitScalar(u8, request_line, ' ');
    const method = request_parts.next() orelse return error.BadHttpRequest;
    const target = request_parts.next() orelse return error.BadHttpRequest;
    const version = request_parts.next() orelse return error.BadHttpRequest;
    if (request_parts.next() != null or !std.mem.eql(u8, method, "GET") or !std.mem.eql(u8, version, "HTTP/1.1")) {
        return error.BadHttpRequest;
    }

    const role: Role = if (std.mem.eql(u8, target, profile.extension_path))
        .extension
    else if (std.mem.eql(u8, target, profile.client_path))
        .client
    else
        return error.UnsupportedRole;

    var host: ?[]const u8 = null;
    var upgrade: ?[]const u8 = null;
    var connection: ?[]const u8 = null;
    var web_socket_version: ?[]const u8 = null;
    var web_socket_key: ?[]const u8 = null;
    var subprotocol: ?[]const u8 = null;
    var origin: ?[]const u8 = null;
    var header_count: usize = 0;

    while (lines.next()) |line| {
        if (line.len == 0) break;
        header_count += 1;
        if (header_count > 64 or line[0] == ' ' or line[0] == '\t') return error.BadHttpRequest;
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse return error.BadHttpRequest;
        const name = line[0..colon];
        const value = std.mem.trim(u8, line[colon + 1 ..], " \t");
        if (!validHeaderName(name) or value.len == 0) return error.BadHttpRequest;

        if (std.ascii.eqlIgnoreCase(name, "Host")) {
            try setOnce(&host, value);
        } else if (std.ascii.eqlIgnoreCase(name, "Upgrade")) {
            try setOnce(&upgrade, value);
        } else if (std.ascii.eqlIgnoreCase(name, "Connection")) {
            try setOnce(&connection, value);
        } else if (std.ascii.eqlIgnoreCase(name, "Sec-WebSocket-Version")) {
            try setOnce(&web_socket_version, value);
        } else if (std.ascii.eqlIgnoreCase(name, "Sec-WebSocket-Key")) {
            try setOnce(&web_socket_key, value);
        } else if (std.ascii.eqlIgnoreCase(name, "Sec-WebSocket-Protocol")) {
            try setOnce(&subprotocol, value);
        } else if (std.ascii.eqlIgnoreCase(name, "Origin")) {
            try setOnce(&origin, value);
        } else if (std.ascii.eqlIgnoreCase(name, "Content-Length") or
            std.ascii.eqlIgnoreCase(name, "Transfer-Encoding"))
        {
            return error.ForbiddenHeader;
        }
    }

    if (!std.mem.eql(u8, host orelse return error.MissingHeader, profile.host)) return error.BadHttpRequest;
    if (!std.ascii.eqlIgnoreCase(upgrade orelse return error.MissingHeader, "websocket")) return error.BadHttpRequest;
    if (!containsAsciiToken(connection orelse return error.MissingHeader, "upgrade")) return error.BadHttpRequest;
    if (!std.mem.eql(u8, web_socket_version orelse return error.MissingHeader, "13")) return error.BadHttpRequest;

    const key = web_socket_key orelse return error.MissingHeader;
    try validateWebSocketKey(key);

    const expected_subprotocol = switch (role) {
        .extension => profile.extension_subprotocol,
        .client => profile.client_subprotocol,
    };
    const actual_subprotocol = subprotocol orelse return error.MissingHeader;
    if (!std.mem.eql(u8, actual_subprotocol, expected_subprotocol)) return error.BadHttpRequest;

    switch (role) {
        .extension => {
            const actual_origin = origin orelse return error.InvalidOrigin;
            if (!std.mem.eql(u8, actual_origin, profile.expected_extension_origin)) return error.InvalidOrigin;
        },
        .client => if (origin != null) return error.InvalidOrigin,
    }

    return .{
        .role = role,
        .key = key,
        .subprotocol = actual_subprotocol,
    };
}

fn setOnce(slot: *?[]const u8, value: []const u8) !void {
    if (slot.* != null) return error.DuplicateHeader;
    slot.* = value;
}

fn containsForbiddenHttpByte(head: []const u8) bool {
    for (head, 0..) |byte, index| {
        if (byte == 0) return true;
        if (byte == '\n' and (index == 0 or head[index - 1] != '\r')) return true;
        if (byte == '\r' and (index + 1 >= head.len or head[index + 1] != '\n')) return true;
        if (byte < 0x20 and byte != '\r' and byte != '\n' and byte != '\t') return true;
        if (byte == 0x7F) return true;
    }
    return false;
}

fn validHeaderName(name: []const u8) bool {
    if (name.len == 0) return false;
    for (name) |byte| {
        const valid = std.ascii.isAlphanumeric(byte) or switch (byte) {
            '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~' => true,
            else => false,
        };
        if (!valid) return false;
    }
    return true;
}

fn containsAsciiToken(value: []const u8, expected: []const u8) bool {
    var tokens = std.mem.splitScalar(u8, value, ',');
    while (tokens.next()) |raw_token| {
        if (std.ascii.eqlIgnoreCase(std.mem.trim(u8, raw_token, " \t"), expected)) return true;
    }
    return false;
}

fn validateWebSocketKey(key: []const u8) !void {
    if (key.len != 24) return error.InvalidWebSocketKey;
    var decoded: [16]u8 = undefined;
    std.base64.standard.Decoder.decode(&decoded, key) catch return error.InvalidWebSocketKey;
}

pub fn computeAccept(key: []const u8) [28]u8 {
    var hash = std.crypto.hash.Sha1.init(.{});
    hash.update(key);
    hash.update(web_socket_guid);
    var digest: [std.crypto.hash.Sha1.digest_length]u8 = undefined;
    hash.final(&digest);
    var encoded: [28]u8 = undefined;
    _ = std.base64.standard.Encoder.encode(&encoded, &digest);
    return encoded;
}

pub fn writeUpgradeResponse(writer: *std.Io.Writer, key: []const u8, subprotocol: []const u8) !void {
    const accept = computeAccept(key);
    try writer.writeAll("HTTP/1.1 101 Switching Protocols\r\n");
    try writer.writeAll("Upgrade: websocket\r\n");
    try writer.writeAll("Connection: Upgrade\r\n");
    try writer.writeAll("Sec-WebSocket-Accept: ");
    try writer.writeAll(&accept);
    try writer.writeAll("\r\nSec-WebSocket-Protocol: ");
    try writer.writeAll(subprotocol);
    try writer.writeAll("\r\n\r\n");
    try writer.flush();
}

pub fn readClientFrame(reader: *std.Io.Reader, payload_buffer: []u8) !Frame {
    const first = try reader.takeByte();
    const second = try reader.takeByte();
    if ((first & 0x70) != 0) return error.InvalidFrame;
    if ((first & 0x80) == 0) return error.UnsupportedFragmentation;
    if ((second & 0x80) == 0) return error.UnmaskedClientFrame;

    const opcode_raw: u4 = @truncate(first & 0x0F);
    const opcode: Opcode = switch (opcode_raw) {
        0x2 => .binary,
        0x8 => .close,
        0x9 => .ping,
        0xA => .pong,
        else => return error.UnsupportedOpcode,
    };

    const short_length = second & 0x7F;
    const payload_length_u64: u64 = switch (short_length) {
        0...125 => short_length,
        126 => length: {
            var bytes: [2]u8 = undefined;
            try reader.readSliceAll(&bytes);
            const value = std.mem.readInt(u16, &bytes, .big);
            if (value < 126) return error.NonCanonicalLength;
            break :length value;
        },
        127 => length: {
            var bytes: [8]u8 = undefined;
            try reader.readSliceAll(&bytes);
            if ((bytes[0] & 0x80) != 0) return error.InvalidFrame;
            const value = std.mem.readInt(u64, &bytes, .big);
            if (value <= 65535) return error.NonCanonicalLength;
            break :length value;
        },
        else => unreachable,
    };

    if ((opcode == .close or opcode == .ping or opcode == .pong) and payload_length_u64 > 125) {
        return error.InvalidFrame;
    }
    if (payload_length_u64 > payload_buffer.len) return error.MessageTooLarge;
    const payload_length: usize = @intCast(payload_length_u64);

    var mask: [4]u8 = undefined;
    try reader.readSliceAll(&mask);
    const payload = payload_buffer[0..payload_length];
    try reader.readSliceAll(payload);
    for (payload, 0..) |*byte, index| byte.* ^= mask[index & 3];

    return .{ .opcode = opcode, .payload = payload };
}

pub fn writeServerFrame(writer: *std.Io.Writer, opcode: Opcode, payload: []const u8) !void {
    if ((opcode == .close or opcode == .ping or opcode == .pong) and payload.len > 125) {
        return error.InvalidFrame;
    }
    try writer.writeByte(@as(u8, 0x80) | @as(u8, @intFromEnum(opcode)));
    if (payload.len <= 125) {
        try writer.writeByte(@intCast(payload.len));
    } else if (payload.len <= 65535) {
        try writer.writeByte(126);
        try writer.writeInt(u16, @intCast(payload.len), .big);
    } else {
        try writer.writeByte(127);
        try writer.writeInt(u64, @intCast(payload.len), .big);
    }
    try writer.writeAll(payload);
    try writer.flush();
}

test "RFC 6455 accept example" {
    const accept = computeAccept("dGhlIHNhbXBsZSBub25jZQ==");
    try std.testing.expectEqualStrings("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", &accept);
}

test "upgrade parser separates extension and native roles" {
    const profile: UpgradeProfile = .{
        .host = "127.0.0.1:32189",
        .extension_path = "/v1/extension",
        .client_path = "/v1/client",
        .extension_subprotocol = "browser-key-extension-v1",
        .client_subprotocol = "browser-key-client-v1",
        .expected_extension_origin = "chrome-extension://dbbbehdkedibhielmkaoohbeebnbfjbo",
    };
    const extension_request =
        "GET /v1/extension HTTP/1.1\r\n" ++
        "Host: 127.0.0.1:32189\r\n" ++
        "Upgrade: websocket\r\n" ++
        "Connection: keep-alive, Upgrade\r\n" ++
        "Sec-WebSocket-Version: 13\r\n" ++
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" ++
        "Sec-WebSocket-Protocol: browser-key-extension-v1\r\n" ++
        "Origin: chrome-extension://dbbbehdkedibhielmkaoohbeebnbfjbo\r\n\r\n";
    const parsed_extension = try parseUpgradeRequest(extension_request, profile);
    try std.testing.expectEqual(Role.extension, parsed_extension.role);

    const wrong_extension_origin =
        "GET /v1/extension HTTP/1.1\r\n" ++
        "Host: 127.0.0.1:32189\r\n" ++
        "Upgrade: websocket\r\n" ++
        "Connection: Upgrade\r\n" ++
        "Sec-WebSocket-Version: 13\r\n" ++
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" ++
        "Sec-WebSocket-Protocol: browser-key-extension-v1\r\n" ++
        "Origin: chrome-extension://abcdefghijklmnopabcdefghijklmnop\r\n\r\n";
    try std.testing.expectError(error.InvalidOrigin, parseUpgradeRequest(wrong_extension_origin, profile));

    const client_request =
        "GET /v1/client HTTP/1.1\r\n" ++
        "Host: 127.0.0.1:32189\r\n" ++
        "Upgrade: websocket\r\n" ++
        "Connection: Upgrade\r\n" ++
        "Sec-WebSocket-Version: 13\r\n" ++
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" ++
        "Sec-WebSocket-Protocol: browser-key-client-v1\r\n\r\n";
    const parsed_client = try parseUpgradeRequest(client_request, profile);
    try std.testing.expectEqual(Role.client, parsed_client.role);
}

test "upgrade parser rejects duplicate singleton and web origin on client path" {
    const profile: UpgradeProfile = .{
        .host = "127.0.0.1:32189",
        .extension_path = "/v1/extension",
        .client_path = "/v1/client",
        .extension_subprotocol = "browser-key-extension-v1",
        .client_subprotocol = "browser-key-client-v1",
        .expected_extension_origin = "chrome-extension://dbbbehdkedibhielmkaoohbeebnbfjbo",
    };
    const duplicate =
        "GET /v1/client HTTP/1.1\r\n" ++
        "Host: 127.0.0.1:32189\r\n" ++
        "Host: 127.0.0.1:32189\r\n" ++
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" ++
        "Sec-WebSocket-Version: 13\r\n" ++
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" ++
        "Sec-WebSocket-Protocol: browser-key-client-v1\r\n\r\n";
    try std.testing.expectError(error.DuplicateHeader, parseUpgradeRequest(duplicate, profile));

    const browser_origin =
        "GET /v1/client HTTP/1.1\r\n" ++
        "Host: 127.0.0.1:32189\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" ++
        "Sec-WebSocket-Version: 13\r\n" ++
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" ++
        "Sec-WebSocket-Protocol: browser-key-client-v1\r\n" ++
        "Origin: https://example.test\r\n\r\n";
    try std.testing.expectError(error.InvalidOrigin, parseUpgradeRequest(browser_origin, profile));
}

test "masked binary frame is decoded and non-canonical length is rejected" {
    const masked = [_]u8{ 0x82, 0x82, 0x01, 0x02, 0x03, 0x04, 'h' ^ 0x01, 'i' ^ 0x02 };
    var reader: std.Io.Reader = .fixed(&masked);
    var payload_buffer: [16]u8 = undefined;
    const frame = try readClientFrame(&reader, &payload_buffer);
    try std.testing.expectEqual(Opcode.binary, frame.opcode);
    try std.testing.expectEqualStrings("hi", frame.payload);

    const non_canonical = [_]u8{ 0x82, 0xFE, 0x00, 0x7D, 0, 0, 0, 0 };
    var bad_reader: std.Io.Reader = .fixed(&non_canonical);
    try std.testing.expectError(error.NonCanonicalLength, readClientFrame(&bad_reader, &payload_buffer));
}

test "server frames are unmasked and use canonical lengths" {
    var output: [256]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&output);
    try writeServerFrame(&writer, .binary, "hello");
    try std.testing.expectEqualSlices(u8, &.{ 0x82, 0x05 }, output[0..2]);
    try std.testing.expectEqualStrings("hello", output[2..7]);
}
