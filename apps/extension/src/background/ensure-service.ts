import { COMMAND_CATALOG } from "../generated/command-config.js";
import type { PermissionId } from "../shared/admin-protocol.js";
import {
  isNodeRefShape,
  type DomFrameLocator,
  type DomTarget,
  type DomTargetObservation,
} from "./dom-service.js";
import { isTabRefShape } from "./tab-service.js";
import { linearGlobMatch } from "./glob.js";

export { linearGlobMatch } from "./glob.js";

export type EnsureMode = "ensure" | "strict";
export type EnsureCompletion = "derive_active" | "derive_focus" | "derive_selection" | "derive_value" | "explicit_goal" | "result";
export type EnsureRepeat = "never" | "safe";

export type EnsureCondition =
  | { readonly kind: "all" | "any"; readonly conditions: readonly EnsureCondition[] }
  | { readonly kind: "not"; readonly condition: EnsureCondition }
  | { readonly kind: "present" | "visible" | "enabled" | "unobstructed" | "stable" | "ready" | "focused"; readonly target: DomTarget }
  | { readonly kind: "value_is"; readonly target: DomTarget; readonly value: string }
  | { readonly kind: "selected_values_are"; readonly target: DomTarget; readonly values: readonly string[] }
  | { readonly kind: "text_contains"; readonly target: DomTarget; readonly text: string }
  | { readonly kind: "url_matches"; readonly tabRef: string; readonly pattern: string }
  | { readonly kind: "loaded"; readonly tabRef: string; readonly state: "committed" | "domcontentloaded" | "complete" }
  | { readonly kind: "tab_active"; readonly tabRef: string }
  | { readonly kind: "javascript"; readonly tabRef: string; readonly world: "MAIN" | "USER_SCRIPT"; readonly code: string; readonly timeoutMs: number };

export interface EnsureActionPolicy {
  readonly completion: EnsureCompletion;
  readonly repeat: EnsureRepeat;
}

export interface EnsureAction {
  readonly method: string;
  readonly schemaVersion: number;
  readonly requiredPermission: PermissionId;
  readonly params: Readonly<Record<string, unknown>>;
  readonly target: DomTarget | null;
  readonly policy: EnsureActionPolicy;
  readonly derivedGoal: EnsureCondition | null;
}

export interface EnsureRequest {
  readonly mode: EnsureMode;
  readonly timeoutMs: number;
  readonly scrollIntoView: boolean;
  readonly searchByScrolling: boolean;
  readonly precondition: EnsureCondition | null;
  readonly goal: EnsureCondition | null;
  readonly action: EnsureAction;
}

export interface EnsurePublicError {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface EnsureResult {
  readonly status: "satisfied" | "failed" | "unknown";
  readonly stage: "condition" | "prepare" | "effect" | "verify";
  readonly effectSent: boolean;
  readonly effectAttempts: number;
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  readonly matchedNodeRef: string | null;
  readonly observedCondition: { readonly kind: string; readonly satisfied: boolean } | null;
  readonly preparations: {
    readonly observations: number;
    readonly targetResolutions: number;
    readonly scrollIntoViewCount: number;
    readonly searchAttemptCount: number;
    readonly searchScrollCount: number;
  };
  readonly actionResult: unknown;
  readonly error: EnsurePublicError | null;
}

export interface EnsureTraceEvent {
  readonly phase: "condition" | "prepare" | "effect" | "verify";
  readonly operation: "condition_observed" | "target_resolved" | "target_scrolled" | "search_scrolled" | "effect_entered" | "effect_returned" | "workflow_finished";
  readonly status: "started" | "satisfied" | "not_satisfied" | "matched" | "absent" | "succeeded" | "no_effect" | "failed" | "unknown";
  readonly nodeRef: string | null;
  readonly conditionKind: string | null;
  readonly attempt: number | null;
}

export interface EnsureDependencies {
  readonly authorize: (permission: PermissionId) => Promise<void>;
  readonly observeTarget: (target: DomTarget) => Promise<DomTargetObservation>;
  readonly observeLoaded: (tabRef: string, state: "committed" | "domcontentloaded" | "complete") => Promise<boolean>;
  readonly observeTab: (tabRef: string) => Promise<{ readonly active: boolean; readonly url: string | null }>;
  readonly executeJavascriptCondition: (
    tabRef: string,
    world: "MAIN" | "USER_SCRIPT",
    code: string,
    timeoutMs: number,
  ) => Promise<boolean>;
  readonly executeAction: (action: EnsureAction, nodeRef: string | null) => Promise<unknown>;
  readonly scrollTarget: (nodeRef: string) => Promise<void>;
  readonly scrollSearch: (
    target: Extract<DomTarget, { readonly kind: "locator" }>,
    percent: number,
    cursor: number,
    scope: { readonly documentId: string; readonly topologyToken: string } | null,
  ) => Promise<{
    readonly moved: boolean;
    readonly nextCursor: number;
    readonly contextKind: "document" | "element" | null;
    readonly scope?: { readonly documentId: string; readonly topologyToken: string } | null;
  }>;
  readonly recordEvent: (event: EnsureTraceEvent) => void;
  readonly checkpointEffect: () => Promise<void>;
  readonly normalizeError: (error: unknown) => EnsurePublicError;
  readonly now: () => number;
  readonly setTimer: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
}

export class EnsureWorkflowError extends Error {
  readonly code: "CONDITION_NOT_MET" | "DOM_OPERATION_FAILED";
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: "CONDITION_NOT_MET" | "DOM_OPERATION_FAILED",
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "EnsureWorkflowError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length) return false;
  let index = 0;
  while (index < keys.length) {
    if (keys[index] !== wanted[index]) return false;
    index += 1;
  }
  return true;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) return false;
  }
  return true;
}

