# Key-owned virtual input

Use `virtualMouse.*` and `virtualKeyboard.*` for persistent input state without moving the physical cursor. They require their independent Key permissions and the Windows x64 App capability `native.virtualMouse.v1`. Keep `virtual-mouse-hook.dll` beside the relay. Read the active command registry for exact parameters and limits.

## Ownership and targeting

One authenticated Key owns one logical mouse and keyboard in the App. There is no public create/destroy or mouseRef. State reads do not allocate an object. Every effect explicitly names a current TabRef; element-to-element dragDrop derives the tab from its two NodeRefs.

Before virtual input, acquire the whole Chromium window with `control.acquire({scope:"window",windowId})`. Obtain windowId from tabs.list/get. A same-Key global occupation also satisfies this requirement; tab-only occupation does not. Other windows remain independent and one Key may own multiple windows.

If another Key owns the scope, an authorized caller must release it first, then acquire it separately. Release waits for admitted input and native resource cleanup; a failed release does not hand the window over. Interception of human input is a separate explicit option, not an effect of occupation.

The target tab must already be active within its window. These commands never switch tabs, request OS foreground, interpolate, or retry input. Use tabs.activate explicitly when changing target tabs. Coordinates are integer CSS viewport pixels; the adapter maps them through the current calibration and briefly marks/restores the page title.

## Calibration and ensure

After acquiring the window, call `input.calibrate({tabRef})` before ordinary virtual input. This independent permission belongs to the native-input group. Calibration measures the page region relative to the browser window, sends no mouse/keyboard input, and neither moves nor foregrounds the window. Its result contains `windowId`, `updated`, and `coordinates:"css_viewport"`; the default timeout is 10 seconds.

Ordinary and strict input require a current calibration. Missing calibration returns `NATIVE_INPUT_FAILED` with reason `CalibrationRequired`; document/geometry changes return `CalibrationStale` before delivery. Calibrate again after changing the active document, resizing, changing DPI, or releasing/resetting the native resource. Logical mouse/keyboard state remains Key-owned and is not reset by calibration.

An `ensure.run` virtual mouse effect or `virtualKeyboard.input` checks calibration before its effect and refreshes only when invalid. Successive calls reuse the App's valid measurement; no TTL or second workflow cache is involved. Ensure also requires `input.calibrate`, window occupation, and an explicit observable goal. Every input remains `repeat:"never"`. A satisfied initial goal skips calibration and input. Failed calibration returns `failed`, stage `prepare`, `effectSent:false`; preparation and delivery share the workflow deadline. See [ensure-workflows.md](ensure-workflows.md).

Use `trace.read` on the response traceRef to inspect `input_calibration` events: `updated` means a measurement was made; `reused` means the existing calibration passed checks. Native sequences also check the marked active document between events; a tab switch can stop the remainder without replaying it.

An already calibrated, unchanged window can receive input while covered without being brought forward. First calibration requires a measurable page region; if Chromium has already hidden that region, calibration fails rather than uncovering it or falling back to another backend. Minimized-window delivery is not supported by this path. Window movement alone does not invalidate the relative page region: native delivery reads the current window position and checks size/DPI.

## Mouse primitives and shortcuts

All examples are params for schemaVersion 1:

```json
{"scope":"window","windowId":12}
{"tabRef":"<TabRef>","actions":[
  {"kind":"move","x":100,"y":200},
  {"kind":"button","button":"left","action":"down"},
  {"kind":"move","x":240,"y":260},
  {"kind":"button","button":"left","action":"up"}
]}
```

Use the first object with control.acquire, then call input.calibrate with the TabRef, and send the second object to virtualMouse.input.

- `move({tabRef,x,y})`: move/hover only.
- `click({tabRef,at?,button?})`: optional move followed by one complete press. The button must not already be held; validation rejects the whole sequence before moving.
- `down({tabRef,button?})` and `up({tabRef,button?})`: explicit state across calls.
- `drag({tabRef,from?,via?,to,button?})`: optional start move → down → each via move → endpoint move → up. Omitted from retains the current point; no hidden intermediate points or waits.
- `dragDrop({fromNodeRef,toNodeRef,fromOffset?,toOffset?,button?})`: resolves two live elements in one tab, including supported iframe geometry, then composes the same drag primitives and releases at the destination. Offsets are CSS pixels from each border box; otherwise it selects an unobstructed interior point. Both endpoints must already be visible. This is not OS file dragging or a guarantee of browser-native HTML5 DataTransfer behavior.
- `scroll({tabRef,at?,deltaX?,deltaY?})`: optional move then wheel. Deltas are Win32 wheel units (120 is one conventional notch), not CSS pixels; each defaults to zero.
- `interception({tabRef,enabled})`: explicitly enable/disable physical mouse/keyboard filtering in the selected native window.

