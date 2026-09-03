# Registry Authoring Rules

These four JSON registries are the authoring source for commands/permissions/schemas, build/runtime Freedom Points, extension errors and Chromium capabilities. The local transport profile owns its wire constants; the Zig relay does not load business registries or authorize Keys.

## Current generation

The active API has 51 commands and 41 independent permissions. `page.wait` has its own permission, `page.tree.find` shares `page.tree.read`, and `dom.click.real` is independent from ordinary `dom.click`. The four explicit debugging commands share the independent `debugger` permission; `page.screenshot.element` reuses `page.screenshot.capture`. Root evaluates every currently active atom as true; regular Keys keep their explicit grants.

- `generate-command-config.mjs` checks sorted unique active IDs, active references, closed top-level schema fields, permission use, declared consumer paths, and exact manifest API/host projections. It generates the extension catalog, limits and parameter defaults, and synchronizes the skill's two registry copies.
- `generate-transport-config.mjs` projects the same bind/profile into extension TypeScript, relay Zig and client JavaScript, and checks the fixed extension Origin/CSP. Source/config content build IDs identify extension and relay inputs; they are not executable hashes. The package SHA256 manifests identify actual output bytes.
- Generated files and skill registry copies are outputs, never parallel authoring sources.
- A listed consumer path is not a proof that the implementation reads a value. Mutation tests must show important defaults and endpoint changes reaching consumers. There is no repository-wide semantic source scanner.

## Parameter omission and Freedom Points

A field with a default must have `required: false` and exactly one of:

- `defaultFromFreedomPoint`: reference an active bounded integer, typed string/enum, or boolean point also present in the command's `limitRefs`.
- `defaultValue`: fixed protocol meaning, such as a null starting cursor, zero Artifact/event offset, or empty CDP params object, not a tunable copy.

The generator validates the default's parameter type/value. The extension parser merges defaults once and validates the complete request; explicit false/zero/null values are not silently replaced. The injected tree-view boundary separately normalizes omitted nullable projection options because Chromium can omit null object members.

Build points belong to `build_profile`, require `rebuild` and cannot be changed through settings. Runtime Artifact settings remain extension-owned and initialize from generated defaults. Point bounds and actual cross-budget relations are checked during generation. Changing a point must preserve its safety contract and real consumer behavior.

## Permissions, state and results

Authentication and business authorization happen only in the extension. Same-Key requests use the existing serial lane; a finite wait does not create a task, action receipt, lease, navigation cache or retry queue. Tree find uses the existing document tree and never expands nodes.

Only explicit `control.acquire` and `control.release` are supported. No hidden takeover, per-command occupation, OperationId, accepted/progress protocol, or effect replay is implied by legacy descriptor fields. Admin mutation IDs retain their already-implemented Key-management semantics.

`keys.create/reveal` deliberately return the locally retained token to an authorized caller. CLI diagnostic output redacts full tokens. Keep this retained-token contract; do not implement one-time-only secret display.

## Validation limits

Strict JSON syntax, active ordering/references, declared typed defaults, bounds, budget checks and manifest projections are implemented. General decoded duplicate-key/unknown-field meta-schema checks and complete source-consumer reverse analysis are not. Keep identifiers canonical, do not reuse retired IDs, and verify changed paths with tests.

`active` means implemented, generated and routed; it is not a planning wishlist. Chromium runtime capabilities still require runtime evidence.
