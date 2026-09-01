import assert from "node:assert/strict";
import test from "node:test";
import { treeHarness, element, textNode, routePrefix, syntheticRef, turn, deferred } from "./lib/page-tree-harness.mjs";

const paths = (result) => Array.from(result.items, (item) => Array.from(item.indexPath));
const stale = (error) => error.code === "TARGET_REF_STALE";

test("long doctype identifiers have expandable lossless value chunks", async () => {
  const systemId = "a".repeat(250) + "😀".repeat(200);
  const fixture = treeHarness([{ nodeType: 10, nodeName: "html", nodeValue: null,
    childNodes: [], isConnected: true, parentNode: null, publicId: "", systemId }]);
  const { rootRef } = await fixture.open();
  const item = (await fixture.view(rootRef)).items[0];
  assert.equal(item.valueTruncated, true);
  assert.ok(item.treeRef);
  await fixture.expand(item.treeRef);
  const expanded = await fixture.view(rootRef, { subtree: [0] });
  const full = expanded.items.filter((child) => child.kind === "value_chunk").map((child) => child.valuePreview).join("");
  assert.equal(item.name, "html");
  assert.equal(full, `SYSTEM ${systemId}`);
  assert.ok(expanded.items.slice(1).every((child) => !child.valueTruncated));
});

test("sibling range seeks beyond 20,000 nodes and never expands a collapsed ancestor", async () => {
  const fixture = treeHarness([element("DIV", Array.from({ length: 20_005 }, (_, index) => textNode(`row-${index}`)))]);
  const { rootRef } = await fixture.open();
  const div = (await fixture.view(rootRef)).items[0];
  const range = { from: [0, 20_000], toExclusive: [0, 20_005] };
  assert.equal((await fixture.view(rootRef, { range })).items.length, 0);
  await fixture.expand(div.treeRef);
  const tail = await fixture.view(rootRef, { range });
  assert.deepEqual(paths(tail), [20_000, 20_001, 20_002, 20_003, 20_004].map((index) => [0, index]));
  assert.equal(tail.items[0].valuePreview, "row-20000");
  assert.equal(tail.truncated, false);
  assert.equal(tail.nextIndexPath, null);
  assert.equal((await fixture.view(rootRef, { range }, "B")).items.length, 0, "Key B stays collapsed");
  assert.equal((await fixture.view(rootRef, { range, maximumLevel: 0 })).items.length, 0);
  assert.equal((await fixture.view(rootRef, { maximumLevel: 0 })).items.length, 1, "view filters are one-shot");
});

test("range/subtree intersection uses only already expanded descendants, without scanning them", async () => {
  const fixture = treeHarness([element("MAIN", [element("SECTION", [textNode("a"), textNode("b")]), textNode("last")])]);
  const { rootRef } = await fixture.open();
  const section = (await fixture.view(rootRef, { subtree: [0, 0] })).items[0];
  await fixture.expand(section.treeRef);
  const range = { from: [0, 0, 0], toExclusive: [0, 0, 2] };
  assert.equal((await fixture.view(rootRef, { range })).items.length, 0, "MAIN remains collapsed");
  assert.deepEqual(paths(await fixture.view(rootRef, { subtree: [0, 0], range })), [[0, 0, 0], [0, 0, 1]]);
  assert.deepEqual(paths(await fixture.view(rootRef, { subtree: [0, 0, 1], range })), [[0, 0, 1]]);
  assert.equal((await fixture.view(rootRef, { subtree: [0, 1], range })).items.length, 0);
  const main = (await fixture.view(rootRef)).items[0];
  await fixture.expand(main.treeRef);
  assert.deepEqual(paths(await fixture.view(rootRef, { range: { from: [0, 0], toExclusive: [0, 2] } })), [[0, 0], [0, 1]]);
  await assert.rejects(fixture.view(rootRef, { subtree: [99] }), stale);
  assert.ok(fixture.state.stored[routePrefix + rootRef], "invalid index must not retire a live root");
});

test("scan limit reports actual continuation and exact end is not truncated", async () => {
  const fixture = treeHarness([textNode("a"), textNode("b"), textNode("c")], { "command.page.tree.maximum_view_scan_nodes": 2 });
  const { rootRef } = await fixture.open();
  const first = await fixture.view(rootRef);
  assert.equal(first.truncated, true);
  assert.deepEqual(Array.from(first.nextIndexPath), [2]);
  const tail = await fixture.view(rootRef, { range: { from: [2], toExclusive: [3] } });
  assert.deepEqual(paths(tail), [[2]]);
  assert.equal(tail.truncated, false);
  const exact = await fixture.view(rootRef, { range: { from: [0], toExclusive: [2] } });
  assert.equal(exact.truncated, false);
  assert.equal(exact.nextIndexPath, null);
});

