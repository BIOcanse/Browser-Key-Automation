# Browser Key Automation

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

Browser Key Automation turns the Chromium browser you already use into a Key-scoped automation surface for trusted Agents and programs. Install the extension once, create a Key, and an authorized client can move across your existing signed-in tabs without launching a separate automation browser.

The primary path uses ordinary extension APIs—not CDP, WebDriver, remote-debugging switches, or `chrome.debugger`. Chromium still handles installation, site access, and the one-time **Allow User Scripts** setting. After that setup, routine browser commands do not attach a debugger or show Chrome's debugging confirmation or warning bar.

## Why Browser Key Automation

- **Seamless control of the browser already in front of you.** List, create, select, navigate, reload, and close tabs at any time while keeping the user's real sessions, cookies, extensions, and manually reached page state.
- **An Agent-sized view of the whole page.** The cached canonical operation tree keeps the overall structure visible, expands only requested branches, preserves each Key's expansion state until the document changes, and offers one-shot depth, range, and subtree views without mutating that state.
- **State changes that prove their result.** `ensure.run` combines a strict condition, one registered browser action, bounded preparation, and an observable goal under one deadline. Live iframe paths are re-resolved on every observation, nested-scroll search can traverse virtual lists, and each admitted call returns a Key-owned bounded, redacted trace reference. Non-repeat actions are never replayed after dispatch; an unprovable outcome is reported as `unknown`.
- **Key-scoped trust instead of an open debugging endpoint.** Root and Regular Keys have explicit permissions, expiry, reveal, disable, and revoke controls. Calls are serialized per Key, while different Keys can work independently.
- **A one-suffix native click fallback.** On Windows, `dom.click.real` combines extension-observed element geometry with the local App to send an OS-level left click when a page rejects synthetic DOM activation. The target must still be live, visible, enabled, and unobstructed.
- **Files are first-class.** Save a page as MHTML, capture the visible viewport, fetch resources into bounded Artifacts, download them to disk, upload self-contained HTML, and open it as a browser demo without running a local web server.
- **Cooperative multi-client control.** A Key can occupy a tab or the global scope to avoid dirty state; another authorized Key must explicitly release that occupation before acquiring it.

### Workflow comparison

Connection models checked 2026-09-01. This compares normal workflows, not theoretical feature ceilings.

