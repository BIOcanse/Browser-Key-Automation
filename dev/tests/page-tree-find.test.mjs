import assert from "node:assert/strict";
import test from "node:test";
import { treeHarness, element, textNode } from "./lib/page-tree-harness.mjs";

test("find searches collapsed canonical branches but neither Key's expansion changes", async () => {
  const button = element("BUTTON", [textNode("Submit")]);
  const fixture = treeHarness([element("MAIN", [element("SECTION", [button])])]);
  const { rootRef } = await fixture.open();
  const beforeA = await fixture.view(rootRef); const beforeB = await fixture.view(rootRef, {}, "B");
  const found = await fixture.find(rootRef, { selector: "button", role: "button", text: "Submit" });
  assert.equal(found.items.length, 1); assert.deepEqual(Array.from(found.items[0].indexPath), [0, 0, 0]);
  assert.match(found.items[0].nodeRef, /^nr1\./); assert.match(found.items[0].treeRef, /^tr2\./);
  assert.deepEqual((await fixture.view(rootRef)).items, beforeA.items);
  assert.deepEqual((await fixture.view(rootRef, {}, "B")).items, beforeB.items);
  const direct = await fixture.view(rootRef, { subtree: found.items[0].indexPath });
  assert.equal(direct.items[0].treeRef, found.items[0].treeRef);
  assert.equal(found.truncated, false);
});

test("bounded find resumes inclusively from nextIndexPath and returns every match exactly once", async () => {
  const fixture = treeHarness([element("MAIN", Array.from({ length: 7 }, (_, n) => element("BUTTON", [textNode(`B${n}`)])))],
    { "command.page.tree.maximum_find_scan_nodes": 3 });
  const { rootRef } = await fixture.open(); const paths = []; let from;
  for (let page = 0; page < 12; page += 1) {
    const result = await fixture.find(rootRef, { selector: "button", limit: 1, ...(from ? { from } : {}) });
    paths.push(...result.items.map((item) => Array.from(item.indexPath)));
    if (!result.truncated) { from = null; break; }
    assert.ok(result.nextIndexPath); from = Array.from(result.nextIndexPath);
  }
  assert.equal(from, null);
  assert.deepEqual(paths, Array.from({ length: 7 }, (_, n) => [0, n]));
  assert.equal((await fixture.view(rootRef)).items.length, 1);
});

test("find subtree, explicit filters, stale cursor and CSS errors remain bounded and non-mutating", async () => {
  const fixture = treeHarness([element("MAIN", [element("BUTTON", [textNode("one")]), element("BUTTON", [textNode("two")])])]);
  const { rootRef } = await fixture.open();
  const scoped = await fixture.find(rootRef, { subtree: [0, 1], text: "two", selector: "button" });
  assert.deepEqual(Array.from(scoped.items[0].indexPath), [0, 1]);
  assert.equal((await fixture.find(rootRef, { text: "absent" })).items.length, 0);
  await assert.rejects(fixture.find(rootRef, { selector: "[" }), (error) => error.code === "DOM_OPERATION_FAILED");
  await assert.rejects(fixture.find(rootRef, { subtree: [0, 1], from: [0, 0], text: "two" }), (error) => error.code === "TARGET_REF_STALE");
  await assert.rejects(fixture.find(rootRef, { from: [99], text: "one" }), (error) => error.code === "TARGET_REF_STALE");
});

test("find descends into an open shadow root when its host has no ordinary children", async () => {
  const host = element("X-PANEL");
  const button = element("BUTTON", [textNode("Shadow action")]);
  host.shadowRoot = { nodeType: 11, nodeName: "#document-fragment", nodeValue: null,
    childNodes: [button], host, mode: "open", parentNode: null, isConnected: true };
  button.parentNode = host.shadowRoot;
  const fixture = treeHarness([host]);
  const { rootRef } = await fixture.open();
  const before = await fixture.view(rootRef);
  const found = await fixture.find(rootRef, { selector: "button" });
  assert.equal(found.truncated, false);
  assert.deepEqual(Array.from(found.items, (item) => Array.from(item.indexPath)), [[0, 0, 0]]);
  assert.match(found.items[0].nodeRef, /^nr1\./);
  assert.deepEqual((await fixture.view(rootRef)).items, before.items);
});

test("find includes attributes, live properties and long-value chunks despite zero native childCount", async () => {
  const attributeOwner = element("INPUT");
  const attribute = { nodeType: 2, nodeName: "data-test", name: "data-test", value: "a".repeat(40) + "needle-attribute",
    nodeValue: null, childNodes: [], parentNode: null, ownerElement: attributeOwner, isConnected: false };
  attributeOwner.attributes = [attribute];
  attributeOwner.getAttribute = (name) => name === attribute.name ? attribute.value : null;
  attributeOwner.getAttributeNode = (name) => name === attribute.name ? attribute : null;
  attributeOwner.hasAttribute = (name) => name === attribute.name;
  const liveOwner = element("INPUT");
  liveOwner.value = "v".repeat(40) + "needle-property";
  const doctype = { nodeType: 10, nodeName: "html", nodeValue: null, childNodes: [],
    parentNode: null, isConnected: true, systemId: "d".repeat(40) + "needle-doctype" };
  const fixture = treeHarness([attributeOwner, liveOwner, textNode("t".repeat(40) + "needle-text"), doctype],
    { "command.page.tree.maximum_preview_characters": 32 });
  const { rootRef } = await fixture.open();
  const found = await fixture.find(rootRef, { text: "needle" });
  assert.equal(found.truncated, false);
  assert.deepEqual(Array.from(found.items, (item) => [Array.from(item.indexPath), item.kind]), [
    [[0, 0, 1], "value_chunk"], [[1, 0, 1], "value_chunk"], [[2, 1], "value_chunk"], [[3, 1], "value_chunk"],
  ]);
});

test("label scans fetch only budgeted descendants even on a hundred-thousand-child node", async () => {
  const wide = element("MAIN");
  let indexedReads = 0;
  wide.childNodes = new Proxy({ length: 100000 }, { get(target, key) {
    if (typeof key === "string" && /^\d+$/.test(key)) { indexedReads += 1; return textNode("wide"); }
    return Reflect.get(target, key);
  } });
  const fixture = treeHarness([wide], {
    "command.page.tree.maximum_label_scan_nodes": 1,
    "command.page.tree.maximum_find_scan_nodes": 1,
  });
  const { rootRef } = await fixture.open();
  assert.equal((await fixture.view(rootRef)).items[0].label, null);
  assert.equal(indexedReads, 0, "one-node label budget must not read any children");
  const found = await fixture.find(rootRef, { selector: "main", limit: 1 });
  assert.equal(found.items.length, 1); assert.equal(found.truncated, true);
  assert.deepEqual(Array.from(found.nextIndexPath), [0, 0]);
  assert.equal(indexedReads, 1, "only one lookahead child is needed for the continuation path");
});
