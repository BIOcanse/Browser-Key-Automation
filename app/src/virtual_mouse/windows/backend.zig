const core = @import("../core.zig");

const Client = opaque {};
extern fn vm_open(hwnd: usize, timeout_ms: u32, output: *?*Client) c_int;
extern fn vm_intercept(client: *Client, enabled: c_int) c_int;
extern fn vm_event(client: *Client, kind: u32, x: i32, y: i32, buttons: u32, button: u32, dx: i32, dy: i32) c_int;
extern fn vm_alive(client: *Client) c_int;
extern fn vm_is_intercepting(client: *Client) c_int;
extern fn vm_close(client: *Client) void;
extern fn vm_begin(client: *Client, timeout_ms: u32) void;
extern fn vm_bounds(client: *Client, width: *i32, height: *i32) void;
extern fn vm_context(client: *Client, keys: *const [256]u8, source_tag: usize, x: i32, y: i32, buttons: u32) c_int;
extern fn vm_key_event(client: *Client, vk: u32, extended: c_int, down: c_int) c_int;
extern fn vm_detach(client: *Client) c_int;

pub const Error = error{ InvalidInput, TargetLost, TargetConflict, HookFailed, InputTimeout, DeliveryFailed };
fn checked(code: c_int) Error!void {
    return switch (code) {
        0 => {},
        1 => error.InvalidInput,
        2 => error.TargetLost,
        3 => error.TargetConflict,
        4 => error.HookFailed,
        5 => error.InputTimeout,
        else => error.DeliveryFailed,
    };
}

pub const Mouse = struct {
    pub const Bounds = struct { width: i32, height: i32 };
    client: *Client,

    pub fn open(hwnd: usize, timeout_ms: u32) Error!Mouse {
        var client: ?*Client = null;
        try checked(vm_open(hwnd, timeout_ms, &client));
        return .{ .client = client orelse return error.HookFailed };
    }
    pub fn alive(self: Mouse) bool {
        return vm_alive(self.client) != 0;
    }
    pub fn begin(self: Mouse, timeout_ms: u32) void { vm_begin(self.client, timeout_ms); }
    pub fn context(self: Mouse, keys: *const [256]u8, source_tag: usize, pointer: core.State) Error!void {
        try checked(vm_context(self.client, keys, source_tag, pointer.point.x, pointer.point.y, pointer.buttons));
    }
    pub fn key(self: Mouse, vk: u16, extended: bool, down: bool) Error!void { try checked(vm_key_event(self.client, vk, @intFromBool(extended), @intFromBool(down))); }
    pub fn detach(self: Mouse) Error!void { try checked(vm_detach(self.client)); }
    pub fn bounds(self: Mouse) Bounds {
        var size: Bounds = undefined;
        vm_bounds(self.client, &size.width, &size.height);
        return size;
    }
    pub fn intercept(self: Mouse, enabled: bool) Error!void {
        try checked(vm_intercept(self.client, @intFromBool(enabled)));
    }
    pub fn intercepting(self: Mouse) bool {
        return vm_is_intercepting(self.client) != 0;
    }
    pub fn send(self: Mouse, event: core.Event) Error!void {
        const kind: u32 = switch (event.kind) { .move => 1, .down => 2, .up => 3, .wheel => 4 };
        try checked(vm_event(self.client, kind, event.state.point.x, event.state.point.y,
            event.state.buttons, if (event.button) |button| button.mask() else 0, event.delta_x, event.delta_y));
    }
    pub fn close(self: Mouse) void {
        vm_close(self.client);
    }
};
