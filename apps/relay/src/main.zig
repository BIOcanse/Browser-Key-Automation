const std = @import("std");
const server = @import("server.zig");
const websocket = @import("websocket.zig");
const registry = @import("registry.zig");
const route_table = @import("route_table.zig");
const native_input = @import("native_input.zig");

const product_name = "browser-key-relay";
const product_version = "0.1.0-p0";

pub fn main(init: std.process.Init) !void {
    std.debug.print("{s} {s}\n", .{ product_name, product_version });
    try server.run(init.io, init.gpa);
}

test "product identity is explicit" {
    try std.testing.expectEqualStrings("browser-key-relay", product_name);
    try std.testing.expectEqualStrings("0.1.0-p0", product_version);
}

comptime {
    _ = websocket;
    _ = registry;
    _ = route_table;
    _ = native_input;
}
