# Wait and save

## Page waits

`page.wait`, schema version 1, requires the independent `page.wait` permission. Examples of params:

```json
{ "tabRef": "<tab>" }
{ "tabRef": "<tab>", "until": "committed", "url": "https://example.com/" }
{ "tabRef": "<tab>", "until": "domcontentloaded" }
{ "tabRef": "<tab>", "until": "complete", "timeoutMs": 30000 }
{ "tabRef": "<tab>", "until": "visible", "selector": "#result" }
{ "tabRef": "<tab>", "until": "text", "selector": "#status", "text": "Done" }
```

| until | Satisfied when |
|---|---|
| `committed` | An active main Document has committed and no uncommitted navigation is pending; resources may still load. |
| `domcontentloaded` | DOMContentLoaded was reached for that Document, or it is already complete. `interactive` alone is insufficient. |
| `complete` (default) | Current main document and tab report complete. Not SPA data readiness or network idle. |
| `url` | Current committed URL exactly equals required `url`. |
| `present` / `absent` | First CSS match exists / no match exists. |
| `visible` | First match has layout rectangles and is not display/visibility-hidden. Not a guarantee of viewport position, lack of occlusion, or clickability. |
| `enabled` | First match is neither natively disabled nor `aria-disabled="true"`. |
| `text` | First match's textContent contains the specified text, case-sensitively. |

Node conditions require `selector`; text also requires `text`. Optional `url` restricts every mode to an exact committed URL. Pending navigation cannot be satisfied by the old complete Document. Waiting follows the current main Document of the same live TabRef; document changes do not reset the original deadline. Close/replace/runtime invalidation is an error, never a reason to select another tab.

Current build: default 10,000 ms; explicit range 1–60,000 ms; 100 ms between observations. These are declared build Freedom Points. The first observation is immediate. Actual timing depends on Chrome/OS scheduling; background page timers can be delayed.

Returns `already_satisfied`, `satisfied`, or `timed_out`, with elapsedMs, message and last observation. Already satisfied means no extra waiting or page action was needed. Timeout means not observed in time, not failure of the previous action. No mode navigates, clicks, retries actions or creates a persistent task. Explicit node/text waits still work after complete.

## One-call webpage save

From the unpacked local App directory, with the Key already in its environment variable:

```text
node client/browser-key-cli.mjs page-save --tab-ref <TabRef> --output ./page.mhtml
node client/browser-key-cli.mjs artifact-save --artifact-ref <ArtifactRef> --output ./result.bin
```

For multiple instances include `--instance <relayEpoch/instanceNumber>`. One instance/Key is fixed for the whole capture/read sequence. `page-save` needs `page.archive.capture` and `artifact.read`, not `system.read`. It does not silently wait for complete; request page.wait first only if needed.

The same implementation is directly callable:

```js
import { savePage } from "./client/browser-key-cli.mjs";
const saved = await savePage({ tabRef, output: "./page.mhtml" });
// saved.output, saved.byteLength, saved.sha256, saved.artifactRef
```

The format is browser-generated single-file MHTML of the live page/resources, not original response bytes or a guarantee that every remote resource was captured. The returned path is a real file verified by length/SHA-256. Its parent directory must exist. Existing files are never overwritten. Same-directory hard-link publication requires a supporting filesystem such as NTFS/ext4. Saving failure retains the ArtifactRef: retry its local transfer with artifact-save, rather than recapturing. A lost capture response remains unknown and must not trigger automatic replay. Helpers do not release Artifacts; release explicitly when no longer needed.

## Omission defaults

`tabs.list` accepts `{}`. `frames.list`, `dom.query`, `page.resources.list` may omit limit. `artifact.read` may omit offset/maximumBytes. `dom.focus` may omit preventScroll (true); `dom.scroll` may omit behavior/block/inline (auto/center/nearest). Configurable defaults are generated and expanded once in the extension, not copied into the CLI.
