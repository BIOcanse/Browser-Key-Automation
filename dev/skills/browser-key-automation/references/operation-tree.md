# Operation tree

Use this flow for page discovery. It is selection-by-expansion, not deletion-based cleaning and not a priority/quick-access list.

## Open

```json
{
  "method": "page.tree.open",
  "schemaVersion": 1,
  "params": { "targetRef": "<TabRef or DocumentRef>" }
}
```

The result returns the exact DocumentRef and its unique `rootRef`. Reopening the same live document returns the same root with `reused: true`. Switching tabs or inspecting another frame does not erase it; document replacement makes old TreeRefs stale.

## View

```json
{
  "method": "page.tree.view.get",
  "schemaVersion": 1,
  "params": { "rootRef": "<root TreeRef>" }
}
```

The initial view is strict level 0: the Document's direct children, normally doctype and HTML. Collapsed nodes remain visible as one row with `attributeCount`, `childCount`, `role`, `label`, `states`, and bounded `valuePreview`.

Optional one-shot projections:

```json
{ "rootRef": "<root>", "maximumLevel": 1 }
{ "rootRef": "<root>", "subtree": [1, 1, 2] }
{ "rootRef": "<root>", "range": { "from": [1, 1, 0], "toExclusive": [1, 1, 25] } }
```

- `maximumLevel` returns only already-visible rows from absolute level 0 through N. It never expands a node.
- `subtree` starts at one canonical index without changing ancestor expansion.
- `range` is a half-open interval of siblings under the same parent and does not include their descendants.
- View requests are stateless: no ViewId or server cursor is created. `truncated` applies only to that response.

## Expand

Take a row's exact TreeRef and call:

```json
{
  "method": "page.tree.expand",
  "schemaVersion": 2,
  "params": { "treeRef": "<row TreeRef>" }
}
```

Expand only marks that node for the authenticated Key and returns `expanded: true`; it does not return child rows. Call `page.tree.view.get` again to see the new outline. Repeated expand is idempotent. There is no collapse/reset command in this version.

Expansion state is isolated by KeyId: clients sharing one Key share state, while another Key starts with its own collapsed outline. The canonical nodes/TreeRefs are not duplicated per Key.

## Find without expanding

```json
{ "method": "page.tree.find", "schemaVersion": 1, "params": { "rootRef": "<root>", "selector": "button", "text": "Submit", "limit": 20 } }
```

Supply at least one of `text`, `role`, `selector`; filters combine with AND. Text is a case-sensitive substring of the canonical item's label/value preview, not semantic search or full descendant-text matching. Role is exact; CSS matches element rows. This searches the same Document, including collapsed branches and observable open shadow roots, without entering separate iframe Documents or changing expansion.

Results use the original indexPath/TreeRef/NodeRef. Optional `subtree` bounds the search. When truncated with non-null `nextIndexPath`, repeat the same filters with `from: nextIndexPath`; the start is inclusive and seeks directly. Structural indices can become stale if the DOM changes; no search snapshot/cache is created. A hard depth bound can report truncation with no resumable cursor. Phrases spanning value chunks are not guaranteed text matches; read the chunks for exact full content.

## Values and operations

Tree order is attributes → differing live properties → open ShadowRoot → DOM childNodes. `indexPath` is the row's current live structural location; TreeRef is the exact operation reference.

When a raw value is longer than `valuePreview`, the row retains a TreeRef. Expand it and read its ordered `value_chunk` children; join `valuePreview` in `sourceOrder` to recover the exact value. Do not substitute the folded preview for the full value.

Use a returned NodeRef for `dom.*` actions. A TreeRef itself is only for operation-tree expansion/view routing.

For a wide parent that truncates an overall response, read bounded sibling ranges. For a deep known branch, use `subtree`. Neither operation changes expansion state.
