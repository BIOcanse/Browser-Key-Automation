# Quick screenshots and HTML demonstrations

Use the packaged helpers instead of rebuilding capture/download or upload framing. All commands use the existing Key and selected relay instance. Omitted business defaults are expanded only by the extension registry; the client does not keep a second set.

## Screenshot

```text
node client/browser-key-cli.mjs page-shot --tab-ref <TabRef> --output ./page.png
node client/browser-key-cli.mjs page-shot --tab-ref <TabRef> --output ./page.jpg --format jpeg --quality 85
```

Requires `page.screenshot.capture` and `artifact.read`. Default format is PNG; JPEG quality defaults to 80 and accepts 0–100. The result includes an absolute local `output`, `artifactRef`, `mediaType`, `byteLength` and `sha256`. Present that image file to the user/Agent image reader, not base64 text.

This is the visible webpage viewport, not browser chrome, the desktop, a whole scrolling page, or a video stream. The target must already be the active tab in its own window; on `TARGET_TAB_NOT_VISIBLE`, an explicit separately authorized `tabs.activate` is needed before another capture. Chrome limits this API to two calls per second. Parent output directory must exist; existing files are never overwritten. On a failed save, preserve the returned ArtifactRef and use `artifact-save` rather than recapturing automatically.

## Demonstration

```text
node client/browser-key-cli.mjs demo-open ./demo.html
node client/browser-key-cli.mjs demo-open ./demo.html --window-id <WindowId> --active false
node client/browser-key-cli.mjs demo-open ./updated.html --tab-ref <existing-demo-TabRef>
```

Requires `artifact.write` and `demo.open`. Old Regular Keys need these grants explicitly; Root includes newly active permissions automatically. These permissions are independent of general `js.execute`, `tabs.create/navigate`, and `artifact.read` grants. No new OS foreground or window-moving action is performed.

Submit a UTF-8 self-contained HTML file with its CSS, JavaScript and necessary assets inline. The helper reads the caller's file, uses the existing App to send bounded chunks, commits only after full length/SHA-256 verification, then calls `demo.open`. It does not start an HTTP server, build a project, watch files, or expose a folder. Local path strings are not assumed to exist on the browser's machine.

Default creates and selects a new demo tab; `--active false` avoids selecting it. Updating uses an explicit existing demo TabRef; `--window-id` and `--tab-ref` cannot be combined. Normal personal tabs are rejected. Key lanes and existing global/tab occupations still apply, with no automatic release or takeover.

The result includes `input`, `tab` and `artifact`. It means Chromium accepted opening/updating the tab, not that every submitted script is bug-free. The fixed outer extension page reads the file; the HTML runs in a unique-origin sandbox with no extension APIs or Key access. People can interact with it and `page-shot` can capture it. General DOM/tree/`js.execute` commands remain restricted on extension pages; do not invent support or silently substitute CDP to operate the demo.

The original file is unchanged. The uploaded copy follows Artifact capacity/retention (`artifact.expiresAt`); refresh reloads its content while available, but JavaScript memory state resets. Do not release its Artifact while the user still needs to refresh/view it. Once released/expired, the viewer explains that it must be submitted again.

For low-level integrations, registry schemas define `artifact.upload.begin`, `append`, `commit`, then `demo.open`. Begin returns the ArtifactRef and maximum chunk size. Append uses the exact received offset. Partial uploads are not readable/openable; committed uploads cannot be appended. Partial storage counts toward the same quota and retention and can be explicitly released. A failed helper returns the known ArtifactRef when available; do not automatically retry an unknown-delivery append/commit/open or create another tab. Only after the outcome is known should the caller choose a new submission or cleanup.

## Native function entrypoints

Import `client/browser-key-cli.mjs` from the extracted App; imports do not start the relay or connect. It exports `saveScreenshot({tabRef, output, format?, quality?, instance?, apiKeyEnv?, readTimeoutMs?})` and `openDemo({file, tabRef?, windowId?, active?, instance?, apiKeyEnv?, readTimeoutMs?})`, alongside existing `savePage`/`saveArtifact`. `instance` is the same `relayEpoch/instanceNumber` string and Key remains in the named environment variable. These functions share CLI validation and the exact same implementation.
