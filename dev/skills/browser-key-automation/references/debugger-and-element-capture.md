# Element screenshots and explicit debugging

Use these commands only when `system.describe` includes them. Read the generated command registry for the current schema and permissions.

## See a Canvas, chart, or selected element

Reuse the NodeRef from the operation tree or `dom.query`. Select the container when its visible children belong in the image. You do not need to infer what a Canvas or WebGL surface has drawn, inspect its drawing commands, or calculate screen coordinates.

```text
node client/browser-key-cli.mjs element-shot --node-ref <NodeRef> --width 800 --height 600 --output ./element.png
```

The helper calls `page.screenshot.element`, then verifies and saves its Artifact. It needs `page.screenshot.capture` and `artifact.read`, not `debugger` or `js.execute`. Acquiring the NodeRef separately needs the appropriate tree/DOM permission. Regular Keys with the existing screenshot permission already have capture access; the new Debugger group is unrelated.

`width` and `height` specify the exact output rectangle, not a device scale factor. Defaults are 1024×768. The selected geometry retains its orientation, relative layout and aspect ratio, fits as large as possible inside that rectangle, and is centered. The result is an RGBA PNG: unused margins, gaps and areas outside supported element shapes are transparent. Increasing resolution resamples the captured pixels; it does not create more rendering detail.

To limit selection to part of the element, add `--region-json '{"x":0,"y":0,"width":200,"height":100}'` with your shell's JSON quoting. These are CSS pixels relative to the selected element's untransformed border box. This rectangle intersects the selected geometry, including children; it does not select unrelated overlapping elements. The low-level command accepts the same object as `region`.

The result carries `nodeRef`, `tabRef`, `width`, `height`, `sourceRect`, `contentRect`, `viewport`, and `viewportOnly: true`, alongside the Artifact or verified local file. `sourceRect` is the captured region in viewport CSS coordinates. `contentRect` is the fitted region in output pixels. Present the saved image file to the Agent's image reader, not base64 text.

### Boundaries

- This captures the current visible webpage, not the desktop, browser chrome, a full scrolling page, or an isolated compositor layer. The tab must already be active in its window. It never activates, scrolls, or attaches a debugger on its own. Chromium permits at most two viewport captures per second.
- `viewportOnly: true` is a constant capability disclosure, not a claim that the whole target fitted in the viewport. Offscreen portions are absent; a fully offscreen or hidden target fails with `EMPTY_REGION`. Use a separate, authorized scroll or tab activation when appropriate, observe again, then deliberately request another screenshot.
- The current geometry collector supports the top document, open shadow trees, rectangular/rounded boxes, 2D transforms, basic CSS `clip-path` shapes and supported SVG geometry. Nested-frame targets, perspective/3D, CSS image/URL masks, fragmented inline boxes and unsupported SVG paint geometry fail explicitly with `GEOMETRY_UNSUPPORTED`; do not silently substitute a bounding rectangle or CDP screenshot.
- The mask removes pixels outside known geometry. Backgrounds and occluding content **inside** that geometry remain as actually displayed. It does not recover a Canvas's original alpha, infer object shapes painted inside a rectangular canvas, remove overlapping content, or reconstruct antialiased foreground colors from an already-composited screenshot.
- Selection follows DOM boxes and supported paths, not extra paint extending beyond them such as pseudo-elements, shadows, outlines or filter spread. A rectangular Canvas/container remains rectangular unless its CSS geometry clips it.
- `GEOMETRY_CHANGED` means the document/viewport layout no longer matched the capture. Refresh the observation before a new explicit request. `TARGET_REF_STALE` requires a new NodeRef. Dimension, pixel, geometry and Artifact limits are visible in the generated Freedom registry; do not weaken limits silently.
- File saving never overwrites an existing destination or silently recaptures. If saving fails after capture, retain the known ArtifactRef and use `artifact-save` to recover it.

The native helper is `saveElementScreenshot({nodeRef, output, width?, height?, region?, instance?, apiKeyEnv?, readTimeoutMs?})`, exported by `client/browser-key-cli.mjs`. Importing starts no connection; it shares the CLI's validation and saving path.

## Explicit CDP debugging

Use this path when the task actually needs debugging. Normal DOM, tree, screenshots, files, and `.real` operations remain independent. The `debugger` Key permission is its own group; existing Regular Keys require an explicit grant. Root includes it automatically. It can perform powerful CDP operations and is not constrained by the Key's separate DOM/JavaScript permissions.

1. Call `debugger.attach` with the current `tabRef`.
2. Call `debugger.send` with `tabRef`, a CDP `method` such as `Runtime.enable`, and `params` (defaults to `{}`). A supplied `sessionId` targets a CDP child session from an earlier event/response.
3. Read `debugger.events.get` with `tabRef`, `afterSequence` (initially 0) and `limit` (default 100). It returns immediately, without consuming events. Continue from returned `nextSequence`; `hasMore` indicates another cached page. `droppedThroughSequence` discloses discarded history. If `attached` becomes false, inspect `detachedReason`; it does not reconnect automatically.
4. Call `debugger.detach` explicitly when the debugging work is finished. It also releases that tab's event buffer. The session has no extra Key owner; other Keys with `debugger` can use it, subject to the existing tab/global occupations.

For example, `debugger.send` params:

```json
{"tabRef":"<TabRef>","method":"Runtime.evaluate","params":{"expression":"document.title","returnByValue":true}}
```

The default `response: "inline"` returns the CDP object in `result`. Choose `response: "artifact"` **before** a potentially large response, for example `DOM.getDocument` or `Network.getResponseBody`; the complete CDP JSON is stored as `application/json` in an Artifact owned by the calling Key. Reading it separately requires `artifact.read`. There is no execute-again fallback for a large result.

Chrome owns the debugging confirmation/warning UI. This extension does not suppress it. Another debugger or DevTools can conflict or disconnect this connection. Chrome's `chrome.debugger` API supports a subset of CDP domains; it is not an unrestricted remote-debugging port. Do not use this path to bypass a user's refusal or silently replace a failed ordinary extension operation.

`DEBUGGER_OPERATION_FAILED.details.commandMayHaveRun` distinguishes pre-dispatch failure from possible execution. When true—including a command error, result-too-large, or result-storage failure—inspect state; never automatically replay an effectful command. Unknown transport delivery has the same no-replay rule. Native CDP results and events can contain private page data; preserve the user's authorization boundaries.

CDP calls still use the existing same-Key serial lane. For evaluations that may wait indefinitely, use the CDP method's own deadline where supported (for example `Runtime.evaluate.params.timeout`). A call stopped at a breakpoint can remain pending; another explicitly authorized debugging Key can read events or resume that shared tab connection. A client read timeout does not cancel the browser command.
