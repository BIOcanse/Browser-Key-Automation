import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import "fake-indexeddb/auto";
import { COMMAND_CATALOG } from "../out/extension/generated/command-config.js";
import { readArtifact } from "../out/extension/background/artifact-service.js";
import { EXECUTION_TRACE_STORE, withReadOnly, withStrictReadWrite } from "../out/extension/background/database.js";
import {
  appendExecutionTraceEvent,
  beginExecutionTrace,
  checkpointExecutionTrace,
  exportExecutionTrace,
  finishExecutionTrace,
  readExecutionTrace,
} from "../out/extension/background/execution-trace-service.js";

const owner = () => `trace-owner-${randomBytes(12).toString("base64url")}`;
const terminal = (overrides = {}) => ({
  outcome: "succeeded",
  errorCode: null,
  ensureStatus: null,
  ensureStage: null,
  ...overrides,
});

async function completed(ownerKeyId, method = "tabs.list", effectKind = "none") {
  const draft = await beginExecutionTrace(ownerKeyId, method, 1, effectKind);
  appendExecutionTraceEvent(draft, { phase: "command", operation: "handler_entered", status: "started" });
  appendExecutionTraceEvent(draft, { phase: "command", operation: "handler_returned", status: "succeeded" });
  return finishExecutionTrace(draft, terminal());
}