| Approach | Existing signed-in Chromium | Normal control path | Best fit |
| --- | --- | --- | --- |
| **Browser Key Automation** | Yes—any authorized tab, across tabs | Ordinary extension APIs + Key authentication; the local App adds routing, files, and the optional `.real` click | Long-lived trusted Agent access without a debugger attachment; selective cached tree and integrated file workflows |
| [Playwright](https://playwright.dev/docs/api/class-browsertype), [Puppeteer](https://pptr.dev/guides/browser-management), [Selenium](https://www.selenium.dev/documentation/overview/) | Their usual path creates an automation session; existing Chromium attachment is also available | Playwright/CDP, Puppeteer/CDP, or WebDriver | Deterministic tests, cross-browser validation, CI, mature locator and debugging ecosystems |
| [Playwright MCP extension](https://github.com/microsoft/playwright/tree/main/packages/extension#readme) | Yes; a profile token can remove its own later connection approval | Playwright relayed through an extension that declares Chrome's `debugger` permission | Playwright actions and accessibility snapshots over selected existing tabs |
| [Chrome DevTools MCP](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect) | Yes, after remote debugging is enabled or a debugging endpoint is exposed | DevTools/CDP; Chrome's auto-connect route asks the user to allow each debugging session | Console, Network, Performance, memory, and other deep DevTools diagnosis |
| [Browser MCP](https://browsermcp.io/) | Yes, after the user connects the current tab | Extension + local MCP, scoped to the explicitly connected working tab | A compact MCP surface for one chosen existing tab |
| [Chrome MCP Server](https://github.com/hangwin/mcp-chrome) | Yes, across tabs | Extension + native-messaging bridge; its manifest requests `debugger` alongside ordinary extension permissions | Broad cross-tab MCP tools, network capture, downloads, and file upload |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | Yes | Integrated in-browser Agent built on Puppeteer/CDP, with user-supplied LLM provider Keys | A bundled multi-Agent UI rather than a provider-neutral browser control plane |

Browser Key Automation does not replace Playwright/Selenium test suites or DevTools diagnostics. It fills a different slot: low-friction, permissioned control of the browser a person is already using, with enough structure and file handling for an Agent to complete practical work.

> Distribution: [GitHub Releases](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest) provides an unpacked extension for Chrome/Chromium 138 or later and a separate companion App. Chrome Web Store distribution follows its own publication track. Each release has exactly two downloads: `browser-key-automation-extension-v0.0.0.4.zip` and `browser-key-automation-local-app-v0.0.0.4.zip`.

## What It Can Do

- Create, reveal, copy, update, disable, and revoke Root or Regular Keys in a local management page. A saved full Key can be revealed again; it is not restricted to a one-time display.
- List tabs and use runtime-bound `TabRef`, `DocumentRef`, `NodeRef`, `TreeRef`, and `ArtifactRef` values instead of raw browser IDs.
- Explore a cached page operation tree. Expansion state belongs to each Key and survives switching away from a page until that document is refreshed or replaced.
- Find nodes without expanding the tree, request one-time depth/range/subtree views, read bounded live DOM, describe nodes, and run DOM actions.
- Execute JavaScript in an explicit `USER_SCRIPT` or `MAIN` world when Chromium's **Allow User Scripts** switch is enabled.
- Wait for navigation, `interactive`, `complete`, DOM, or text conditions.
- Save the current page as MHTML, capture a verified viewport image, transfer bounded Artifacts, and open self-contained HTML demonstrations without a local HTTP server.
- Send an explicit Windows native left-click with `dom.click.real`. It has a permission independent from ordinary `dom.click`.
- Insert text at the current caret with `dom.insertText`, or use Windows native keyboard commands for exact text, human-paced text, named keys, arbitrary shortcuts, deliberate down/up state, and instance-scoped reset.
- Let one Key occupy a tab or the global scope. Another authorized Key must explicitly release that occupation before acquiring it.

The command registry is the public source of truth for exact methods, schemas, permissions, and errors. `system.describe` reports the active build and the calling Key's effective permissions.

## Quick Start

### Requirements

- Chrome or another compatible Chromium browser, version 138 or later
- Windows x86_64 or Linux x86_64 for the companion App
- Node.js 20 or later for the packaged CLI

### 1. Download the extension and App

Download both ZIPs from the [latest release](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest), then extract each into its own directory.

- Extension: `browser-key-automation-extension-v0.0.0.4.zip`
- Local App: `browser-key-automation-local-app-v0.0.0.4.zip`

The App ZIP includes `windows-x86_64/` and `linux-x86_64/`, plus the CLI and Agent skill. No source build is needed.

### 2. Load the extension

1. Extract the extension archive completely.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select the extracted directory whose root directly contains `manifest.json`.
4. On the extension details page, enable **Allow User Scripts**, then reload the extension. This browser-owned switch is required only for `js.execute`; Key management, DOM, and the page tree remain available without it.
5. Open **Browser Key Automation** from the toolbar. Create a Root Key for full trusted control or a Regular Key with only the required permissions.

The first installation opens a local setup page. Updates and reloads do not repeatedly open it.

### 3. Start the companion App

Extract the GitHub Release App archive and keep the relay for the current platform running:

```text
# Windows
.\windows-x86_64\browser-key-relay.exe

# Linux
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

The default endpoint is `127.0.0.1:32189`. If the App is unavailable, the extension retries at the configured nominal 10-second interval until it connects. Do not start a second App when the fixed endpoint is already owned by a compatible instance.

### 4. Connect the CLI

Run these commands from the extracted local App directory:

```text
node client/browser-key-cli.mjs instances
```

This command does not require a Key. Zero instances means that no extension is connected yet. With multiple instances, select an explicit current `relayEpoch/instanceNumber`; never try a bearer Key against every instance.

Set the Key through an environment variable, never through argv:

```powershell
# PowerShell
$env:BKA_API_KEY = "bk1.<key-id>.<secret>"
node .\client\browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json "{}"
```

```bash
# Bash
export BKA_API_KEY='bk1.<key-id>.<secret>'
node client/browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json '{}'
```

The CLI re-enumerates instances before reading the Key. If delivery is reported as `unknown`, treat it as unknown and do not automatically retry an effectful command.

## Common Workflows

- Page discovery: `tabs.list` → `page.tree.open` → `page.tree.find` or `page.tree.expand.v2` → `page.tree.view.get`.
- Page synchronization: use `page.wait`; omitted timeout means 10 seconds, and an already-satisfied condition returns immediately.
- Save a page: `node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml`.
- Capture the viewport: `node client/browser-key-cli.mjs page-shot --tab-ref <TabRef> --output ./page.png`.
- Open a demonstration: `node client/browser-key-cli.mjs demo-open ./demo.html`.
- Inspect an unfamiliar command in `skills/browser-key-automation/references/commands.registry.json` before calling it. The packaged Agent skill contains the same generated references.

### Element images and explicit debugging

`page.screenshot.element` lets an Agent inspect a Canvas, chart, or container using its existing NodeRef. The extension includes visible descendants, masks supported geometry, and fits it proportionally into an exact-size transparent PNG. No screen-coordinate calculation or debugger attachment is needed.

```text
node client/browser-key-cli.mjs element-shot --node-ref <NodeRef> --width 800 --height 600 --output ./element.png
```

For deeper diagnosis, use `debugger.attach` → `debugger.send` → `debugger.events.get` → `debugger.detach`. This separate `debugger` permission exposes CDP commands and events; Chrome's own debugging confirmation/warning remains. Ordinary extension operations stay on their existing path.

Element capture uses the current viewport of an already-active tab. It does not scroll or reconstruct hidden content. Supported shapes, top-document scope, local regions, large CDP results and failure semantics are documented in [the Agent guide](skills/browser-key-automation/references/debugger-and-element-capture.md).

### Native `.real` Click

`dom.click.real` is explicit and independent from `dom.click`. On Windows it asks Chromium to activate the target tab and focus its browser window, verifies that the referenced element is live, visible, enabled, and unobstructed, then asks the companion App to send one native left-click to the matched Chromium content window.

`{ "status": "input_sent" }` means that one input sequence was accepted, not that the website completed the requested business action. Observe the page afterwards. Never automatically replay an unknown or failed native input. The Linux App currently does not advertise `native.input.click.v1`, so the extension rejects `.real` before page preparation there.

### Native Keyboard Input

`keyboard.type` sends exact Unicode text immediately, while `keyboard.typeHuman` is the separate bounded human-paced mode. `keyboard.press` accepts named keys and chords; plain names perform a complete down/up, while an action array can deliberately preserve raw `down`/`up` state across commands. `keyboard.reset` releases only keys held for the current extension instance. `dom.insertText` remains a separate, untrusted DOM insertion at the current caret or selection.

Native keyboard commands target a NodeRef or TabRef and require the exact Chromium window in the foreground. If the target/foreground changes or conflicting physical keys appear, the App stops before sending more input; accepted effects are never replayed. Windows advertises `native.input.keyboard.v1`; Linux does not currently claim this backend.

## Keys, Permissions, and Control

- A Key is the sole external identity. Agent brand, process, account, socket, and App instance are not additional authorization identities.
- Root dynamically receives every active permission. A Regular Key receives only explicitly selected permissions.
- JavaScript, ordinary DOM actions, native click, each native-keyboard operation, network access, and explicit `debugger` access are parallel permissions; granting one does not silently grant another.
- Same-Key commands are serialized in the live extension runtime. Different Keys have independent lanes, but their effects on the same webpage can still race.
- Occupation is owned by a Key. There is no hidden takeover, force, or replace command: release first, then acquire.
- The full Key stays inside the extension. The trusted management page and callers separately authorized for `keys.create` or `keys.reveal` can receive it; public lists and normal diagnostics do not include it. The CLI reads it only from `BKA_API_KEY` (or an explicitly selected environment variable).

Treat a powerful Key like a local browser-control credential. Give it only to trusted Agents or automation programs. A Key's technical permission never replaces the user's authorization for payments, posting, sending messages, account changes, deletion, or other consequential actions.

## Browser and Platform Boundaries

Chromium still controls host access, restricted pages, file URL access, the **Allow User Scripts** switch, extension enablement, and any DevTools debugging confirmation. Root cannot bypass those browser-owned boundaries.

The Windows and Linux Apps both provide routing and file delivery. Windows additionally advertises the current native click and keyboard backends. Linux does not claim those backends yet. Incognito behavior and Chromium derivatives must be verified for their own profile and policy configuration.

Agent setup: [Browser Key Automation skill](skills/browser-key-automation/SKILL.md).

This project is maintained by the author. External contributions and pull requests are not accepted.
