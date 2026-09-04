# Strict conditions and `ensure.run.v1`

Use `ensure.run` when one browser effect has a concrete, observable result and the task benefits from bounded waiting, target re-resolution, or lazy-page scrolling. The extension—not the relay or CLI—owns the workflow. The entire call stays in the caller Key's serial lane.

Ordinary commands remain strict one-shot primitives. A strict condition block observes its precondition once, performs no preparation, and sends its action once only when the condition is true. An ensure block shares one finite deadline across observations, preparation, the action, and verification.

Use this Agent-facing shorthand when reasoning about a call:

```text
condition { action }
ensure(goal) { condition { action } }
ensure { action-with-a-derived-or-result-goal }
```

The first form compiles to `mode:"strict"`; the other two compile to `mode:"ensure"`. `if(tabRef, world, code, timeoutMs) { action }` is the explicit JavaScript-condition escape hatch, not a prefix required for ordinary shortcut conditions. Braces are notation for the Agent, not wire syntax: always compile them to the closed JSON request below and send it through the generic native client.

## Safety contract

- `workflow.run` only permits entry into the workflow executor. Every condition, locator resolution, automatic scroll, JavaScript predicate, and action checks its own permission immediately before use.
- There is no automatic switch to `.real`, JavaScript, debugger, a broader permission, or another Key's occupation.
- An exact NodeRef either resolves to that exact live element or fails stale. Only an explicit locator may resolve again.
- A non-repeat action is sent at most once. If it may have run but the goal cannot be verified, the workflow returns `unknown`; never replay it automatically.
- Only registry-declared safe actions may repeat. Initially these are `dom.setValue`, `dom.select`, and `dom.scroll`.
- Custom JavaScript conditions must be side-effect-free and must return an actual boolean. They require `js.execute` and can be evaluated repeatedly.

## Request shape

Call the ordinary CLI command surface with method `ensure.run`, schema version `1`, and a closed params object:

```json
{
  "mode": "ensure",
  "timeoutMs": 10000,
  "scrollIntoView": true,
  "searchByScrolling": true,
  "precondition": {
    "kind": "ready",
    "target": {
      "kind": "locator",
      "tabRef": "<TabRef>",
      "framePath": [],
      "selector": null,
      "role": "button",
      "name": "Log in",
      "nameMatch": "exact",
      "match": "unique"
    }
  },
  "goal": {
    "kind": "url_matches",
    "tabRef": "<TabRef>",
    "pattern": "*/dashboard"
  },
  "action": {
    "method": "dom.click",
    "schemaVersion": 1,
    "target": {
      "kind": "locator",
      "tabRef": "<TabRef>",
      "selector": null,
      "role": "button",
      "name": "Log in",
      "nameMatch": "exact",
      "match": "unique"
    },
    "params": {}
  }
}
```

Node-target actions put `target` on the action and must not also put `nodeRef` in `action.params`. Other actions omit `target`. Locators require at least one non-null `selector`, `role`, or `name`; all supplied constraints are ANDed. `match` and `nameMatch` are always explicit.

`framePath` is optional and defaults to the main document. Each segment is `{ "urlPattern": "<Unicode * / ? glob>", "match": "unique" | "first" }`; omitted segment `match` means `unique`. The extension resolves only direct child frames at each step and re-resolves the current chain on every observation. `first` deterministically means the lowest current Chromium frameId, not DOM order; prefer `unique` on changing pages. It resolves a locator action again immediately before the effect and executes through the resulting exact NodeRef. This is what lets one locator survive iframe navigation or replacement; never cache or synthesize a frame/document ID in the Agent. A final exact-reference race remains explicit stale/unknown and must not be retried automatically.

For `mode:"strict"`, `precondition` is required and `goal` must be `null`. A false condition returns top-level `CONDITION_NOT_MET` with no action or preparation.

For `mode:"ensure"`, actions classified as `explicit_goal` require `goal`. The extension derives goals for:

- `dom.setValue` → `value_is`
- `dom.select` → `selected_values_are`
- `dom.focus` → `focused`
- `tabs.activate` → `tab_active`

Actions classified as `result` need no goal because their successful registered result is completion. An explicit goal may still be supplied when stronger verification is wanted.

## Conditions

Composite:

```json
{ "kind": "all", "conditions": ["<condition>", "<condition>"] }
{ "kind": "any", "conditions": ["<condition>", "<condition>"] }
{ "kind": "not", "condition": "<condition>" }
```

Target conditions use `target`: `present`, `visible`, `enabled`, `unobstructed`, `stable`, `ready`, `focused`, `value_is` (`value`), `selected_values_are` (`values`), and `text_contains` (`text`). `ready` means present, visible, enabled, unobstructed, and stable for the configured stability window.

Page conditions:

```json
{ "kind": "url_matches", "tabRef": "<TabRef>", "pattern": "*/done" }
{ "kind": "loaded", "tabRef": "<TabRef>", "state": "complete" }
{ "kind": "tab_active", "tabRef": "<TabRef>" }
{ "kind": "javascript", "tabRef": "<TabRef>", "world": "USER_SCRIPT", "code": "document.readyState === 'complete'", "timeoutMs": 1000 }
```

URL patterns use only linear `*` and `?` glob semantics, not regular expressions.

## Read the result

- `satisfied`: the goal was observed true, or a result-class action returned successfully. If the goal was already true, `effectSent` is false.
- `failed`: no effect was sent and the condition/target/permission could not be established, or a safely repeatable action completed but did not reach its goal before the deadline.
- `unknown`: an action entry was started but its final result could not be established. Do not retry automatically.

Use `stage`, `effectSent`, `effectAttempts`, `observedCondition`, `matchedNodeRef`, preparation counters, and `error` as evidence. `effectSent` means the registered effect entry was called; it does not claim the website's business result occurred.

With `searchByScrolling:true`, a missing locator is searched inside its resolved target document. One preparation step scans a bounded set of independently scrollable nested elements in document order plus the document root, moves at most one context, then observes again. The per-call cursor is scoped to the current document and a token derived from live scroll-container identities/order; navigation or same-size container replacement resets it to the first context. Virtualized children and replaced containers are therefore discovered from fresh DOM state. `searchAttemptCount` counts bounded probes and `searchScrollCount` counts actual moves. The search never rewinds the page and never crosses into an iframe that was not named by `framePath`.
