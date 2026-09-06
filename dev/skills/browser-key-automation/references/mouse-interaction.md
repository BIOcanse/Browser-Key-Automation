# DOM hover and drag

Check `system.describe` or the active registry for availability. `dom.hover` and `dom.drag` each have an independent permission in the DOM permission group. A regular Key with only `dom.click` does not automatically gain them.

These commands do not attach a debugger, require Allow User Scripts, activate a tab/window, move the OS cursor, scroll, or maintain mouse state. They dispatch synthetic DOM events in the exact NodeRef document. Use them for page JavaScript handlers, not as proof of trusted input or browser-native behavior.

## Hover

```json
{"nodeRef":"<NodeRef>"}
{"nodeRef":"<NodeRef>","phase":"leave"}
{"nodeRef":"<NodeRef>","phase":"enter","offset":{"x":12,"y":8}}
```

Call `dom.hover`, schema version 1. Default `phase` is `enter`; `leave` explicitly sends exit events. `offset` defaults to null (the element bounding rectangle center). Non-null offsets are CSS pixels from that rectangle's top-left, not screenshot pixels. There is no remembered previous hovered element.

JavaScript pointer/mouse hover listeners can respond. Browser CSS `:hover` does not change merely because these events were dispatched. If the task needs a real browser pointer, use an explicitly authorized debugger or native route; do not silently attach or substitute a backend.

## Drag

```json
{"nodeRef":"<SourceNodeRef>","toNodeRef":"<DestinationNodeRef>"}
{"nodeRef":"<SourceNodeRef>","toNodeRef":"<DestinationNodeRef>","mode":"html5"}
{"nodeRef":"<CanvasNodeRef>","toNodeRef":"<CanvasNodeRef>","fromOffset":{"x":15,"y":20},"toOffset":{"x":300,"y":90},"steps":8}
```

Call `dom.drag`, schema version 1. Defaults: `mode:"pointer"`, `steps:12`, `fromOffset:null`, `toOffset:null`; the current maximum steps is 120. Offsets use the same CSS border-box coordinates as hover, so a Canvas/container can be both endpoints.

- `pointer`: down → bounded straight-line move segments → up. Supports cooperative pointer/mouse listeners such as custom dragging or Canvas drawing. It does not create native pointer capture, CSS hover, human timing, or all built-in control default actions. The segments are delivered immediately within one document call.
- `html5`: dragstart → drag/dragenter/dragover → drop → dragend using one DataTransfer. Source listeners supply data. A canceled dragstart stops immediately. The final dragover must be canceled to accept the drop. This is not an OS file drag or a replacement for file input upload.

Both endpoints must be live in the same current document (including the same iframe document). Cross-document/cross-tab drag is rejected before input. Start/end points must be visible within that document viewport and unobstructed. There is no implicit scrolling. Use `dom.scroll` explicitly or the existing ensure preparation when appropriate; it cannot make two incompatible offscreen endpoints visible simultaneously.

## Results and workflows

Success returns `{nodeRef,status:"events_dispatched",eventCount,canceledAt}`. `canceledAt` is null, `dragstart`, or `dragover`. A null value means the declared sequence was sent, not that the site completed its goal. Inspect the page or use an observable ensure goal.

Both commands are non-repeat actions in `ensure.run`. Put the source in `action.target` instead of `action.params.nodeRef`. For drag, `action.params.toNodeRef` remains an exact destination reference: ensure does not rebind or separately scroll a second locator. Supply a concrete goal and the relevant observation/scroll permissions. Unknown/partial outcomes must not be automatically replayed.

`DOM_OPERATION_FAILED` details include `reason`, `eventCount`, and `commandMayHaveRun`. Null eventCount means the document result was lost; earlier events may have run. Known stale NodeRefs can fail with `TARGET_REF_STALE`. Do not interpret either as permission to repeat a drag.

These stateless commands are not a virtual-mouse object. For the independent `virtualMouse.*` family, consult the active registry and [virtual-mouse.md](virtual-mouse.md); it has a separate Key permission, Windows App capability and explicit interception boundary.
