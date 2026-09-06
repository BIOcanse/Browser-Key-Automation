# MinHook

Unmodified runtime sources and header from https://github.com/TsudaKageyu/minhook

- Version: v1.3.4
- Commit: c3fcafdc10146beb5919319d0683e44e3c30d537
- License: BSD-2-Clause; bundled HDE notices are retained in LICENSE.txt.
- Used by the Windows virtual-mouse hook DLL. No network download at runtime.

The client, pointer model, target scope and cleanup policy are Browser Key Automation code, not MinHook guarantees.

Build note: the upstream x86/x64 instruction decoder intentionally reads unaligned instruction bytes. Only these vendor translation units disable Clang's alignment sanitizer; first-party code retains the selected Zig build checks. This avoids a verified Zig 0.16 Debug alignment trap without editing the upstream decoder.