function boundedString(value: unknown, maximumBytes: number, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0) && encoder.encode(value).byteLength <= maximumBytes;
}

function safeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function parseDomTarget(value: unknown): DomTarget | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "node") {
    return hasExactKeys(value, ["kind", "nodeRef"]) && isNodeRefShape(value.nodeRef)
      ? { kind: "node", nodeRef: value.nodeRef }
      : null;
  }
  if (value.kind !== "locator" || !hasOnlyKeys(value, ["kind", "tabRef", "framePath", "selector", "role", "name", "nameMatch", "match"]) ||
      !hasExactKeys(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "framePath")), ["kind", "tabRef", "selector", "role", "name", "nameMatch", "match"]) ||
      !isTabRefShape(value.tabRef) ||
      !(value.selector === null || boundedString(value.selector, COMMAND_CATALOG.limits["command.dom.maximum_value_bytes"])) ||
      !(value.role === null || boundedString(value.role, COMMAND_CATALOG.limits["command.dom.maximum_value_bytes"])) ||
      !(value.name === null || boundedString(value.name, COMMAND_CATALOG.limits["command.dom.maximum_value_bytes"])) ||
      (value.selector === null && value.role === null && value.name === null) ||
      (value.nameMatch !== "exact" && value.nameMatch !== "contains") ||
      (value.match !== "unique" && value.match !== "first")) return null;
  const framePath: DomFrameLocator[] = [];
  if (value.framePath !== undefined) {
    if (!Array.isArray(value.framePath) ||
        value.framePath.length > COMMAND_CATALOG.limits["command.ensure.maximum_frame_depth"]) return null;
    let index = 0;
    while (index < value.framePath.length) {
      const segment = value.framePath[index];
      if (!isRecord(segment) || !hasOnlyKeys(segment, ["urlPattern", "match"]) ||
          !boundedString(segment.urlPattern, COMMAND_CATALOG.limits["command.tabs.maximum_text_bytes"]) ||
          !(segment.match === undefined || segment.match === "unique" || segment.match === "first")) return null;
      framePath.push({ urlPattern: segment.urlPattern, match: segment.match ?? "unique" });
      index += 1;
    }
  }
  return {
    kind: "locator",
    tabRef: value.tabRef,
    framePath,
    selector: value.selector,
    role: value.role,
    name: value.name,
    nameMatch: value.nameMatch,
    match: value.match,
  };
}

function validStringArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > COMMAND_CATALOG.limits["command.dom.query.maximum_results"]) return false;
  let bytes = 0;
  let index = 0;
  while (index < value.length) {
    const item = value[index];
    if (typeof item !== "string") return false;
    bytes += encoder.encode(item).byteLength;
    if (bytes > COMMAND_CATALOG.limits["command.dom.maximum_value_bytes"]) return false;
    index += 1;
  }
  return true;
}

