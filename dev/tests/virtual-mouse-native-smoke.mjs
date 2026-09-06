import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const executable = resolve('zig-out/bin/virtual-mouse-probe.exe');
await mkdir(resolve('out/test-artifacts'), { recursive: true });
const directory = await mkdtemp(resolve('out/test-artifacts/virtual-mouse-native-'));
const hashes = {};
for (const file of ['app/src/virtual_mouse/windows/client.c', 'app/src/virtual_mouse/windows/hook.c',
  'app/src/virtual_mouse/windows/wire.h', 'dev/tests/experiments/virtual-mouse/native-probe.c',
  'zig-out/bin/virtual-mouse-probe.exe', 'zig-out/bin/virtual-mouse-hook.dll']) {
  hashes[file] = createHash('sha256').update(await readFile(resolve(file))).digest('hex');
}
await writeFile(resolve(directory, 'source-and-binary-hashes.json'), JSON.stringify(hashes, null, 2));
const events = [];
const logs = [];
const fixture = spawn(executable, ['target'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let settled = false;
const exited = new Promise((resolveExit) => fixture.once('exit', (code) => { settled = true; logs.push(`fixture exit: ${code}`); resolveExit(code); }));
const ready = new Promise((resolveReady, reject) => {
  const timer = setTimeout(() => reject(new Error('Native fixture did not start')), 5000);
  fixture.once('error', reject);
  const lines = createInterface({ input: fixture.stdout });
  lines.on('line', (line) => {
    logs.push(line);
    try {
      const record = JSON.parse(line);
      events.push(record);
      if (record.kind === 'ready') { clearTimeout(timer); resolveReady(record); }
    } catch { /* Preserve raw output for diagnosis. */ }
  });
});
fixture.stderr.on('data', (data) => logs.push(String(data)));

function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Controller timeout: ${output}`)); }, 15000);
    child.once('error', reject);
    child.once('exit', (code) => { clearTimeout(timer); resolveRun({ code, output }); });
  });
}

let binding;
let controller;
let abandoned, abandonedHook;
try {
  binding = await ready;
  abandoned = await run(['abandon', binding.target, binding.other]);
  assert.equal(abandoned.code, 0, abandoned.output);
  abandonedHook = await run(['abandon-intercepted', binding.target, binding.other]);
  assert.equal(abandonedHook.code, 0, abandonedHook.output);
  controller = await run(['controller', binding.target, binding.other]);
  assert.equal(controller.code, 0, controller.output);
  await run(['close', binding.target, binding.other]);
  await exited;
  const target = events.filter((event) => event.kind === 'event' && event.hwnd === binding.target);
  for (const [message, x, y, held] of [[512,17,29,0], [513,17,29,1], [512,50,60,1], [514,50,60,0], [512,70,80,0]]) {
    const event = target.find((item) => item.message === message && item.x === x && item.y === y);
    assert.ok(event, `Missing native event ${message} at ${x},${y}`);
    assert.equal(event.queryX, x);
    assert.equal(event.queryY, y);
    assert.equal(event.left, held);
    assert.equal(event.asyncLeft, held);
    assert.equal(event.hit, binding.target, 'Virtual cursor hit testing must resolve the owned HWND');
    assert.notEqual(event.awayHit, binding.target, 'Different coordinates must not inherit virtual hit testing');
  }
  const wheel = target.find((event) => event.message === 522);
  const activation = events.find((event) => event.kind === 'virtual-activation');
  assert.ok(activation, 'Native activation boundary was not exercised');
  assert.equal(activation.foreground, 0);
  assert.equal(activation.error, 50, 'Virtual SetForegroundWindow must explicitly reject the OS side effect');
  assert.ok(activation.positioned);
  assert.equal(activation.flags & (0x10 | 0x04 | 0x0200), 0x10 | 0x04 | 0x0200, 'Virtual root positioning must preserve foreground and Z order');
  const unscoped = events.find((event) => event.kind === 'unscoped-positioning');
  assert.ok(unscoped, 'Missing native passthrough baseline');
  for (const kind of ['nested-positioning', 'real-key-positioning']) {
    const position = events.find((event) => event.kind === kind);
    assert.ok(position, `Missing scope-boundary fixture: ${kind}`);
    assert.equal(position.flags & (0x04 | 0x0200), 0, `${kind} must retain its original Z-order flags`);
    assert.equal(position.flags & 0x10, unscoped.flags & 0x10, `${kind} must not add activation flags`);
    assert.deepEqual([position.foreground, position.error], [unscoped.foreground, unscoped.error], `${kind} must pass the native foreground request through`);
  }
  const directOther = events.find((event) => event.kind === 'direct-other-positioning');
  assert.ok(directOther, 'Missing direct A-to-B SetWindowPos callback');
  assert.equal(directOther.keyF24, 0, 'Native positioning callback on another HWND inherited A virtual state');
  assert.deepEqual([directOther.foreground, directOther.error], [unscoped.foreground, unscoped.error]);
  assert.equal(events.find((event) => event.kind === 'after-direct-positioning')?.keyF24, 1, 'A virtual state was not restored after the B callback');
  assert.ok(wheel, 'Missing native wheel');
  assert.equal(wheel.flags, 120 * 65536);
  assert.deepEqual([wheel.queryX, wheel.queryY], [50, 60]);
  assert.deepEqual([wheel.x, wheel.y], [wheel.screenX, wheel.screenY]);
  assert.equal(wheel.hit, binding.target);
  assert.ok(!target.some((event) => event.x === 200 && event.y === 210), 'Isolated window leaked external mouse message');
  assert.ok(target.some((event) => event.x === 202 && event.y === 212), 'Detached window did not recover');
  assert.ok(events.some((event) => event.hwnd === binding.other && event.x === 201 && event.y === 211), 'Unrelated window was filtered');
  const nested = events.find((event) => event.hwnd === binding.other && event.flags === 77);
  assert.ok(nested, 'Nested other-window callback did not run');
  assert.notDeepEqual([nested.queryX, nested.queryY], [17, 29], 'Nested HWND inherited virtual cursor coordinates');
  assert.equal(nested.left, 0, 'Nested HWND inherited virtual left-button state');
  assert.notEqual(nested.hit, binding.target, 'Nested HWND inherited virtual hit testing');
  const detached = target.find((event) => event.x === 202 && event.y === 212);
  assert.notEqual(detached.hit, binding.target, 'Detached hidden target still intercepted hit testing');
  const keys = events.filter((event) => event.kind === 'key' && event.hwnd === binding.target);
  for (const [message, arrayA] of [[256, 128], [257, 0]]) {
    const event = keys.find((entry) => entry.message === message && entry.vk === 65);
    assert.ok(event, 'Missing virtual A key event');
    assert.deepEqual([event.shift, event.asyncShift, event.arrayShift, event.arrayCaps, event.arrayA], [1, 1, 128, 1, arrayA]);
    assert.deepEqual([event.pointerX, event.pointerY, event.left], [73, 91, 1], 'Keyboard callback lost the supplied mouse snapshot');
  }
  assert.ok(!keys.some((event) => event.vk === 88), 'Unmarked external key bypassed enabled filtering');
  const ownKey = keys.find((event) => event.vk === 90);
  assert.ok(ownKey, 'Own-tag key was filtered');
  assert.deepEqual([ownKey.shift, ownKey.asyncShift, ownKey.arrayShift & 0x80], [0, 0, 0], 'Real keyboard callback inherited the later virtual keyboard table');
  assert.deepEqual([ownKey.pointerX, ownKey.pointerY, ownKey.left], [73, 91, 1], 'Real keyboard callback lost the Key mouse context');
  assert.ok(events.some((event) => event.kind === 'key' && event.hwnd === binding.other && event.vk === 89), 'Unrelated window keyboard was filtered');
  const threadIsolation = events.find((event) => event.kind === 'thread-isolation');
  assert.ok(threadIsolation, 'Missing concurrent query from unrelated thread');
  assert.deepEqual([threadIsolation.keyF24, threadIsolation.arrayF24], [0, 0], 'Another thread inherited the virtual input scope');
  const restored = events.find((event) => event.kind === 'keyboard-restore-isolation');
  assert.ok(restored, 'Missing keyboard table round-trip check');
  assert.deepEqual([restored.keyF24, restored.arrayF24], [0, 0], 'Restoring a virtual keyboard snapshot contaminated the real thread keyboard table');
  assert.equal(restored.outsideSetter, true, 'Unscoped SetKeyboardState stopped working');
  const setter = events.find((event) => event.kind === 'keyboard-restore-result');
  assert.deepEqual([setter?.accepted, setter?.error], [0, 50], 'Scoped keyboard writes must explicitly reject without altering either state');
  console.log(JSON.stringify({ ok: true, events: events.length, evidence: directory, controller }, null, 2));
} finally {
  if (!settled && binding) await run(['close', binding.target, binding.other]).catch(() => {});
  if (!settled) fixture.kill();
  await writeFile(resolve(directory, 'events.json'), JSON.stringify(events, null, 2));
  await writeFile(resolve(directory, 'fixture.log'), logs.join('\n'));
  await writeFile(resolve(directory, 'controller.json'), JSON.stringify(controller ?? null, null, 2));
  await writeFile(resolve(directory, 'abandoned-owners.json'), JSON.stringify({ abandoned, abandonedHook }, null, 2));
}