button accepts left/right/middle/back/forward and defaults to left. Meta-action button.action is press/down/up. A press counts as one completed action even though it sends down/up; a failed press may already have sent down. Chromium may coalesce fast moves. Observe the page separately when an intermediate position matters.

`virtualMouse.get({})` and `virtualKeyboard.get({})` return the same shared snapshot: initialized, mouse point/buttons/known, keyboard heldKeys/toggledKeys/known, windows and coordinates. Mouse button masks are left=1, right=2, middle=4, back=8, forward=16. The snapshot and error progress use CSS viewport coordinates.

## Keyboard and real-input cooperation

Use `virtualKeyboard.input({tabRef,keys,...})`. It reuses keyboard.press's key names, chords, optional holdMs/gapMs, and explicit down/up notation. A plain name or chord means a full press, not an indefinitely held key.

```json
{"tabRef":"<TabRef>","keys":[{"action":"down","key":"Ctrl"}]}
{"tabRef":"<TabRef>","keys":["A","Ctrl+C"]}
{"tabRef":"<TabRef>","keys":[{"action":"up","key":"Ctrl"}]}
```

Virtual mouse events and scoped virtual keyboard queries use the same logical modifier state. Logical held keys survive tab switches, navigation, resizing and background-worker recycling, without replaying old down/click events into new documents. A mouse action outside a resized viewport is rejected; supply a new point explicitly. A keyboard action does not move or clamp the retained mouse position.

Existing keyboard.type/typeHuman/press remain real SendInput commands and still activate/verify the foreground target. They share the Key's logical keyboard state. Held virtual modifiers are temporarily projected during real input and then physically released, while explicit real down keeps an owned native hold. An explicit up/reset only releases this Key's injected keys, never another Key's or a human's. The App tags its own real input so enabled interception does not mistake it for human interference.

Real keyboard callbacks retain Windows message-time keyboard queries; they do not read a later virtual-keyboard table while an earlier key is still queued. Their scoped mouse queries still use the Key's mouse state. Real input can pass through the active IME; a Process key event is not proof of failure. Observe the resulting text or application behavior, not only input_sent.

## Cleanup, uncertainty and boundaries

Use virtualMouse.reset to release mouse resources and virtualKeyboard.reset (or keyboard.reset) to release keyboard state. Reads and resets do not require reacquiring a window. Mouse reset keeps the logical position; keyboard reset releases held keys while preserving known toggle bits.

Window release removes that window's native holds/capture/interception, not unrelated windows or another Key's state. Key revocation, expiry and relevant permission loss clean up input resources. Offscreen retains expiry/failed-cleanup responsibility until acknowledged; only idempotent cleanup is retried, never user input. On actual connection loss, native resources are retired. A reset after reconnect confirms cleanup against the original App epoch before discarding the old binding; no held state is replayed.

`known:false`, partial progress, and unknown delivery are not reasons to repeat an effect. Inspect the page and reset explicitly. Ensure may prepare calibration and verify the goal, but never replays virtual input or adds intermediate points to a sequence.

Scoped native cursor/key queries are applied during owned delivery even when interception is off; only filtering human messages is optional. Other windows and unrelated callbacks retain their real state. This is not a driver: arbitrary background polling, Raw Input, DirectInput, pointer lock, OS drag loops and every nested browser callback are not promised. A successful input result confirms accepted delivery, not that the website accepted a drop or completed its business action.

Commands default to a 10-second timeout. Action/object/diagnostic bounds are Freedom Points; inspect the generated registry when a bound is reached. Prefer ordinary dom.hover/dom.drag when untrusted DOM events suffice; never substitute a debugger, .real input or another backend silently.
