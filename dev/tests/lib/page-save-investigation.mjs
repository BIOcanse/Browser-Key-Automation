import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runUsabilityProbe } from "./usability-probe.mjs";

// This isolated workflow performs one page-save at a time. Ambiguous or
// incomplete console evidence must not be presented as a diagnosed operation.
export function summarizePageSaveDiagnostics(events, captureErrors = [], usedIds = new Set()) {
  const problems = [...captureErrors];
  const valid = events.every((event) => event && typeof event.id === "string" && event.id.length > 0 &&
    typeof event.phase === "string" && ["started", "succeeded", "failed"].includes(event.status) &&
    Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 && typeof event.firstFailure === "boolean");
  if (!valid) problems.push("invalid_diagnostic_event");
  const ids = [...new Set(events.map((event) => event?.id).filter((id) => typeof id === "string"))];
  const operationId = valid && ids.length === 1 ? ids[0] : null;
  if (operationId === null) problems.push("expected_one_operation");
  else if (usedIds.has(operationId)) problems.push("operation_reused_across_attempts");
  let firstFailure = null;
  if (valid && events.length > 0) {
    if (events.some((event, index) => event.sequence !== index + 1)) problems.push("missing_or_reordered_event");
    if (events[0].phase !== "target.resolve" || events[0].status !== "started") problems.push("missing_start");
    const active = new Map();
    let previousTime = -1;
    for (const event of events) {
      if (event.elapsedMs < previousTime) problems.push("out_of_order");
      previousTime = event.elapsedMs;
      if (event.firstFailure !== (event.status === "failed" && firstFailure === null)) problems.push("invalid_first_failure");
      if (event.status === "failed" && firstFailure === null) firstFailure = event;
      const phase = `${event.phase}:${event.chunkIndex ?? ""}`;
      if (event.status === "started") {
        if (active.has(phase)) problems.push("duplicate_stage_start");
        active.set(phase, event);
      } else if (!["capture.blob", "archive.complete", "transaction.abort"].includes(event.phase)) {
        if (!active.delete(phase)) problems.push("missing_stage_start");
      }
    }
    if (active.size > 0) problems.push("missing_stage_end");
    const completed = events.filter((event) => event.phase === "archive.complete" && event.status === "succeeded");
    if (firstFailure === null && (completed.length !== 1 || events.at(-1) !== completed[0])) problems.push("missing_terminal");
    if (firstFailure !== null && completed.length !== 0) problems.push("conflicting_outcomes");
  }
  return { operationId, complete: problems.length === 0, problems: [...new Set(problems)],
    outcome: problems.length ? "unknown" : firstFailure ? "failed" : "succeeded", firstFailure };
}

export async function runPageSaveInvestigation(options) {
  const { workerClient, sampleRoot, browserVersion, attemptCount = 20, probe = runUsabilityProbe } = options;
  await mkdir(sampleRoot, { recursive: true });
  const diagnostics = [], attempts = [], captureErrors = [], usedIds = new Set();
  await writeFile(path.join(sampleRoot, "browser-version.json"), JSON.stringify(browserVersion ?? null, null, 2) + "\n");
  const listener = (event) => {
    let packet;
    try { packet = JSON.parse(String(event.data)); } catch { captureErrors.push("malformed_cdp_packet"); return; }
    if (packet.method === "Runtime.executionContextsCleared") captureErrors.push("worker_contexts_cleared");
    if (packet.method !== "Runtime.consoleAPICalled") return;
    const args = packet.params?.args ?? [];
    if (args[0]?.value !== "BKA page-save diagnostic") return;
    try { diagnostics.push(JSON.parse(args[1]?.value)); }
    catch { diagnostics.push({ malformedValue: args[1]?.value ?? null }); captureErrors.push("malformed_diagnostic_json"); }
  };
  const disconnected = () => captureErrors.push("worker_disconnected");
  workerClient.webSocket.addEventListener("message", listener);
  workerClient.webSocket.addEventListener("close", disconnected);
  try {
    await workerClient.send("Runtime.enable");
    for (let index = 0; index < attemptCount; index += 1) {
      const started = Date.now(), firstEvent = diagnostics.length;
      const attempt = { index: index + 1, ok: false };
      try {
        attempt.result = await probe({ ...options, sampleRoot: path.join(sampleRoot, `attempt-${index + 1}`) });
        attempt.ok = true;
      } catch (error) {
        attempt.error = String(error);
      }
      // Drain this worker's already-emitted console events, without sleeps or
      // a new capture. A broken observation channel remains a failed gate.
      try { await workerClient.send("Runtime.evaluate", { expression: "void 0" }); }
      catch (error) { captureErrors.push(`console_barrier_failed: ${String(error)}`); }
      attempt.elapsedMs = Date.now() - started;
      attempt.diagnostics = { firstEvent, eventCount: diagnostics.length - firstEvent,
        ...summarizePageSaveDiagnostics(diagnostics.slice(firstEvent), captureErrors, usedIds) };
      if (attempt.diagnostics.operationId !== null) usedIds.add(attempt.diagnostics.operationId);
      attempts.push(attempt);
      await writeFile(path.join(sampleRoot, "original-operation-diagnostics.json"), JSON.stringify(diagnostics, null, 2) + "\n");
      await writeFile(path.join(sampleRoot, "attempts.json"), JSON.stringify(attempts, null, 2) + "\n");
      if (captureErrors.length) break; // No blind runs on a lost console channel.
    }
  } finally {
    workerClient.webSocket.removeEventListener("message", listener);
    workerClient.webSocket.removeEventListener("close", disconnected);
  }
  return { attempts: attempts.length, failures: attempts.filter((attempt) => !attempt.ok).length,
    incompleteDiagnostics: attempts.filter((attempt) => !attempt.diagnostics.complete).length,
    samples: sampleRoot, diagnosticEvents: diagnostics.length };
}
