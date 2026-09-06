# Browser Key Automation — Local App

Version: `{{VERSION}}`

This package connects an Agent to the separately installed Chromium extension. It contains Windows and Linux x64 binaries plus one shared CLI, protocol and Agent skill. Key authentication and browser permissions are enforced by the extension; the App routes requests and provides supported native input.

## Start

Extract the whole archive to a stable directory. Do not run files inside the ZIP.

Windows x64:

```powershell
.\windows-x86_64\browser-key-relay.exe
```

Linux x64:

```bash
chmod +x ./linux-x86_64/browser-key-relay
./linux-x86_64/browser-key-relay
```

Keep `virtual-mouse-hook.dll` next to the Windows executable. Windows includes native click, keyboard and virtual input. Linux provides browser routing and file workflows, not native input backends.

The default endpoint is `127.0.0.1:32189`. Keep the App running. If a compatible App already owns that endpoint, do not start a second copy. The extension retries about every 10 seconds.

## Connect an Agent

The CLI requires Node.js 20+. Install or load `skill/browser-key-automation/SKILL.md`; its references contain exact commands and limits.

```text
node client/browser-key-cli.mjs instances
```

Enumeration needs no Key. With no instances, check the extension and wait for reconnection. With multiple instances, choose the intended current InstanceRef; never test a Key against every browser.

Provide a private Key through the `BKA_API_KEY` environment variable, not a CLI argument. A fresh extension includes a **public Root trial Key** documented in the skill. In a personal browser, create a private Key, switch clients and revoke the trial Key; creating another Key alone does not disable it.

```text
node client/browser-key-cli.mjs call --method system.describe --schema-version 1 --params-json "{}"
node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml
node client/browser-key-cli.mjs page-shot --tab-ref <TabRef> --output ./page.png
node client/browser-key-cli.mjs element-shot --node-ref <NodeRef> --width 800 --height 600 --output ./element.png
node client/browser-key-cli.mjs demo-open ./demo.html
node client/browser-key-cli.mjs stop
```

An unknown delivery result is not proof of failure: do not blindly retry effectful commands. `stop` shuts down the App, but does not revoke Keys or release extension occupations.

## Native-input boundaries

Virtual input belongs to the Key across tabs and requires whole-window occupation. Call `input.calibrate` before ordinary virtual input; `ensure.run` checks and refreshes calibration when needed. Physical input requires the target window in the foreground. Virtual input does not move the physical cursor.

Minimized windows are unsupported. Initial calibration needs a measurable page; reuse under occlusion is conditional. Multiwindow initial calibration and full native HTML5/OLE drag/drop have unresolved cases. Read the bundled virtual-input guide before use.

The App is unsigned; operating systems may show a source warning. Third-party notices are in `licenses/`. `SHA256SUMS.txt` covers every packaged file except itself.
