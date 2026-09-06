# Development layout

Runtime code is separated from authoring and verification:

| Directory | Responsibility |
| --- | --- |
| [app/](../app/) | Zig relay, native Windows input, reusable virtual-input primitives and shared CLI |
| [extension/](../extension/) | Chromium permissions, Key authentication, page references, operation trees and browser commands |
| [dev/registries/](registries/README.md) | Commands, permissions, schemas, UI translations, capabilities and Freedom Points |
| [dev/tools/](tools/) · [dev/tests/](tests/) | Generators, builds, packaging, unit tests and isolated browser/native probes |
| [dev/skills/](skills/browser-key-automation/SKILL.md) | Agent guide shipped with the App |
| [dev/packaging/](packaging/) · [dev/assets/](assets/) | Installation text and visual assets |

Local design notes and raw test evidence are not public package dependencies. Runtime consumers do not read this development tree.

## Build and verify

Use Node.js 20+ and Zig 0.16.0. Run from the repository root:

```text
npm ci
npm run build
npm run test:unit
npm run test:github-release-package
```

On Windows, run unattended builds/tests through the non-interactive launcher to suppress native crash dialogs:

```powershell
pwsh -NoProfile -File dev/tools/run-noninteractive.ps1 npm.cmd run test:unit
```

`build:extension` generates configuration before TypeScript compilation. `build:relay:release` cross-builds Windows/Linux x64. `build:github-release` produces exactly two archives: the extension with `manifest.json` at its root, and the App with both platform binaries plus shared CLI, protocol and skill.

Edit registries and the transport profile, then run `npm run generate`; do not hand-edit generated consumers. Ignored build outputs are recreated by the normal release route.

## Browser and native checks

`test:extension-smoke`, `test:relay-smoke` and `test:client-cli-smoke` use isolated fixtures. `test:runtime` is the broad integration route, not a claim that every native scenario is currently passing.

On Windows x64, `test:virtual-mouse` exercises primitives and an isolated native window; `test:virtual-mouse:browser` adds disposable Chromium. Foreground input checks require their explicit `--real-input` option. Never use a personal profile for these tests.

Minimized input is unsupported. Multiwindow initial calibration and full native HTML5/OLE drag/drop still have unresolved cases; Linux graphical/native-input acceptance is not claimed. Preserve these distinctions in reports.

Keep `virtual-mouse-hook.dll` beside the Windows relay. Third-party notices are in [app/third_party/](../app/third_party/) and included in the App archive. Builds and raw evidence belong in `out/` or `zig-out/`, not commits or public archives.

The project is maintained by its author and does not accept external contributions or pull requests.
