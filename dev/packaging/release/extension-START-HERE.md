# Browser Key Automation — Extension

Version: `{{VERSION}}`
Extension ID: `{{EXTENSION_ID}}`

Use your existing signed-in Chromium tabs through Keys, selective page trees, browser actions, files and optional debugging.

## Install

1. Use Chromium 138 or later. Extract this archive completely.
2. Open `chrome://extensions`, enable Developer mode and choose **Load unpacked**.
3. Select the directory directly containing `manifest.json`. The extension ID must match the one above.
4. Enable **Allow User Scripts** in extension details for `js.execute`. The browser owns this switch; DOM and tree commands do not require it.
5. Open the toolbar icon to manage Keys and permission groups.
6. Download `{{APP_PACKAGE}}.zip` from the same release, extract it separately and follow its `START-HERE.md`.

**A fresh installation includes the same public Root trial Key for everyone.** It is for testing or trying the product only. In a personal browser, create a private Key, switch clients, then revoke the trial Key. Creating another Key does not disable it. Updates do not inject or restore it. The public value is documented in the bundled Agent skill.

The extension retries the local App connection about every 10 seconds. Its management page's background connection is not proof that the App is ready; use the App CLI's `instances` command.

## Access and operation

The extension authenticates Keys and enforces browser permissions. Give private Keys only to trusted clients. Root has all active permissions; Regular Keys can be configured through expandable groups and individual permissions.

Routine commands do not attach a debugger. Explicit `debugger.attach` retains Chrome's debugging UI. Native Windows input is separate from DOM actions; virtual input requires whole-window occupation and valid calibration. Restricted browser pages and OS input boundaries still apply.

GitHub archives are for manual installation. Chrome Web Store distribution uses a separate package and review process.

`SHA256SUMS.txt` covers every file except the checksum list itself. See the repository's README and PRIVACY.md for workflow and data-handling details.
