// Read-only, bounded x64 minidump inspection. Layouts: Windows MINIDUMP_* in
// minidumpapiset.h. Stack words below are candidates, NOT an unwound call stack.
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const file = process.argv[2];
assert.ok(file, "Usage: node inspect-native-minidump.mjs <dump.dmp>");
assert.ok((await stat(file)).size <= 512 * 1024 * 1024, "Use a full debugger for larger dumps");
const data = await readFile(file);
const u32 = (offset) => data.readUInt32LE(offset);
const u64 = (offset) => data.readBigUInt64LE(offset);
const hex = (value) => `0x${value.toString(16)}`;
assert.equal(u32(0), 0x504d444d);
const streams = new Map();
const directory = u32(12), count = u32(8);
assert.ok(count <= 128);
for (let index = 0; index < count; index++) {
  const offset = directory + index * 12;
  streams.set(u32(offset), { size: u32(offset + 4), offset: u32(offset + 8) });
}
const modules = [];
const moduleList = streams.get(4).offset;
assert.ok(u32(moduleList) <= 4096);
for (let index = 0; index < u32(moduleList); index++) {
  const offset = moduleList + 4 + 108 * index, name = u32(offset + 20);
  assert.ok(u32(name) <= 32_768);
  modules.push({ base: u64(offset), size: u32(offset + 8), name: data.toString("utf16le", name + 4, name + 4 + u32(name)) });
}
const describe = (address) => {
  const module = modules.find((item) => address >= item.base && address < item.base + BigInt(item.size));
  return module ? { address: hex(address), module: module.name, base: hex(module.base), rva: hex(address - module.base) } : { address: hex(address) };
};
const exception = streams.get(6).offset, context = u32(exception + 164);
const threadId = u32(exception), address = u64(exception + 24);
const registers = {};
for (const [name, offset] of Object.entries({ rax: 120, rcx: 128, rdx: 136, rbx: 144, rsp: 152, rbp: 160, rsi: 168, rdi: 176, r8: 184, r9: 192, rip: 248 })) registers[name] = hex(u64(context + offset));
const candidates = [], threadList = streams.get(3).offset;
assert.ok(u32(threadList) <= 4096);
for (let index = 0; index < u32(threadList); index++) {
  const offset = threadList + 4 + 48 * index;
  if (u32(offset) !== threadId) continue;
  const start = u64(offset + 24), length = u32(offset + 32), raw = u32(offset + 36);
  const relative = Number(u64(context + 152) - start);
  assert.ok(relative >= 0 && relative < length);
  for (let pos = relative; pos + 8 <= Math.min(length, relative + 8192) && candidates.length < 80; pos += 8) {
    const found = describe(u64(raw + pos));
    if (found.module) candidates.push({ stackOffset: pos - relative, ...found });
  }
}
console.log(JSON.stringify({ file, exceptionCode: hex(u32(exception + 8)), threadId, exception: describe(address), registers, rawStackCandidates: candidates }, null, 2));