export function isEnsureCondition(value: unknown): value is EnsureCondition {
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 1 }];
  const seen = new WeakSet<object>();
  let count = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined || !isRecord(item.value) || seen.has(item.value)) return false;
    seen.add(item.value);
    count += 1;
    if (count > COMMAND_CATALOG.limits["command.ensure.maximum_condition_nodes"] ||
        item.depth > COMMAND_CATALOG.limits["command.ensure.maximum_condition_depth"] ||
        typeof item.value.kind !== "string") return false;
    const node = item.value as Record<string, unknown> & { readonly kind: string };
    if (node.kind === "all" || node.kind === "any") {
      if (!hasExactKeys(node, ["kind", "conditions"]) || !Array.isArray(node.conditions) || node.conditions.length === 0) return false;
      let index = node.conditions.length;
      while (index > 0) {
        index -= 1;
        stack.push({ value: node.conditions[index], depth: item.depth + 1 });
      }
      continue;
    }
    if (node.kind === "not") {
      if (!hasExactKeys(node, ["kind", "condition"])) return false;
      stack.push({ value: node.condition, depth: item.depth + 1 });
      continue;
    }
    if (["present", "visible", "enabled", "unobstructed", "stable", "ready", "focused"].includes(node.kind)) {
      if (!hasExactKeys(node, ["kind", "target"]) || parseDomTarget(node.target) === null) return false;
      continue;
    }
    if (node.kind === "value_is") {
      if (!hasExactKeys(node, ["kind", "target", "value"]) || parseDomTarget(node.target) === null ||
          !boundedString(node.value, COMMAND_CATALOG.limits["command.dom.maximum_value_bytes"], true)) return false;
      continue;
    }
    if (node.kind === "selected_values_are") {
      if (!hasExactKeys(node, ["kind", "target", "values"]) || parseDomTarget(node.target) === null || !validStringArray(node.values)) return false;
      continue;
    }
    if (node.kind === "text_contains") {
      if (!hasExactKeys(node, ["kind", "target", "text"]) || parseDomTarget(node.target) === null ||
          !boundedString(node.text, COMMAND_CATALOG.limits["command.dom.maximum_value_bytes"], true)) return false;
      continue;
    }
    if (node.kind === "url_matches") {
      if (!hasExactKeys(node, ["kind", "tabRef", "pattern"]) || !isTabRefShape(node.tabRef) ||
          !boundedString(node.pattern, COMMAND_CATALOG.limits["command.tabs.maximum_text_bytes"])) return false;
      continue;
    }
    if (node.kind === "loaded") {
      if (!hasExactKeys(node, ["kind", "tabRef", "state"]) || !isTabRefShape(node.tabRef) ||
          !["committed", "domcontentloaded", "complete"].includes(node.state as string)) return false;
      continue;
    }
    if (node.kind === "tab_active") {
      if (!hasExactKeys(node, ["kind", "tabRef"]) || !isTabRefShape(node.tabRef)) return false;
      continue;
    }
    if (node.kind === "javascript") {
      if (!hasExactKeys(node, ["kind", "tabRef", "world", "code", "timeoutMs"]) || !isTabRefShape(node.tabRef) ||
          (node.world !== "MAIN" && node.world !== "USER_SCRIPT") ||
          !boundedString(node.code, COMMAND_CATALOG.limits["command.js.maximum_source_bytes"]) ||
          !safeInteger(node.timeoutMs, 1, COMMAND_CATALOG.limits["command.js.maximum_timeout_ms"])) return false;
      continue;
    }
    return false;
  }
  return true;
}

export function parseEnsureParameters(
  value: unknown,
  parseAction: (value: unknown) => EnsureAction | null,
): EnsureRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "action", "goal", "mode", "precondition", "scrollIntoView", "searchByScrolling", "timeoutMs",
  ]) || (value.mode !== "ensure" && value.mode !== "strict") ||
      typeof value.scrollIntoView !== "boolean" || typeof value.searchByScrolling !== "boolean" ||
      !safeInteger(value.timeoutMs, 1, COMMAND_CATALOG.limits["command.ensure.maximum_timeout_ms"]) ||
      !(value.precondition === null || isEnsureCondition(value.precondition)) ||
      !(value.goal === null || isEnsureCondition(value.goal))) return null;
  const action = parseAction(value.action);
  if (action === null) return null;
  if (value.mode === "strict") {
    if (value.precondition === null || value.goal !== null) return null;
    return {
      mode: "strict", timeoutMs: value.timeoutMs, scrollIntoView: value.scrollIntoView,
      searchByScrolling: value.searchByScrolling, precondition: value.precondition, goal: null, action,
    };
  }
  const goal = value.goal ?? action.derivedGoal;
  if (action.policy.completion === "explicit_goal" && goal === null ||
      action.policy.completion.startsWith("derive_") && goal === null) return null;
  return {
    mode: "ensure", timeoutMs: value.timeoutMs, scrollIntoView: value.scrollIntoView,
    searchByScrolling: value.searchByScrolling, precondition: value.precondition, goal, action,
  };
}

