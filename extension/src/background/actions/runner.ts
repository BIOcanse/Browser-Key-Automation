import { COMMAND_CATALOG } from "../../generated/command-config.js";
import { observeDomTarget } from "../dom-service.js";
import { linearGlobMatch } from "../glob.js";
import { getTab, resolveCurrentTabTarget } from "../tab-service.js";
import { ActionError, pathValue, record, setPath, valueMatches, type ActionSource, type ActionSnapshot, type TabBinding } from "./model.js";
import type { ParseInstruction, ParsedInstruction } from "./compiler.js";

export interface ActionRunDependencies {
  readonly parse: ParseInstruction;
  readonly execute: (command: ParsedInstruction, step: number, remainingMs: number) => Promise<unknown>;
  readonly normalizeError: (error: unknown) => { readonly code: string; readonly details?: Readonly<Record<string, unknown>> };
  readonly stepEvent: (step: number, status: string) => void;
  readonly materializeResult: (result: unknown) => Promise<unknown>;
}
async function basicValue(source: Exclude<ActionSource, {kind: "element"}>, inputs: Record<string, unknown>, results: readonly unknown[], tabs: Map<string, string>): Promise<unknown> {
  if (source.kind === "tab") {
    if (source.alias !== undefined) {
      const bound = Object.hasOwn(inputs, source.alias) ? inputs[source.alias] : tabs.get(source.alias);
      if (bound !== undefined) {
        if (!valueMatches(bound, "tab_ref")) throw new ActionError({ reason: "BINDING_TYPE_MISMATCH" });
        await getTab(bound as string); tabs.set(source.alias, bound as string); return bound;
      }
    }
    const matches = (await chrome.tabs.query({})).filter((tab) => tab.id !== undefined && typeof tab.url === "string" &&
      (source.selector.urlMatch === "exact" ? tab.url === source.selector.urlPattern : linearGlobMatch(tab.url, source.selector.urlPattern)) && (source.selector.title === null || source.selector.title === tab.title) &&
      (source.selector.windowId === null || source.selector.windowId === tab.windowId));
    if (matches.length !== 1) throw new ActionError({ reason: matches.length === 0 ? "TARGET_ABSENT" : "TARGET_AMBIGUOUS" });
    const tabRef = (await resolveCurrentTabTarget(matches[0]!.id!)).tabRef;
    if (source.alias !== undefined) tabs.set(source.alias, tabRef);
    return tabRef;
  }
  let value: unknown;
  if (source.kind === "input") {
    if (!Object.hasOwn(inputs, source.name)) throw new ActionError({ reason: "INPUT_MISSING" });
    value = inputs[source.name];
  } else {
    if (source.step >= results.length) throw new ActionError({ reason: "RESULT_UNAVAILABLE" });
    value = pathValue(results[source.step], source.path);
  }
  if (!valueMatches(value, source.valueType)) throw new ActionError({ reason: "BINDING_TYPE_MISMATCH" });
  return value;
}
async function bindingValue(source: ActionSource, inputs: Record<string, unknown>, results: readonly unknown[], tabs: Map<string, string>): Promise<unknown> {
  if (source.kind !== "element") return basicValue(source, inputs, results, tabs);
  const tabRef = await basicValue(source.tab as TabBinding, inputs, results, tabs) as string;
  await getTab(tabRef);
  const observed = await observeDomTarget({ kind: "locator", tabRef, ...source.locator });
  if (observed.status !== "matched" || observed.nodeRef === null) throw new ActionError({ reason: "TARGET_ABSENT" });
  return observed.nodeRef;
}
export async function runAction(snapshot: ActionSnapshot, inputs: Record<string, unknown>, timeoutMs: number, dependencies: ActionRunDependencies) {
  const results: unknown[] = [], steps: { step: number; status: string }[] = [];
  const tabs = new Map<string, string>();
  const started = performance.now(), deadline = started + timeoutMs;
  let resultBytes = 0;
  for (let index = 0; index < snapshot.instructions.length; index += 1) {
    const instruction = snapshot.instructions[index]!;
    let dispatched = false;
    try {
      if (instruction.delayMs > 0) {
        if (performance.now() + instruction.delayMs >= deadline) throw new ActionError({ reason: "DEADLINE", step: index });
        await new Promise<void>((resolve) => setTimeout(resolve, instruction.delayMs));
      }
      const params = structuredClone(instruction.params) as Record<string, unknown>;
      for (const binding of instruction.bindings) setPath(params, binding.path, await bindingValue(binding.source, inputs, results, tabs));
      const command = dependencies.parse({ method: instruction.method, schemaVersion: instruction.schemaVersion, params });
      if (command === null) throw new ActionError({ reason: "PARAMS_INVALID", step: index });
      const remainingMs = Math.floor(deadline - performance.now());
      if (remainingMs <= 0) throw new ActionError({ reason: "DEADLINE", step: index });
      dependencies.stepEvent(index, "started");
      dispatched = true;
      // No Promise.race: abandoning a still-running effect would allow it to outlive this Key's serial lane.
      const result = await dependencies.execute(command, index, remainingMs);
      const size = new TextEncoder().encode(JSON.stringify(result) ?? "null").byteLength;
      if (resultBytes + size > COMMAND_CATALOG.limits["command.actions.maximum_result_bytes"]) {
        const resultArtifact = await dependencies.materializeResult(result);
        const failedResult = record(result) && ["failed", "unknown", "interrupted", "rejected", "timed_out"].includes(result.status as string);
        dependencies.stepEvent(index, failedResult ? "unknown" : "succeeded");
        return { actionId: snapshot.actionId, revision: snapshot.revision, status: failedResult ? "unknown" : "failed", completedSteps: index + (failedResult ? 0 : 1),
          stoppedAt: index, steps, results, resultArtifact, error: { code: "ACTION_OPERATION_FAILED", details: { reason: "RESULT_LIMIT", step: index } }, elapsedMs: performance.now() - started };
      }
      resultBytes += size;
      results.push(result);
      if (record(result) && ["failed", "unknown", "interrupted", "rejected", "timed_out"].includes(result.status as string)) {
        const status = result.status === "failed" || result.status === "rejected" ? "failed" : "unknown";
        dependencies.stepEvent(index, status);
        return { actionId: snapshot.actionId, revision: snapshot.revision, status, completedSteps: index, stoppedAt: index, steps, results, error: result.error ?? { code: "ACTION_OPERATION_FAILED", details: { reason: "STEP_NOT_CONFIRMED" } }, elapsedMs: performance.now() - started };
      }
      steps.push({ step: index, status: "succeeded" });
      dependencies.stepEvent(index, "succeeded");
      if (performance.now() > deadline) return { actionId: snapshot.actionId, revision: snapshot.revision, status: "failed", completedSteps: index + 1,
        stoppedAt: index, steps, results, error: { code: "ACTION_OPERATION_FAILED", details: { reason: "DEADLINE_AFTER_STEP", step: index } }, elapsedMs: performance.now() - started };
    } catch (error) {
      const status = dispatched ? "unknown" : "failed";
      dependencies.stepEvent(index, status);
      return { actionId: snapshot.actionId, revision: snapshot.revision, status, completedSteps: steps.length, stoppedAt: index, steps, results, error: dependencies.normalizeError(error), elapsedMs: performance.now() - started };
    }
  }
  return { actionId: snapshot.actionId, revision: snapshot.revision, status: "succeeded", completedSteps: steps.length, stoppedAt: null, steps, results, error: null, elapsedMs: performance.now() - started };
}
