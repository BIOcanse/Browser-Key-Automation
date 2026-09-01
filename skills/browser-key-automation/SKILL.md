---
name: browser-key-automation
description: Inspect and operate an authorized local Chromium browser through Browser Key Automation using a supplied Key, including tabs, DOM, JavaScript, artifacts, settings, and the cached page operation tree. Use for requests that explicitly rely on this extension and companion; do not use for ordinary web research or CDP-only debugging.
---

# Browser Key Automation

Use the packaged CLI to call the extension through the local relay. The extension owns Key authentication, permissions, refs, occupation, and browser operations; the relay is only transport. Do not invent Agent, process, account, or connection identities around the Key.

## Connect

1. From the extracted local App directory, run `node client/browser-key-cli.mjs instances`.
2. If the relay is unreachable, start the package's relay executable once (`browser-key-relay.exe` on Windows, `browser-key-relay` on Linux), keep it running, wait one nominal 10-second extension retry interval, and call `instances` again. Do not start a second relay when the fixed port is already occupied.
3. Zero instances means the extension has not connected yet; wait and retry without a Key. One instance may be selected implicitly. For multiple instances, require an explicit current `relayEpoch/instanceNumber`; never probe each instance with the bearer Key.
4. Read the Key from `BKA_API_KEY` or another explicitly named environment variable. Never place it in argv, source files, logs, transcripts, or normal output.

Starting the companion is part of using this skill when it is absent. Leave it running after the task; call the CLI `stop` command only when the user explicitly asks to close it.

## One-time browser setup

On first installation the extension opens its local welcome page; Key management also links to it and shows the User Scripts check. For Chrome 138+, ask the user to open `chrome://extensions`, select Browser Key Automation → Details, enable **Allow User Scripts / 允许用户脚本**, then reload the extension. Re-enumerate instances afterwards; never reuse an old connection's instance ID. This is a browser-owned switch, not a Key grant, and Root does not bypass it.

Without the switch, `js.execute` returns `CAPABILITY_UNAVAILABLE` with `details.reason = USER_SCRIPTS_NOT_ENABLED` and actionable `details.setupInstructions`. Explain those steps to the user; do not loop JS calls, silently substitute CDP, or report the entire extension broken. DOM/tree reads and Key management remain usable. The welcome page's **重新检测** reloads only that page to refresh Chrome's context-specific API exposure; it is not the same as reloading the extension. If the switch is enabled but JS remains unavailable, reload the extension and report persistent browser/policy restrictions honestly.

`dom.click.real` is available only when the connected local App advertises `native.input.click.v1`. The Windows package does; the Linux package currently returns `CAPABILITY_UNAVAILABLE` before activation, scrolling, or other page preparation. Do not substitute CDP Input or ordinary `dom.click` when this capability is absent.

## Call commands

Use:

```text
node client/browser-key-cli.mjs call --method <method> --schema-version <version> --params-json <closed JSON object>
```

Before using an unfamiliar method, read `references/commands.registry.json` for its active schemaVersion, required permission, exact params/result schema IDs, target type, and allowed errors. Read `references/freedom.registry.json` only when a result hits a declared bound. These two references are generated copies of the extension registries; do not edit them. Do not guess a latest schema or add unknown fields.

The CLI enumerates current instances before reading the Key. Keep the exact instance fixed for a related multi-call flow. Treat `delivery: "unknown"` as genuinely unknown; do not automatically retry an effectful call. Same-Key calls are serialized by the extension, but still issue dependent operations in order.

`instances` reports the relay build ID; `system.describe` reports the extension build ID, caller KeyId and effective permissions (still requires `system.read`). Do not infer available commands from a manifest version alone. Old regular Keys need an explicit `page.wait` grant; Root includes new active permissions automatically.

## Read and operate pages

Use the operation tree as the normal page-discovery path. Read [references/operation-tree.md](references/operation-tree.md) before traversing a page.

- Use `tabs.list/get` to obtain current TabRefs. Never reuse a stale TabRef after close, replace, or runtime generation change.
- Tree rows with a NodeRef can be passed to `dom.describe`, `dom.click`, `dom.click.real`, `dom.focus`, `dom.scroll`, `dom.setValue`, or `dom.select`. Re-read the descriptor when the page may have changed.
- `page.tree.find` locates explicit text/role/CSS matches in the same canonical tree, including collapsed branches, without changing expansion. Do not expand everything just to locate a known target.
- Read [references/wait-and-save.md](references/wait-and-save.md) when waiting or saving a file. `page.wait` defaults to complete with a 10-second deadline; an already-satisfied condition returns immediately. Use explicit DOM/text conditions for async page data.
- `page.dom.get` is a bounded live-DOM preview; `page.dom.capture` and artifacts preserve larger data. `page.archive.capture` produces current MHTML, not the original navigation response.
- Use `page-save --tab-ref ... --output ...` for a real local webpage file in one call. `artifact-save` saves an existing Artifact. Neither helper silently releases or recaptures an Artifact.
- Use `page-shot --tab-ref ... --output ...` for a verified local viewport image in one call (default PNG). The target must already be active in its window; do not silently switch tabs or activate an OS window.
- Use `demo-open ./demo.html` to submit self-contained HTML and open an interactive demonstration without a local HTTP server. Use `--tab-ref` only to explicitly update an existing demo, not a normal webpage. Read [references/quick-shot-and-demo.md](references/quick-shot-and-demo.md) for permissions, options, native function exports and upload failure handling.
- `dom.click` means the DOM invocation ran, not that the site's business goal succeeded; trusted browser input is not promised. Disabled controls fail explicitly. `dom.setValue` supports plaintext replacement in contenteditable, not a rich-text editor transaction.
- `dom.click.real` is the explicit native left-click path. It has its own `dom.click.real` permission and does not imply or require `dom.click`, `dom.scroll`, `tabs.activate`, or `js.execute`. Params are `nodeRef`, optional `scrollIntoView` (default `true`) and optional total `timeoutMs` (default 10000, maximum 60000). It selects the target tab, requests its Chromium window focused, may scroll once, briefly marks/restores the page title to bind the exact native window, and returns only `{nodeRef,status:"input_sent"}`. That status means the platform accepted one complete input sequence, not that the website completed its goal; observe the result with `page.wait` or a new tree/read call. Never automatically retry `NATIVE_INPUT_FAILED` or unknown delivery when `clickState` is `unknown`.
- `js.execute` is an independent permission. Use explicit `USER_SCRIPT` or `MAIN`; do not infer it from DOM permissions or silently fall back to CDP.
- Restricted Chromium pages, missing host access, the User Scripts switch, and Chrome's own debugging confirmation remain platform boundaries. Report them; do not try to bypass them.

## Occupation and authority

Occupation belongs to a Key. If `control.acquire` reports another Key's occupation, first issue a separate authorized `control.release`, then a separate `control.acquire`; never emulate takeover/force/replace in one hidden helper.

Plugin permission is not user authorization for consequential external actions. Preserve the user's stated limits for payments, posting, messages, account changes, deletion, and other externally meaningful effects even when the Key technically permits them.

## Finish

Return the observed result and any refs/artifacts the caller needs next. Mention stale/capability/permission limits precisely. Do not expose the Key. Release temporary ArtifactRefs when they are no longer needed; do not stop the persistent relay unless requested.