interface PreparationCandidate {
  readonly target: DomTarget;
  readonly nodeRef: string | null;
}

interface ConditionEvaluation {
  readonly satisfied: boolean;
  readonly kind: string;
  readonly matchedNodeRef: string | null;
  readonly preparation: PreparationCandidate | null;
}

interface MutableCounts {
  observations: number;
  targetResolutions: number;
  scrollIntoViewCount: number;
  searchAttemptCount: number;
  searchScrollCount: number;
}

interface StabilityRecord {
  readonly nodeRef: string;
  readonly rectKey: string;
  readonly since: number;
}

function observedConditionKind(value: ConditionEvaluation | null): string | null {
  return value === null ? null : value.kind;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  if (leftSet.size !== left.length) return false;
  let index = 0;
  while (index < right.length) {
    if (!leftSet.has(right[index] ?? "")) return false;
    index += 1;
  }
  return true;
}

function rectKey(observation: DomTargetObservation): string {
  if (observation.rect === null) return "none";
  const values = [observation.rect.x, observation.rect.y, observation.rect.width, observation.rect.height];
  return values.map((value) => Math.round(value * 4) / 4).join(":");
}

async function evaluateLeaf(
  condition: EnsureCondition,
  dependencies: EnsureDependencies,
  counts: MutableCounts,
  stable: Map<EnsureCondition, StabilityRecord>,
): Promise<ConditionEvaluation> {
  if (condition.kind === "all" || condition.kind === "any" || condition.kind === "not") {
    throw new Error("Composite condition reached the leaf evaluator");
  }
  counts.observations += 1;
  if (["present", "visible", "enabled", "unobstructed", "stable", "ready", "focused", "value_is", "selected_values_are", "text_contains"].includes(condition.kind)) {
    const targetCondition = condition as Extract<EnsureCondition, { readonly target: DomTarget }>;
    await dependencies.authorize("page.wait");
    await dependencies.authorize(targetCondition.target.kind === "node" ? "dom.describe" : "dom.query");
    if (targetCondition.target.kind === "locator") counts.targetResolutions += 1;
    const observation = await dependencies.observeTarget(targetCondition.target);
    const preparation = { target: targetCondition.target, nodeRef: observation.nodeRef };
    let satisfied = observation.status === "matched";
    if (condition.kind === "visible") satisfied = satisfied && observation.visible;
    else if (condition.kind === "enabled") satisfied = satisfied && observation.enabled;
    else if (condition.kind === "unobstructed") satisfied = satisfied && observation.unobstructed;
    else if (condition.kind === "focused") satisfied = satisfied && observation.focused;
    else if (condition.kind === "value_is") satisfied = satisfied && observation.value === condition.value;
    else if (condition.kind === "selected_values_are") satisfied = satisfied && sameStringSet(observation.selectedValues, condition.values);
    else if (condition.kind === "text_contains") satisfied = satisfied && (observation.text ?? "").includes(condition.text);
    else if (condition.kind === "stable" || condition.kind === "ready") {
      const base = satisfied && (condition.kind !== "ready" || observation.visible && observation.enabled && observation.unobstructed);
      const currentKey = rectKey(observation);
      const previous = stable.get(condition);
      if (!base || observation.nodeRef === null) {
        stable.delete(condition);
        satisfied = false;
      } else if ((COMMAND_CATALOG.limits["command.ensure.stable_window_ms"] as number) === 0) {
        satisfied = true;
      } else if (previous?.nodeRef === observation.nodeRef && previous.rectKey === currentKey) {
        satisfied = dependencies.now() - previous.since >= COMMAND_CATALOG.limits["command.ensure.stable_window_ms"];
      } else {
        stable.set(condition, { nodeRef: observation.nodeRef, rectKey: currentKey, since: dependencies.now() });
        satisfied = false;
      }
    }
    return { satisfied, kind: condition.kind, matchedNodeRef: observation.nodeRef, preparation };
  }
  await dependencies.authorize(condition.kind === "javascript" ? "js.execute" : "page.wait");
  if (condition.kind === "url_matches") {
    const tab = await dependencies.observeTab(condition.tabRef);
    return { satisfied: tab.url !== null && linearGlobMatch(tab.url, condition.pattern), kind: condition.kind, matchedNodeRef: null, preparation: null };
  }
  if (condition.kind === "loaded") {
    return { satisfied: await dependencies.observeLoaded(condition.tabRef, condition.state), kind: condition.kind, matchedNodeRef: null, preparation: null };
  }
  if (condition.kind === "tab_active") {
    return { satisfied: (await dependencies.observeTab(condition.tabRef)).active, kind: condition.kind, matchedNodeRef: null, preparation: null };
  }
  if (condition.kind !== "javascript") throw new Error("Unknown validated ensure condition kind");
  return {
    satisfied: await dependencies.executeJavascriptCondition(condition.tabRef, condition.world, condition.code, condition.timeoutMs),
    kind: condition.kind,
    matchedNodeRef: null,
    preparation: null,
  };
}