test("same-document churn keeps route storage bounded and retries failed retirement", async () => {
  const fixture = treeHarness([element("DIV", [textNode("first")])]);
  const { rootRef } = await fixture.open();
  let firstRef;
  for (let index = 0; index < 64; index += 1) {
    const before = fixture.document.childNodes[0];
    before.isConnected = false;
    fixture.document.childNodes = [element("DIV", [textNode(String(index))])];
    const view = await fixture.view(rootRef);
    firstRef ??= view.items[0].treeRef;
    assert.equal(fixture.routeCount(), 2);
  }
  assert.equal(fixture.context.__BKA_PAGE_TREE_REGISTRY_V2__.entries.size, 2);
  await assert.rejects(fixture.expand(firstRef), stale);
  const previous = (await fixture.view(rootRef)).items[0].treeRef;
  fixture.document.childNodes[0].isConnected = false;
  fixture.document.childNodes = [element("DIV", [textNode("replacement")])];
  fixture.state.beforeRemove = () => { throw new Error("storage unavailable"); };
  await assert.rejects(fixture.view(rootRef), (error) => error.code === "STORAGE_UNAVAILABLE");
  assert.ok(fixture.state.stored[routePrefix + previous]);
  fixture.state.beforeRemove = null;
  await fixture.view(rootRef);
  assert.equal(fixture.routeCount(), 2);
  assert.equal(routePrefix + previous in fixture.state.stored, false);
});

test("a delayed projection cannot remove a concurrent Key's newly registered live ref", async () => {
  const fixture = treeHarness([element("DIV", [textNode("first")])]);
  const { rootRef } = await fixture.open();
  const initial = (await fixture.view(rootRef)).items[0];
  await fixture.expand(initial.treeRef);
  const paused = deferred();
  const release = deferred();
  fixture.state.afterProjection = async (injection) => {
    if (injection.args[2] === "A") { paused.resolve(); await release.promise; }
  };
  const pendingA = fixture.view(rootRef);
  await paused.promise;
  fixture.document.childNodes.push(element("SECTION", [textNode("new") ]));
  const viewB = await fixture.view(rootRef, {}, "B");
  const newRef = viewB.items[1].treeRef;
  release.resolve();
  await pendingA;
  assert.ok(fixture.state.stored[routePrefix + newRef]);
  assert.equal((await fixture.expand(newRef, "B")).expanded, true);
});

test("bounded candidate batches drain a historical route backlog behind live refs", async () => {
  const fixture = treeHarness([element("DIV", [textNode("live")])], {
    "command.page.tree.maximum_refs_per_document": 4,
    "command.page.tree.maximum_view_items": 2,
  });
  const { rootRef } = await fixture.open();
  await fixture.view(rootRef);
  for (const letter of "ABCDEFGHIJKLMNOPQRST") {
    fixture.state.stored[routePrefix + syntheticRef(letter)] = { rootRef, tabId: 7, frameId: 0, documentId: "fixture-document" };
  }
  const counts = [fixture.routeCount()];
  for (let index = 0; index < 6; index += 1) {
    await fixture.view(rootRef);
    counts.push(fixture.routeCount());
  }
  assert.deepEqual(counts, [22, 18, 14, 10, 6, 2, 2]);
});

test("navigation retains current child documents, rejects late old projections, and fails closed on unknown metadata", async () => {
  const fixture = treeHarness([element("MAIN", [textNode("old")])]);
  const { rootRef } = await fixture.open();
  const oldChild = syntheticRef("C");
  const newChild = syntheticRef("D");
  fixture.state.stored[routePrefix + oldChild] = { rootRef: oldChild, tabId: 7, frameId: 2, documentId: "old-child" };
  fixture.state.stored[routePrefix + newChild] = { rootRef: newChild, tabId: 7, frameId: 3, documentId: "new-child" };
  const paused = deferred();
  const release = deferred();
  fixture.state.afterProjection = async () => { paused.resolve(); await release.promise; };
  const lateOldOpen = fixture.open();
  await paused.promise;
  fixture.state.documentId = "next-document";
  fixture.state.frames = [{ frameId: 0, documentId: "next-document" }, { frameId: 3, documentId: "new-child" }];
  for (const listener of fixture.state.committed) listener({ tabId: 7, frameId: 0, documentId: "next-document" });
  await turn();
  release.resolve();
  await assert.rejects(lateOldOpen, stale);
  assert.equal(routePrefix + rootRef in fixture.state.stored, false);
  assert.equal(routePrefix + oldChild in fixture.state.stored, false);
  assert.ok(fixture.state.stored[routePrefix + newChild]);
  fixture.state.frames = null;
  for (const listener of fixture.state.committed) listener({ tabId: 7, frameId: 0 });
  await turn();
  assert.ok(fixture.state.stored[routePrefix + newChild], "unknown is not absent");
  for (const listener of fixture.state.replaced) listener(8, 7);
  await turn();
  assert.equal(fixture.routeCount(), 0);
});