test("execution traces retain ordered semantic evidence without caller payloads", async () => {
  const ownerKeyId = owner();
  const draft = await beginExecutionTrace(ownerKeyId, "ensure.run", 1, "page_effect");
  const secret = `bk1.${"S".repeat(22)}.${"Q".repeat(43)}`;
  appendExecutionTraceEvent(draft, {
    phase: "condition",
    operation: "condition_observed",
    status: "not_satisfied",
    conditionKind: "ready",
    nodeRef: null,
    secret,
    params: { code: secret, value: secret, url: `https://${secret}@example.test/?q=${secret}` },
  });
  appendExecutionTraceEvent(draft, {
    phase: "prepare", operation: "search_scrolled", status: "succeeded", attempt: 1,
  });
  appendExecutionTraceEvent(draft, {
    phase: "effect", operation: "effect_entered", status: "started", attempt: 1,
  });
  appendExecutionTraceEvent(draft, {
    phase: "verify", operation: "workflow_finished", status: "satisfied", attempt: 1,
  });
  const record = await finishExecutionTrace(draft, terminal({
    ensureStatus: "satisfied", ensureStage: "verify",
  }));
  assert.deepEqual(record.events.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.deepEqual(record.events.map((event) => event.operation), [
    "condition_observed", "search_scrolled", "effect_entered", "workflow_finished",
  ]);
  assert.equal(record.effectEntries, 1);
  assert.equal(record.outcome, "succeeded");
  assert.equal(JSON.stringify(record).includes(secret), false);
  assert.deepEqual(await readExecutionTrace(ownerKeyId, record.traceRef), record);
});

test("trace reads are Key-scoped and latest ignores diagnostic commands", async () => {
  const ownerKeyId = owner();
  const business = await completed(ownerKeyId, "page.tree.view.get");
  await completed(ownerKeyId, "trace.read");
  await completed(ownerKeyId, "trace.export");
  assert.equal((await readExecutionTrace(ownerKeyId, null)).traceRef, business.traceRef);
  await assert.rejects(readExecutionTrace(owner(), business.traceRef), (error) => error.code === "TRACE_NOT_FOUND");
  await assert.rejects(readExecutionTrace(ownerKeyId, `xr1.${"X".repeat(43)}`), (error) => error.code === "TRACE_NOT_FOUND");
});

test("the per-Key ring evicts whole old runs and marks bounded event truncation", async () => {
  const limits = COMMAND_CATALOG.limits;
  const previousRecords = limits["command.trace.maximum_records_per_key"];
  const previousEvents = limits["command.trace.maximum_events"];
  const previousBytes = limits["command.trace.maximum_record_json_bytes"];
  const ownerKeyId = owner();
  try {
    limits["command.trace.maximum_records_per_key"] = 3;
    limits["command.trace.maximum_events"] = 3;
    limits["command.trace.maximum_record_json_bytes"] = 4096;
    const records = [];
    let index = 0;
    while (index < 4) {
      const draft = await beginExecutionTrace(ownerKeyId, `fixture.${index}`, 1, "none");
      let event = 0;
      while (event < 10) {
        appendExecutionTraceEvent(draft, {
          phase: "command", operation: `bounded_${event}`, status: "succeeded", attempt: event + 1,
        });
        event += 1;
      }
      records.push(await finishExecutionTrace(draft, terminal()));
      index += 1;
    }
    await assert.rejects(readExecutionTrace(ownerKeyId, records[0].traceRef), (error) => error.code === "TRACE_NOT_FOUND");
    const newest = await readExecutionTrace(ownerKeyId, records.at(-1).traceRef);
    assert.equal(newest.events.length, 3);
    assert.equal(newest.eventsTruncated, true);
    assert.equal(newest.droppedEventCount, 7);
    assert.ok(Buffer.byteLength(JSON.stringify(newest)) <= 4096);
  } finally {
    limits["command.trace.maximum_records_per_key"] = previousRecords;
    limits["command.trace.maximum_events"] = previousEvents;
    limits["command.trace.maximum_record_json_bytes"] = previousBytes;
  }
});

test("event truncation cannot erase the monotonic effect-entry fact", async () => {
  const limits = COMMAND_CATALOG.limits;
  const previousEvents = limits["command.trace.maximum_events"];
  const ownerKeyId = owner();
  try {
    limits["command.trace.maximum_events"] = 1;
    const draft = await beginExecutionTrace(ownerKeyId, "ensure.run", 1, "page_effect");
    appendExecutionTraceEvent(draft, {
      phase: "condition", operation: "condition_observed", status: "not_satisfied",
    });
    appendExecutionTraceEvent(draft, {
      phase: "effect", operation: "effect_entered", status: "started",
    });
    const record = await finishExecutionTrace(draft, terminal({
      outcome: "unknown", ensureStatus: "unknown", ensureStage: "verify",
    }));
    assert.equal(record.events.length, 1);
    assert.equal(record.eventsTruncated, true);
    assert.equal(record.droppedEventCount, 1);
    assert.equal(record.effectEntries, 1);
  } finally {
    limits["command.trace.maximum_events"] = previousEvents;
  }
});

test("the JSON byte bound removes event detail without changing effect facts", async () => {
  const limits = COMMAND_CATALOG.limits;
  const previousEvents = limits["command.trace.maximum_events"];
  const previousBytes = limits["command.trace.maximum_record_json_bytes"];
  const ownerKeyId = owner();
  try {
    limits["command.trace.maximum_events"] = 64;
    limits["command.trace.maximum_record_json_bytes"] = 1024;
    const draft = await beginExecutionTrace(ownerKeyId, "ensure.run", 1, "page_effect");
    let index = 0;
    while (index < 20) {
      appendExecutionTraceEvent(draft, {
        phase: "condition", operation: "condition_observed", status: "not_satisfied", attempt: index + 1,
      });
      index += 1;
    }
    appendExecutionTraceEvent(draft, { phase: "effect", operation: "effect_entered", status: "started" });
    const record = await finishExecutionTrace(draft, terminal({
      outcome: "unknown", ensureStatus: "unknown", ensureStage: "verify",
    }));
    assert.ok(record.events.length < 21);
    assert.equal(record.eventsTruncated, true);
    assert.ok(record.droppedEventCount > 0);
    assert.equal(record.effectEntries, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(record), "utf8") <= 1024);
  } finally {
    limits["command.trace.maximum_events"] = previousEvents;
    limits["command.trace.maximum_record_json_bytes"] = previousBytes;
  }
});

