# Browser Key Automation Privacy Policy

Effective date: September 3, 2026

Browser Key Automation provides user-authorized, API-Key-scoped browser automation to trusted agents and programs. This policy describes the data handled by the Browser Key Automation Chrome extension and its separately installed local companion App.

## Data handled

The extension handles data only when needed to provide its browser-automation purpose. Depending on the page selected by the user and the command authorized by an API Key, that data may include:

- API Keys and their local management metadata, including names, identifiers, permissions, status, and optional expiration dates.
- Tab and navigation information, including tab identifiers, URLs, titles, loading state, frame information, and document identity.
- Website content and resources, including DOM structure, text, attributes, form values, resource URLs, visible viewport or selected-element screenshots, MHTML archives, and explicitly fetched page resources.
- Content already present on a selected page that may contain personally identifiable information, health information, financial or payment information, authentication information, personal communications, or location information.
- Automation inputs and results, including target references, selectors, values supplied for requested actions, wait conditions, user-provided JavaScript or demo HTML, and explicitly requested DevTools Protocol commands, events, and results.
- Local runtime state needed to prevent conflicting automation and stale references, including connection state, tab or global occupations, expansion state for operation trees, and bounded Artifacts created by explicit commands.

The extension does not continuously record human clicks, mouse position, scrolling, or keystrokes. It does not access Chrome cookies through the cookies API.

## How data is used

Data is used only to perform the browser operation explicitly requested by a Key-authenticated client, return the result to that client, maintain the user's Key configuration, prevent conflicting operations, and preserve bounded local Artifacts requested by the user. It is not used for advertising, profiling, generalized analytics, credit decisions, or unrelated research.

## Local processing and disclosure to authorized clients

The extension communicates with the companion App over the loopback address on the same computer. Browser Key Automation has no developer-operated cloud service and does not send page data, API Keys, or command results to the developer.

The user decides which clients receive an API Key. A client holding a valid Key can receive data and perform operations allowed by that Key's permissions. Such a client may process or transmit the returned data under its own terms and privacy policy. Users should review a client's data practices before sharing a Key and should grant only the permissions and validity period that client needs.

Browser Key Automation does not sell user data. It does not transfer user data to advertising platforms, data brokers, or information resellers. The developer does not permit humans to read user data except where the user gives explicit consent for specific support data, or where access is required for security or legal reasons.

## Storage and retention

API Keys, Key metadata, settings, and requested Artifacts are stored locally in the extension's browser profile. Revoking a Key prevents it from authenticating but retains its local administrative record and revealable value, as shown in the Key-management interface. These records remain until the user clears the extension's data or uninstalls the extension.

Runtime-only session and document state is discarded as the relevant browser, extension, tab, or document lifecycle ends. Artifacts are bounded by local size, count, and lifetime limits and can also be released explicitly. Ordinary command results are returned to the authorized client and are not retained on a developer server.

## Security and user controls

The product uses scoped API Keys, optional expiration, disable and revoke controls, exact tab and document references, bounded inputs and outputs, and Chrome's extension security boundaries. Explicit DevTools Protocol access has its own Key permission and retains Chrome's debugging UI; routine extension operations do not attach a debugger. The companion App accepts the extension connection only through the configured local loopback route. Chrome-restricted pages remain inaccessible to the extension.

Users can reduce or end access by changing a Key's permissions or expiration, disabling or revoking the Key, releasing saved Artifacts, stopping the companion App, clearing extension data, or uninstalling the extension.

## Chrome Web Store Limited Use

The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Changes

If the product's data practices change, the updated practices will be disclosed before the changed handling begins, and this policy's effective date will be updated.

## Contact

Support and privacy questions can be sent to biocanse@gmail.com.
