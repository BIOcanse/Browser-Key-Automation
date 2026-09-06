const std = @import("std");

fn addVirtualMouseClient(b: *std.Build, module: *std.Build.Module) void {
    module.link_libc = true;
    module.addCSourceFile(.{ .file = b.path("src/virtual_mouse/windows/client.c"), .flags = &.{"-std=c11"} });
    module.addIncludePath(b.path("src/virtual_mouse/windows"));
}

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const InputDiagnostic = enum { off, observe, queue, projection, settled };
    const input_diagnostic = b.option(InputDiagnostic, "virtual-input-diagnostics", "Disposable OLE experiment; release builds use off") orelse .off;
    const input_diagnostics = input_diagnostic != .off;

    const relay_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    if (target.result.os.tag == .windows) {
        relay_module.linkSystemLibrary("user32", .{});
        if (target.result.cpu.arch == .x86_64) addVirtualMouseClient(b, relay_module);
    }
    const relay = b.addExecutable(.{
        .name = "browser-key-relay",
        .root_module = relay_module,
    });
    b.installArtifact(relay);

    if (target.result.os.tag == .windows and target.result.cpu.arch == .x86_64) {
        const hook_module = b.createModule(.{ .target = target, .optimize = optimize, .link_libc = true });
        if (input_diagnostic == .queue or input_diagnostic == .projection or input_diagnostic == .settled) hook_module.addCMacro("BKA_VM_QUEUE_PROBE", "1");
        if (input_diagnostic == .projection or input_diagnostic == .settled) hook_module.addCMacro("BKA_VM_PROJECTION_PROBE", "1");
        if (input_diagnostic == .settled) hook_module.addCMacro("BKA_VM_DELAYED_RELEASE_PROBE", "1");
        hook_module.addCSourceFile(.{ .file = b.path(if (input_diagnostics) "../dev/tests/experiments/virtual-mouse/ole-diagnostic.c" else "src/virtual_mouse/windows/hook.c"), .flags = &.{ "-std=c11", "-Werror=unknown-attributes" } });
        if (input_diagnostics) hook_module.linkSystemLibrary("uuid", .{});
        hook_module.addCSourceFiles(.{ .files = &.{
            "third_party/minhook/src/buffer.c", "third_party/minhook/src/hook.c",
            "third_party/minhook/src/trampoline.c", "third_party/minhook/src/hde/hde64.c",
        }, .flags = &.{ "-std=c11", "-fno-sanitize=alignment" } });
        hook_module.addIncludePath(b.path("src/virtual_mouse/windows"));
        hook_module.addIncludePath(b.path("third_party/minhook/include"));
        hook_module.linkSystemLibrary("user32", .{});
        hook_module.linkSystemLibrary("comctl32", .{});
        const hook = b.addLibrary(.{ .name = "virtual-mouse-hook", .linkage = .dynamic, .root_module = hook_module });
        b.installArtifact(hook);

        const probe_module = b.createModule(.{ .target = target, .optimize = optimize, .link_libc = true });
        addVirtualMouseClient(b, probe_module);
        probe_module.addCSourceFile(.{ .file = b.path("../dev/tests/experiments/virtual-mouse/native-probe.c"), .flags = &.{"-std=c11"} });
        probe_module.linkSystemLibrary("user32", .{});
        const probe = b.addExecutable(.{ .name = "virtual-mouse-probe", .root_module = probe_module });
        const install_probe = b.addInstallArtifact(probe, .{});
        const probe_step = b.step("virtual-mouse-probe", "Build the disposable virtual-mouse probe and hook");
        probe_step.dependOn(&install_probe.step);
        probe_step.dependOn(&b.addInstallArtifact(hook, .{}).step);

        const root_probe_module = b.createModule(.{ .target = target, .optimize = optimize, .link_libc = true });
        addVirtualMouseClient(b, root_probe_module);
        root_probe_module.addCSourceFile(.{ .file = b.path("../dev/tests/experiments/virtual-mouse/occluded-root-probe.c"), .flags = &.{"-std=c11"} });
        root_probe_module.linkSystemLibrary("user32", .{});
        root_probe_module.linkSystemLibrary("ole32", .{});
        root_probe_module.linkSystemLibrary("oleacc", .{});
        root_probe_module.linkSystemLibrary("oleaut32", .{});
        root_probe_module.linkSystemLibrary("uuid", .{});
        const root_probe = b.addExecutable(.{ .name = "occluded-root-probe", .root_module = root_probe_module });
        const root_probe_step = b.step("occluded-root-probe", "Build the isolated calibrated root-window experiment");
        root_probe_step.dependOn(&b.addInstallArtifact(root_probe, .{}).step);
        root_probe_step.dependOn(&b.addInstallArtifact(hook, .{}).step);
    }

    const run_relay = b.addRunArtifact(relay);
    if (b.args) |args| run_relay.addArgs(args);
    const run_step = b.step("run", "Run the local relay executable");
    run_step.dependOn(&run_relay.step);

    const relay_test_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    if (target.result.os.tag == .windows) {
        relay_test_module.linkSystemLibrary("user32", .{});
        if (target.result.cpu.arch == .x86_64) addVirtualMouseClient(b, relay_test_module);
    }
    const relay_tests = b.addTest(.{ .root_module = relay_test_module });
    const run_relay_tests = b.addRunArtifact(relay_tests);
    const test_step = b.step("test", "Run relay unit tests");
    test_step.dependOn(&run_relay_tests.step);
}