async function evaluateCondition(
  root: EnsureCondition,
  dependencies: EnsureDependencies,
  counts: MutableCounts,
  stable: Map<EnsureCondition, StabilityRecord>,
): Promise<ConditionEvaluation> {
  interface Frame {
    readonly node: EnsureCondition;
    nextChild: number;
    childResult: ConditionEvaluation | null;
  }
  const stack: Frame[] = [{ node: root, nextChild: 0, childResult: null }];
  let returned: ConditionEvaluation | null = null;
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) throw new Error("Condition stack underflow");
    if (returned !== null) {
      if (frame.node.kind === "not") {
        stack.pop();
        returned = { satisfied: !returned.satisfied, kind: "not", matchedNodeRef: returned.matchedNodeRef, preparation: null };
        continue;
      }
      if (frame.node.kind === "all") {
        if (!returned.satisfied) {
          stack.pop();
          returned = { ...returned, kind: "all" };
          continue;
        }
        frame.childResult = returned;
      } else if (frame.node.kind === "any") {
        if (returned.satisfied) {
          stack.pop();
          returned = { ...returned, kind: "any" };
          continue;
        }
        frame.childResult = returned;
      }
      returned = null;
    }
    if (frame.node.kind === "all" || frame.node.kind === "any") {
      if (frame.nextChild >= frame.node.conditions.length) {
        stack.pop();
        const terminal: ConditionEvaluation = frame.childResult ?? {
          satisfied: frame.node.kind === "all", kind: frame.node.kind, matchedNodeRef: null, preparation: null,
        };
        returned = { ...terminal, kind: frame.node.kind };
      } else {
        const child = frame.node.conditions[frame.nextChild];
        frame.nextChild += 1;
        if (child === undefined) throw new Error("Validated condition child disappeared");
        stack.push({ node: child, nextChild: 0, childResult: null });
      }
      continue;
    }
    if (frame.node.kind === "not") {
      if (frame.nextChild === 0) {
        frame.nextChild = 1;
        stack.push({ node: frame.node.condition, nextChild: 0, childResult: null });
        continue;
      }
      throw new Error("Condition evaluator lost a negated child result");
    }
    stack.pop();
    returned = await evaluateLeaf(frame.node, dependencies, counts, stable);
  }
  if (returned === null) throw new Error("Condition evaluator produced no result");
  return returned;
}

