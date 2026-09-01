const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const relay_module = b.createModule(.{
        .root_source_file = b.path("apps/relay/src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    if (target.result.os.tag == .windows) relay_module.linkSystemLibrary("user32", .{});
    const relay = b.addExecutable(.{
        .name = "browser-key-relay",
        .root_module = relay_module,
    });
    b.installArtifact(relay);

    const run_relay = b.addRunArtifact(relay);
    if (b.args) |args| run_relay.addArgs(args);
    const run_step = b.step("run", "Run the local relay executable");
    run_step.dependOn(&run_relay.step);

    const relay_test_module = b.createModule(.{
        .root_source_file = b.path("apps/relay/src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    if (target.result.os.tag == .windows) relay_test_module.linkSystemLibrary("user32", .{});
    const relay_tests = b.addTest(.{ .root_module = relay_test_module });
    const run_relay_tests = b.addRunArtifact(relay_tests);
    const test_step = b.step("test", "Run relay unit tests");
    test_step.dependOn(&run_relay_tests.step);
}