test("global owner, byte and age limits bound all Key rings", async () => {
  const limits = COMMAND_CATALOG.limits;
  const previousOwners = limits["command.trace.maximum_owner_records"];
  const previousBytes = limits["command.trace.maximum_total_json_bytes"];
  const previousRetention = limits["command.trace.maximum_retention_ms"];
  try {
    limits["command.trace.maximum_owner_records"] = 2;
    limits["command.trace.maximum_total_json_bytes"] = 16_777_216;
    const firstOwner = owner();
    const first = await completed(firstOwner, "fixture.first");
    await new Promise((resolve) => setTimeout(resolve, 2));
    const secondOwner = owner();
    await completed(secondOwner, "fixture.second");
    await new Promise((resolve) => setTimeout(resolve, 2));
    const thirdOwner = owner();
    const third = await completed(thirdOwner, "fixture.third");
    await assert.rejects(readExecutionTrace(firstOwner, first.traceRef), (error) => error.code === "TRACE_NOT_FOUND");
    assert.equal((await readExecutionTrace(thirdOwner, third.traceRef)).traceRef, third.traceRef);

    limits["command.trace.maximum_owner_records"] = 128;
    const byteOwnerA = owner();
    const byteFirst = await completed(byteOwnerA, "fixture.byte-a");
    limits["command.trace.maximum_total_json_bytes"] = Buffer.byteLength(JSON.stringify(byteFirst), "utf8") + 64;
    await new Promise((resolve) => setTimeout(resolve, 2));
    const byteOwnerB = owner();
    const byteSecond = await completed(byteOwnerB, "fixture.byte-b");
    await assert.rejects(readExecutionTrace(byteOwnerA, byteFirst.traceRef), (error) => error.code === "TRACE_NOT_FOUND");
    assert.equal((await readExecutionTrace(byteOwnerB, byteSecond.traceRef)).traceRef, byteSecond.traceRef);

    limits["command.trace.maximum_total_json_bytes"] = 16_777_216;
    limits["command.trace.maximum_retention_ms"] = 50;
    const expiringOwner = owner();
    const expiring = await completed(expiringOwner, "fixture.expiring");
    await new Promise((resolve) => setTimeout(resolve, 75));
    await assert.rejects(readExecutionTrace(expiringOwner, expiring.traceRef), (error) => error.code === "TRACE_NOT_FOUND");
  } finally {
    limits["command.trace.maximum_owner_records"] = previousOwners;
    limits["command.trace.maximum_total_json_bytes"] = previousBytes;
    limits["command.trace.maximum_retention_ms"] = previousRetention;
  }
});

test("bounded strict storage aborts a subordinate transaction that never settles", async () => {
  const started = performance.now();
  await assert.rejects(
    withStrictReadWrite([EXECUTION_TRACE_STORE], async () => new Promise(() => undefined), { timeoutMs: 20 }),
    (error) => error instanceof DOMException && error.name === "TimeoutError",
  );
  assert.ok(performance.now() - started < 1000);
});

test("bounded trace reads abort a subordinate transaction that never settles", async () => {
  const started = performance.now();
  await assert.rejects(
    withReadOnly([EXECUTION_TRACE_STORE], async () => new Promise(() => undefined), { timeoutMs: 20 }),
    (error) => error instanceof DOMException && error.name === "TimeoutError",
  );
  assert.ok(performance.now() - started < 1000);
});

test("unfinished records become interrupted and export reuses owner-bound Artifacts", async () => {
  const ownerKeyId = owner();
  const interrupted = await beginExecutionTrace(ownerKeyId, "dom.click", 1, "page_effect");
  appendExecutionTraceEvent(interrupted, { phase: "command", operation: "handler_entered", status: "started" });
  appendExecutionTraceEvent(interrupted, { phase: "effect", operation: "effect_entered", status: "started" });
  await checkpointExecutionTrace(interrupted);
  const recovered = await readExecutionTrace(ownerKeyId, interrupted.traceRef);
  assert.equal(recovered.outcome, "interrupted");
  assert.equal(recovered.finishedAt, null);
  assert.equal(recovered.effectEntries, 1);
  assert.equal(recovered.events.at(-1)?.operation, "effect_entered");

  const complete = await completed(ownerKeyId, "page.text.get");
  const exported = await exportExecutionTrace(ownerKeyId, complete.traceRef);
  const chunk = await readArtifact(ownerKeyId, exported.artifact.artifactRef, 0, 36000);
  const decoded = Buffer.from(chunk.dataBase64Url, "base64url").toString("utf8");
  assert.deepEqual(JSON.parse(decoded), complete);
  await assert.rejects(readArtifact(owner(), exported.artifact.artifactRef, 0, 36000),
    (error) => error.code === "ARTIFACT_NOT_FOUND");
});