export async function runEnsure(request: EnsureRequest, dependencies: EnsureDependencies): Promise<EnsureResult> {
  const started = dependencies.now();
  const expired = Symbol("ensure-deadline");
  let ended = false;
  let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
  const pauseHandles = new Set<ReturnType<typeof setTimeout>>();
  const deadline = new Promise<typeof expired>((resolve) => {
    deadlineHandle = dependencies.setTimer(() => { ended = true; resolve(expired); }, request.timeoutMs);
  });
  const within = <T>(operation: Promise<T>): Promise<T | typeof expired> => Promise.race([operation, deadline]);
  const pause = async (): Promise<boolean> => {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const waiting = new Promise<void>((resolve) => {
      handle = dependencies.setTimer(resolve, COMMAND_CATALOG.limits["command.ensure.poll_interval_ms"]);
      pauseHandles.add(handle);
    });
    const result = await Promise.race([waiting, deadline]);
    if (handle !== undefined) {
      dependencies.clearTimer(handle);
      pauseHandles.delete(handle);
    }
    return result !== expired;
  };
  const counts: MutableCounts = {
    observations: 0,
    targetResolutions: 0,
    scrollIntoViewCount: 0,
    searchAttemptCount: 0,
    searchScrollCount: 0,
  };
  const stable = new Map<EnsureCondition, StabilityRecord>();
  const scrolledNodeRefs = new Set<string>();
  const searchStates = new WeakMap<Extract<DomTarget, { readonly kind: "locator" }>, {
    cursor: number;
    scope: { readonly documentId: string; readonly topologyToken: string } | null;
  }>();
  let lastObservation: ConditionEvaluation | null = null;
  let matchedNodeRef: string | null = null;
  let effectSent = false;
  let effectAttempts = 0;
  let actionResult: unknown = null;
  let currentStage: EnsureResult["stage"] = "condition";
  const actionOwnsTargetScroll = request.action.method === "dom.scroll" ||
    request.action.method === "dom.click.real" && request.action.params.scrollIntoView === true;
  const emit = (event: EnsureTraceEvent): void => {
    try { dependencies.recordEvent(event); }
    catch { /* Diagnostic collection never changes workflow semantics. */ }
  };
  const finish = (
    status: EnsureResult["status"],
    stage: EnsureResult["stage"],
    error: EnsurePublicError | null = null,
  ): EnsureResult => {
    emit({
      phase: stage,
      operation: "workflow_finished",
      status,
      nodeRef: matchedNodeRef,
      conditionKind: lastObservation?.kind ?? null,
      attempt: effectAttempts,
    });
    return {
      status,
      stage,
      effectSent,
      effectAttempts,
      elapsedMs: Math.max(0, Math.min(request.timeoutMs, Math.round(dependencies.now() - started))),
      timeoutMs: request.timeoutMs,
      matchedNodeRef,
      observedCondition: lastObservation === null ? null : { kind: lastObservation.kind, satisfied: lastObservation.satisfied },
      preparations: { ...counts },
      actionResult,
      error,
    };
  };
  const observe = async (
    condition: EnsureCondition,
    phase: "condition" | "verify",
  ): Promise<ConditionEvaluation | typeof expired> => {
    const result = await within(evaluateCondition(condition, dependencies, counts, stable));
    if (result !== expired) {
      lastObservation = result;
      if (result.matchedNodeRef !== null) matchedNodeRef = result.matchedNodeRef;
      emit({
        phase,
        operation: "condition_observed",
        status: result.satisfied ? "satisfied" : "not_satisfied",
        nodeRef: result.matchedNodeRef,
        conditionKind: result.kind,
        attempt: null,
      });
    }
    return result;
  };
  const prepare = async (candidate: PreparationCandidate | null): Promise<"continue" | "deadline"> => {
    if (candidate?.nodeRef !== null && candidate?.nodeRef !== undefined && request.scrollIntoView && !scrolledNodeRefs.has(candidate.nodeRef)) {
      if (await within(dependencies.authorize("dom.scroll")) === expired) return "deadline";
      const result = await within(dependencies.scrollTarget(candidate.nodeRef));
      if (result === expired) return "deadline";
      counts.scrollIntoViewCount += 1;
      scrolledNodeRefs.add(candidate.nodeRef);
      emit({ phase: "prepare", operation: "target_scrolled", status: "succeeded", nodeRef: candidate.nodeRef, conditionKind: null, attempt: null });
      return "continue";
    }
    if (candidate?.target.kind === "locator" && candidate.nodeRef === null && request.searchByScrolling &&
        counts.searchAttemptCount < COMMAND_CATALOG.limits["command.ensure.maximum_search_attempts"] &&
        counts.searchScrollCount < COMMAND_CATALOG.limits["command.ensure.maximum_search_scrolls"]) {
      if (await within(dependencies.authorize("dom.scroll")) === expired) return "deadline";
      const state = searchStates.get(candidate.target) ?? { cursor: 0, scope: null };
      const result = await within(dependencies.scrollSearch(
        candidate.target,
        COMMAND_CATALOG.limits["command.ensure.search_scroll_percent"],
        state.cursor,
        state.scope,
      ));
      if (result === expired) return "deadline";
      counts.searchAttemptCount += 1;
      state.cursor = result.nextCursor;
      state.scope = result.scope ?? null;
      searchStates.set(candidate.target, state);
      if (result.moved) counts.searchScrollCount += 1;
      emit({
        phase: "prepare",
        operation: "search_scrolled",
        status: result.moved ? "succeeded" : "no_effect",
        nodeRef: null,
        conditionKind: null,
        attempt: counts.searchAttemptCount,
      });
    }
    return "continue";
  };
  const resolveActionNode = async (): Promise<string | null | typeof expired> => {
    if (request.action.target === null) return null;
    if (request.action.target.kind === "node") return request.action.target.nodeRef;
    if (await within(dependencies.authorize("dom.query")) === expired) return expired;
    counts.targetResolutions += 1;
    counts.observations += 1;
    const result = await within(dependencies.observeTarget(request.action.target));
    if (result === expired) return expired;
    if (result.nodeRef !== null) matchedNodeRef = result.nodeRef;
    emit({
      phase: "prepare",
      operation: "target_resolved",
      status: result.nodeRef === null ? "absent" : "matched",
      nodeRef: result.nodeRef,
      conditionKind: null,
      attempt: null,
    });
    return result.nodeRef;
  };
  try {
    if (request.mode === "strict") {
      currentStage = "condition";
      const observed = await observe(request.precondition as EnsureCondition, "condition");
      if (observed === expired) throw new EnsureWorkflowError("DOM_OPERATION_FAILED", "Strict condition observation exceeded the workflow deadline");
      if (!observed.satisfied) {
        throw new EnsureWorkflowError("CONDITION_NOT_MET", "The strict precondition was false", {
          conditionKind: observed.kind,
          matchedNodeRef: observed.matchedNodeRef,
        });
      }
      currentStage = "prepare";
      const nodeRef = await resolveActionNode();
      if (nodeRef === expired) throw new EnsureWorkflowError("DOM_OPERATION_FAILED", "Strict action target resolution exceeded the workflow deadline");
      if (request.action.target !== null && nodeRef === null) {
        throw new EnsureWorkflowError("DOM_OPERATION_FAILED", "The strict action locator did not resolve");
      }
      currentStage = "effect";
      if (await within(dependencies.authorize(request.action.requiredPermission)) === expired) {
        throw new EnsureWorkflowError("DOM_OPERATION_FAILED", "Strict action authorization exceeded the workflow deadline");
      }
      effectSent = true;
      effectAttempts = 1;
      emit({ phase: "effect", operation: "effect_entered", status: "started", nodeRef, conditionKind: null, attempt: 1 });
      await dependencies.checkpointEffect();
      let result: unknown | typeof expired;
      try { result = await within(dependencies.executeAction(request.action, nodeRef)); }
      catch (error) {
        emit({ phase: "effect", operation: "effect_returned", status: "unknown", nodeRef, conditionKind: null, attempt: 1 });
        throw error;
      }
      if (result === expired) {
        emit({ phase: "effect", operation: "effect_returned", status: "unknown", nodeRef, conditionKind: null, attempt: 1 });
        return finish("unknown", "effect");
      }
      actionResult = result;
      emit({ phase: "effect", operation: "effect_returned", status: "succeeded", nodeRef, conditionKind: null, attempt: 1 });
      return finish("satisfied", "effect");
    }

    if (request.goal !== null) {
      currentStage = "condition";
      const initial = await observe(request.goal, "condition");
      if (initial === expired) return finish("failed", "condition");
      if (initial.satisfied) return finish("satisfied", "condition");
    }

    while (!ended && request.precondition !== null) {
      currentStage = "condition";
      const condition = await observe(request.precondition, "condition");
      if (condition === expired) return finish("failed", "condition");
      if (condition.satisfied) break;
      currentStage = "prepare";
      if (await prepare(condition.preparation) === "deadline") return finish("failed", "prepare");
      if (!await pause()) return finish("failed", "condition");
    }

    actionLoop: while (!ended) {
      currentStage = "prepare";
      const nodeRef = await resolveActionNode();
      if (nodeRef === expired) return finish("failed", "prepare");
      if (request.action.target !== null && nodeRef === null) {
        const candidate: PreparationCandidate | null = request.action.target.kind === "locator"
          ? { target: request.action.target, nodeRef: null }
          : null;
        if (await prepare(candidate) === "deadline") return finish("failed", "prepare");
        if (!await pause()) return finish("failed", "prepare");
        continue;
      }
      if (nodeRef !== null) {
        matchedNodeRef = nodeRef;
        if (!actionOwnsTargetScroll && await prepare({ target: request.action.target as DomTarget, nodeRef }) === "deadline") {
          return finish("failed", "prepare");
        }
      }
      currentStage = "effect";
      if (await within(dependencies.authorize(request.action.requiredPermission)) === expired) return finish("failed", "effect");
      let admittedNodeRef = nodeRef;
      if (request.action.target?.kind === "locator") {
        currentStage = "prepare";
        const refreshedNodeRef = await resolveActionNode();
        if (refreshedNodeRef === expired) return finish("failed", "prepare");
        if (refreshedNodeRef === null) {
          if (await prepare({ target: request.action.target, nodeRef: null }) === "deadline") return finish("failed", "prepare");
          if (!await pause()) return finish("failed", "prepare");
          continue actionLoop;
        }
        admittedNodeRef = refreshedNodeRef;
        if (admittedNodeRef !== nodeRef && !actionOwnsTargetScroll &&
            await prepare({ target: request.action.target, nodeRef: admittedNodeRef }) === "deadline") {
          return finish("failed", "prepare");
        }
        if (await within(dependencies.authorize(request.action.requiredPermission)) === expired) return finish("failed", "effect");
      }
      currentStage = "effect";
      effectSent = true;
      effectAttempts += 1;
      emit({ phase: "effect", operation: "effect_entered", status: "started", nodeRef: admittedNodeRef, conditionKind: null, attempt: effectAttempts });
      await dependencies.checkpointEffect();
      let executed: unknown | typeof expired;
      try { executed = await within(dependencies.executeAction(request.action, admittedNodeRef)); }
      catch (error) {
        emit({ phase: "effect", operation: "effect_returned", status: "unknown", nodeRef: admittedNodeRef, conditionKind: null, attempt: effectAttempts });
        return finish("unknown", "effect", dependencies.normalizeError(error));
      }
      if (executed === expired) {
        emit({ phase: "effect", operation: "effect_returned", status: "unknown", nodeRef: admittedNodeRef, conditionKind: null, attempt: effectAttempts });
        return finish("unknown", "effect");
      }
      actionResult = executed;
      emit({ phase: "effect", operation: "effect_returned", status: "succeeded", nodeRef: admittedNodeRef, conditionKind: null, attempt: effectAttempts });
      if (request.action.policy.completion === "result" && request.goal === null) return finish("satisfied", "effect");
      if (request.goal === null) return finish("satisfied", "effect");

      currentStage = "verify";
      const verified = await observe(request.goal, "verify");
      if (verified === expired) return finish("unknown", "verify");
      if (verified.satisfied) return finish("satisfied", "verify");
      currentStage = "prepare";
      if (await prepare(verified.preparation) === "deadline") return finish("unknown", "prepare");
      if (request.action.policy.repeat === "safe") {
        if (!await pause()) return finish("failed", "verify");
        continue;
      }
      while (!ended) {
        if (!await pause()) return finish("unknown", "verify");
        currentStage = "verify";
        const observation = await observe(request.goal, "verify");
        if (observation === expired) return finish("unknown", "verify");
        if (observation.satisfied) return finish("satisfied", "verify");
        currentStage = "prepare";
        if (await prepare(observation.preparation) === "deadline") return finish("unknown", "prepare");
      }
      return finish("unknown", "verify");
    }
    return finish(effectSent ? "unknown" : "failed", effectSent ? "verify" : "prepare");
  } catch (error) {
    if (request.mode === "strict") {
      emit({ phase: currentStage, operation: "workflow_finished", status: effectSent ? "unknown" : "failed", nodeRef: matchedNodeRef,
        conditionKind: observedConditionKind(lastObservation), attempt: effectAttempts });
      throw error;
    }
    return finish(effectSent ? "unknown" : "failed", currentStage, dependencies.normalizeError(error));
  } finally {
    ended = true;
    if (deadlineHandle !== undefined) dependencies.clearTimer(deadlineHandle);
    for (const handle of pauseHandles) dependencies.clearTimer(handle);
    pauseHandles.clear();
  }
}
