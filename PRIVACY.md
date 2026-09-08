# Privacy — Browser Key Automation

Effective date: September 7, 2026

Browser Key Automation connects Key-authenticated clients to an existing Chromium browser through an extension and a separately installed local App. There is no developer-operated cloud service, telemetry service or advertising system.

## What is handled

Depending on requested operations and Key permissions, the product handles:

- Keys, names, permissions, expiry and management settings.
- Tab URLs, titles, navigation/frame/document references and selected webpage contents, including DOM text, attributes and form values.
- Requested resources, MHTML archives, screenshots, element images, uploaded HTML demonstrations, and files explicitly transferred by a client.
- Commands and results, supplied JavaScript, CDP events/results, conditions, bounded execution traces and error diagnostics.
- Local operation-tree state, tab/window/global occupation, native-window geometry, calibration, and Key-owned virtual mouse/keyboard state.
- Saved action names, descriptions and instruction sequences; explicitly started DOM or Windows native recordings, including form input, keyboard messages, in-window pointer positions and window changes.
- Requested browser history/bookmarks and tab-search indexes; explicitly captured network requests/responses, console output, performance measurements and downloads.

Selected pages and results can contain personal information, private messages, financial or health information, location data or authentication information. Local processing is still data handling; it does not make those contents non-sensitive.

The extension does not use Chrome's cookies API. Input recording starts only through an explicit recording command or management action, within its selected scope and duration. Native recording is observed by the external App. Only pointer events in the selected window's visible, unobscured area are retained, as native pixels relative to that window; both side buttons and both wheel axes are included. Window changes are recorded independently. Keyboard events are retained while the target window has foreground input. Recordings may contain entered text and other sensitive data. Virtual-input interception separately serves virtual cursor/key state through supported APIs.

## Where data goes

The extension and App communicate over the same computer's loopback connection. Requested results go to the Key-authenticated client. Browser Key Automation does not send page contents, Keys or results to the developer, and does not sell data or use it for advertising, profiling or unrelated analytics.

A connected Agent or automation client may send results to an AI provider or another service under that client's own policies. Browser Key Automation cannot make such a client local-only. Review the client before giving it access.

**Every fresh installation creates the same publicly documented Root trial Key.** Anyone able to reach the local route and present that active Key has its full permissions. It is intended only for testing or trying the product, not protection of a personal browser. Create a private Key, switch clients and revoke the trial Key. Creating another Key alone does not disable it. Updates do not inject or restore the trial Key.

## Local storage and retention

Keys, their administrative metadata, settings and bounded Artifacts are stored in the extension's browser profile. Keys can be revealed again. Revocation prevents authentication but keeps the local administrative record and revealable value until extension data is cleared or the extension is uninstalled.

The action library is shared within one extension instance. Recordings belong to the selected Key, have explicit retention bounds, and can be stopped and deleted. Compiling or deleting a recording does not delete an action already saved from it. Captures and search indexes use their command-specific local limits; requested files and exported data remain with their recipients.

Document references and tree data follow the relevant document lifecycle. Input state is owned by the Key and can persist across tab changes and extension worker restarts; explicit reset/release and runtime cleanup rules apply. Artifacts and execution traces have local count, size and lifetime bounds. The App holds live routing and native-input state, not a separate Key database.

Files saved to disk remain until the user deletes them. Clients control their own copies of returned data. Stopping the App or revoking a Key does not erase those copies.

## Controls and boundaries

Commands are authenticated once when submitted. Later Key expiry, disabling, revocation or permission edits affect new submissions; they do not cancel commands already queued or running. Accepted recordings and capture sessions use their requested duration and explicit stop controls. Input resources remain subject to explicit reset/release and runtime cleanup.

Use permission groups and individual permissions, expiry, disable or revoke to limit access. Reset held input state, release occupations and Artifacts, stop the App or disable/uninstall the extension to end the corresponding operation paths. Avoid clearing or stopping components while an input gesture is intentionally held; release/reset first when possible.

Root does not bypass Chrome's restricted pages, site-access controls or User Scripts switch. Explicit debugger access is separate and retains Chrome's debugging UI. A technically valid Key does not substitute for consent to consequential actions.

## Limited Use

The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements. See [Chrome's user-data guidance](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).

The developer does not permit human access to user data except with explicit consent for specific support material, or when necessary for security or legal reasons. Do not include Keys or private page captures in public support reports.

## Contact and updates

Contact: biocanse@gmail.com. If data practices change, this policy and its effective date will be updated before the changed handling begins.
