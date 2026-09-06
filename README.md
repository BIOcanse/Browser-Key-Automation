# Browser Key Automation

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [Português (Brasil)](README.pt-BR.md) | [Русский](README.ru.md)

**Give your Agent the browser you already use.**

Work in existing signed-in Chromium tabs, inspect pages without drowning in HTML, and move from reading to acting to saving the result. Routine commands use extension permissions: no separate automation browser, no automatic debugger attachment, and no extra per-command confirmation from this extension. Browser-owned permission prompts still apply.

## Why use it

- **See the page in manageable pieces.** A cached operation tree preserves the overall structure while you expand only relevant branches. Switching tabs preserves expansion state until the document changes; depth, range and subtree views are one-shot selections, not lossy rewrites of the page.
- **Work across tabs.** Read, navigate and act on explicit tab references. Per-Key queues and tab/window/global occupation help cooperating Agents avoid conflicting edits.
- **Take the result with you.** One-command MHTML saving, viewport screenshots, transparent element images for Canvas or charts, resource transfer and HTML demonstrations without a local web server.
- **Choose the right input.** DOM actions, Windows native clicks and keyboard input, and independent virtual mouse/keyboard commands serve different interactions. Optional CDP adds debugging when you need it.
- **Check outcomes, not just dispatch.** `ensure.run` combines conditions, bounded waiting/preparation, an action and an observable goal. Unknown outcomes stay unknown; non-repeat actions are not blindly replayed.

## Get started

> Every fresh installation creates the same **public Root trial Key**, documented in the Agent skill. It is not a private credential. For a personal browser, create a private Key, switch clients to it, then revoke the trial Key. Creating a replacement alone does not disable it. Updates do not inject or restore it.

1. Requires Chromium **138+**, a Windows or Linux x64 App, and **Node.js 20+** for the CLI. Download both archives from the [latest release](https://github.com/BIOcanse/Browser-Key-Automation/releases/latest) and extract them separately.

   - `browser-key-automation-extension-v0.0.0.5.zip`
   - `browser-key-automation-local-app-v0.0.0.5.zip`

2. Load the extension directory containing `manifest.json` at `chrome://extensions` → Developer mode → Load unpacked. Open its toolbar page to manage Keys. Enable **Allow User Scripts** in extension details for `js.execute`; DOM and tree commands do not need that switch.

3. Start the App for your platform using the commands below. Keep `virtual-mouse-hook.dll` beside the Windows executable. The extension retries the default `127.0.0.1:32189` connection about every 10 seconds.

```text
# Windows
.\windows-x86_64\browser-key-relay.exe

# Linux
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

4. Install or load the packaged `skill/browser-key-automation/SKILL.md` in your Agent. Enumerate instances, choose the intended browser, and supply your private Key through `BKA_API_KEY`, never a command-line argument. Do not try a Key against every instance.

```text
node client/browser-key-cli.mjs instances
node client/browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json "{}"
```

## From a page to a result

Use `system.describe` to discover the active build and your permissions. Read exact parameters in the [command registry](dev/skills/browser-key-automation/references/commands.registry.json), rather than guessing selectors or reference shapes.

| | API / CLI |
| --- | --- |
| Explore → select → expand | `tabs.list` → `page.tree.open` → `page.tree.find` / `page.tree.expand.v2` → `page.tree.view.get` |
| Wait for a page condition | `page.wait` · `ensure.run` |
| Save page / viewport / element | `page-save` · `page-shot` · `element-shot` |
| Upload and display HTML | `demo-open` |
| DOM / native click | `dom.click` · `dom.click.real` |
| Exact text / shortcuts / release held keys | `keyboard.type` · `keyboard.typeHuman` · `keyboard.press` · `keyboard.reset` |
| Virtual cursor / keyboard | `virtualMouse.*` · `virtualKeyboard.*` |
| Measure the native target | `input.calibrate` |
| Explicit CDP session | `debugger.attach` → `debugger.send` → `debugger.events.get` → `debugger.detach` |

```text
node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml
node client/browser-key-cli.mjs element-shot --node-ref <NodeRef> --width 800 --height 600 --output ./element.png
node client/browser-key-cli.mjs demo-open ./demo.html
```

## Keys and input boundaries

- Root receives all active permissions; Regular Keys use expandable permission groups, expiry, reveal, disable and revoke controls. JavaScript and native input remain parallel permissions. A powerful Key is browser access, not permission to pay, publish or delete on someone's behalf.
- Virtual input is owned by the Key across tabs and requires occupation of the whole target window. Ordinary virtual-input actions use a valid `input.calibrate` result; `ensure.run` checks and refreshes calibration when needed. Physical input requires the target window in the foreground; virtual input does not move the physical cursor.
- Windows provides native input; Linux currently provides browser routing and file workflows, not native mouse or keyboard backends. Minimized windows are unsupported. First calibration needs a measurable page; covered-window reuse is conditional. Multiwindow first calibration and full native HTML5/OLE drag/drop still have unresolved cases.
- Element capture uses visible viewport content and supported shape masks, not a reconstruction of hidden pixels. Chrome controls restricted pages, site access and the User Scripts switch. Explicit `debugger.attach` retains Chrome's debugging UI. Synthetic DOM events and virtual window messages cannot bypass every website or OS input restriction.

## Where it fits

BKA focuses on low-friction access to a person's existing browser, selective page trees and integrated action/file workflows. It is not a universal replacement for test runners or every DevTools facility.

| | |
| --- | --- |
| [Playwright](https://playwright.dev/docs/intro) · [Selenium](https://www.selenium.dev/documentation/overview/) | Cross-browser tests and CI |
| [Puppeteer](https://pptr.dev/) | Programmable browser automation |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Agent tools with accessibility snapshots |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Deep browser diagnosis |
| [Browser MCP](https://browsermcp.io/) · [Chrome MCP Server](https://github.com/hangwin/mcp-chrome) | Existing-browser MCP tools |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | An in-browser Agent interface |

## Guides and maintenance

[Agent skill](dev/skills/browser-key-automation/SKILL.md) · [Operation tree](dev/skills/browser-key-automation/references/operation-tree.md) · [Ensure](dev/skills/browser-key-automation/references/ensure-workflows.md) · [Virtual input](dev/skills/browser-key-automation/references/virtual-mouse.md) · [Capture & CDP](dev/skills/browser-key-automation/references/debugger-and-element-capture.md)

The extension UI has 20 locales; repository guides have ten language variants. [Privacy](PRIVACY.md) · [Development layout](dev/README.md). Maintained by the author; external contributions and pull requests are not accepted.
