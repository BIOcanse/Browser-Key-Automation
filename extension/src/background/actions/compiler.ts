import { COMMAND_CATALOG } from "../../generated/command-config.js";
import { parseDomTarget } from "../ensure-service.js";
import { ActionError, integer, onlyKeys, record, setPath, text, validPath, type ActionBinding, type ActionInstruction, type ActionSource, type TabBinding } from "./model.js";

export interface ParsedInstruction { readonly kind: string; readonly schemaVersion: number; readonly params: Record<string, unknown>; readonly requiredPermission: string }
export type ParseInstruction = (value: unknown) => ParsedInstruction | null;
export interface CompileDiagnostic { readonly step: number; readonly code: string; readonly paths: readonly (readonly string[])[] }
export interface CompiledAction { readonly instructions: readonly ActionInstruction[]; readonly permissions: readonly string[]; readonly capabilities: readonly string[]; readonly diagnostics: readonly CompileDiagnostic[]; readonly runnable: boolean; readonly recording?: unknown; readonly recommendations?: readonly string[] }
const SAMPLE_TAB = `tr1.${"A".repeat(22)}.1.${"A".repeat(22)}`;
const types = ["string", "number", "integer", "boolean", "object", "array", "tab_ref", "node_ref", "window_id"];
function basicSource(value: unknown, step: number): value is Exclude<ActionSource, {kind: "element"}> {
  if (!record(value)) return false;
  if (value.kind === "input") return onlyKeys(value, ["kind", "name", "valueType"]) && text(value.name) && types.includes(value.valueType as string);
  if (value.kind === "result") return onlyKeys(value, ["kind", "step", "path", "valueType"]) && integer(value.step, 0, step - 1) && validPath(value.path) && types.includes(value.valueType as string);
  if (value.kind !== "tab" || !onlyKeys(value, ["kind", "selector", "alias"]) || !record(value.selector) || value.alias !== undefined && !text(value.alias)) return false;
  const selector = value.selector;
  return onlyKeys(selector, ["urlPattern", "title", "windowId", "urlMatch"]) && text(selector.urlPattern) &&
    (selector.urlMatch === undefined || selector.urlMatch === "glob" || selector.urlMatch === "exact") &&
    (selector.title === null || text(selector.title)) && (selector.windowId === null || integer(selector.windowId, 1));
}
function source(value: unknown, step: number): ActionSource | null {
  if (basicSource(value, step)) return value;
  if (!record(value) || value.kind !== "element" || !onlyKeys(value, ["kind", "tab", "locator"]) || !record(value.locator) || !basicSource(value.tab, step) ||
    (value.tab.kind !== "tab" && value.tab.valueType !== "tab_ref")) return null;
  if (!onlyKeys(value.locator, ["framePath", "shadowPath", "selector", "role", "name", "nameMatch", "match"])) return null;
  const target = parseDomTarget({ kind: "locator", tabRef: SAMPLE_TAB, ...value.locator });
  if (target === null || target.kind !== "locator") return null;
  const { kind: _kind, tabRef: _tabRef, ...locator } = target;
  return { kind: "element", tab: value.tab as TabBinding, locator };
}
function isPrefix(left: readonly string[], right: readonly string[]): boolean { return left.length <= right.length && left.every((part, i) => part === right[i]); }
function checkStructure(params: Record<string, unknown>, bindings: readonly ActionBinding[]): void {
  const pending: { value: unknown; path: string[] }[] = [{ value: params, path: [] }];
  let visited = 0;
  while (pending.length > 0) {
    if (++visited > COMMAND_CATALOG.limits["command.actions.maximum_json_nodes"]) throw new ActionError({ reason: "PARAMS_COMPLEXITY_LIMIT" });
    const item = pending.pop()!;
    if (item.path.length > COMMAND_CATALOG.limits["command.actions.maximum_binding_depth"]) throw new ActionError({ reason: "PARAMS_DEPTH_LIMIT" });
    if (typeof item.value === "number" && !Number.isFinite(item.value)) throw new ActionError({ reason: "PARAMS_INVALID" });
    if (!record(item.value) && !Array.isArray(item.value)) continue;
    for (const [key, value] of Object.entries(item.value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new ActionError({ reason: "PARAMS_UNSAFE_PATH" });
      const path = [...item.path, key];
      if (["tabRef", "nodeRef", "fromNodeRef", "toNodeRef", "documentRef", "targetRef"].includes(key) && typeof value === "string" &&
        /^(tr1|nr1|dr1)\./u.test(value) && !bindings.some((binding) => isPrefix(binding.path, path))) throw new ActionError({ reason: "DURABLE_BINDING_REQUIRED" });
      pending.push({ value, path });
    }
  }
}
export function compileInstructions(value: unknown, parse: ParseInstruction): CompiledAction {
  if (!Array.isArray(value) || value.length === 0 || value.length > COMMAND_CATALOG.limits["command.actions.maximum_steps"]) throw new ActionError({ reason: "STEP_COUNT_INVALID" });
  let json: string;
  try { json = JSON.stringify(value); } catch { throw new ActionError({ reason: "PARAMS_INVALID" }); }
  if (new TextEncoder().encode(json).byteLength > COMMAND_CATALOG.limits["command.actions.maximum_bytes"]) throw new ActionError({ reason: "BODY_LIMIT" });
  const instructions: ActionInstruction[] = [], permissions = new Set<string>(), capabilities = new Set<string>(), diagnostics: CompileDiagnostic[] = [];
  const aliases = new Map<string, string>();
  const entries = COMMAND_CATALOG.byMethod as Readonly<Record<string, {schemaVersion: number; requiredPermission: string; capabilityRequirements: readonly string[]; parameterFields: readonly { fieldName: string; required: boolean }[]}>>;
  for (let index = 0; index < value.length; index += 1) {
    const step: unknown = value[index];
    if (!record(step) || !onlyKeys(step, ["method", "schemaVersion", "params", "bindings", "delayMs"]) || typeof step.method !== "string" ||
      !record(step.params) || !integer(step.schemaVersion, 1) || !integer(step.delayMs ?? 0, 0, COMMAND_CATALOG.limits["command.actions.maximum_delay_ms"])) throw new ActionError({ reason: "STEP_INVALID", step: index });
    const entry = entries[step.method];
    if (entry === undefined || entry.schemaVersion !== step.schemaVersion || step.method.startsWith("actions.") || step.method.startsWith("recording.")) throw new ActionError({ reason: "COMMAND_NOT_ALLOWED", step: index });
    const bindings: ActionBinding[] = [];
    if (step.bindings !== undefined) {
      if (!Array.isArray(step.bindings) || step.bindings.length > COMMAND_CATALOG.limits["command.actions.maximum_bindings"]) throw new ActionError({ reason: "BINDINGS_INVALID", step: index });
      for (const candidate of step.bindings) {
        if (!record(candidate) || !onlyKeys(candidate, ["path", "source"]) || !validPath(candidate.path)) throw new ActionError({ reason: "BINDING_INVALID", step: index });
        const resolvedSource = source(candidate.source, index);
        if (resolvedSource === null || bindings.some((binding) => isPrefix(binding.path, candidate.path as string[]) || isPrefix(candidate.path as string[], binding.path))) throw new ActionError({ reason: "BINDING_INVALID", step: index });
        bindings.push({ path: [...candidate.path], source: resolvedSource });
        const tab = resolvedSource.kind === "tab" ? resolvedSource : resolvedSource.kind === "element" && resolvedSource.tab.kind === "tab" ? resolvedSource.tab : null;
        if (tab?.alias !== undefined) {
          const selector = JSON.stringify([tab.selector.urlPattern, tab.selector.urlMatch ?? "glob", tab.selector.title, tab.selector.windowId]);
          if (aliases.has(tab.alias) && aliases.get(tab.alias) !== selector) throw new ActionError({ reason: "ALIAS_SELECTOR_CONFLICT", step: index });
          aliases.set(tab.alias, selector);
        }
        if (resolvedSource.kind === "tab" || resolvedSource.kind === "element" && resolvedSource.tab.kind === "tab") permissions.add("tabs.read");
        if (resolvedSource.kind === "element") permissions.add("dom.query");
      }
    }
    const params = structuredClone(step.params);
    checkStructure(params, bindings);
    const fields = new Set(entry.parameterFields.map((field) => field.fieldName));
    if (Object.keys(params).some((key) => !fields.has(key)) || bindings.some((binding) => !fields.has(binding.path[0]!)) ||
      entry.parameterFields.some((field) => field.required && !Object.hasOwn(params, field.fieldName) && !bindings.some((binding) => binding.path.length === 1 && binding.path[0] === field.fieldName))) throw new ActionError({ reason: "PARAMS_INVALID", step: index });
    const primitive = bindings.length === 0 ? parse({ method: step.method, schemaVersion: step.schemaVersion, params }) : null;
    if (bindings.length === 0 && primitive === null) throw new ActionError({ reason: "PARAMS_INVALID", step: index });
    if (bindings.length > 0) {
      const probe = structuredClone(params); let completeProbe = true;
      for (const binding of bindings) {
        const type = binding.source.kind === "element" ? "node_ref" : binding.source.kind === "tab" ? "tab_ref" : binding.source.valueType;
        if (type === "node_ref") setPath(probe, binding.path, `nr1.${"A".repeat(43)}`);
        else if (type === "tab_ref") setPath(probe, binding.path, SAMPLE_TAB);
        else if (type === "window_id") setPath(probe, binding.path, 1);
        else completeProbe = false;
      }
      if (completeProbe && parse({ method: step.method, schemaVersion: step.schemaVersion, params: probe }) === null) throw new ActionError({ reason: "PARAMS_INVALID", step: index });
    }
    // Bound values are checked against their declared type and the complete command parser immediately before dispatch.
    if (bindings.length > 0) diagnostics.push({ step: index, code: "BOUND_PARAMS_CHECKED_AT_RUN", paths: bindings.map((binding) => binding.path) });
    permissions.add(entry.requiredPermission); entry.capabilityRequirements.forEach((id) => capabilities.add(id));
    if (step.method === "ensure.run" && record(params.action) && typeof params.action.method === "string") {
      const children = [params.action, ...(Array.isArray(params.corrections) ? params.corrections : [])];
      for (const candidate of children) {
        const child = record(candidate) && typeof candidate.method === "string" ? entries[candidate.method] : undefined;
        if (child !== undefined) { permissions.add(child.requiredPermission); child.capabilityRequirements.forEach((id) => capabilities.add(id)); }
        if (record(candidate) && record(candidate.target)) permissions.add(candidate.target.kind === "node" ? "dom.describe" : "dom.query");
      }
      const conditions: unknown[] = [params.precondition, params.goal]; let visited = 0;
      while (conditions.length > 0 && ++visited <= COMMAND_CATALOG.limits["command.ensure.maximum_condition_nodes"] * 2) {
        const condition = conditions.pop();
        if (!record(condition)) continue;
        if (condition.kind === "all" || condition.kind === "any") { if (Array.isArray(condition.conditions)) conditions.push(...condition.conditions); continue; }
        if (condition.kind === "not") { conditions.push(condition.condition); continue; }
        if (typeof condition.kind === "string" && (condition.kind.startsWith("window_") || condition.kind === "viewport")) permissions.add("windows.read");
        else if (condition.kind === "javascript") permissions.add("js.execute");
        else permissions.add("page.wait");
        if (record(condition.target)) permissions.add(condition.target.kind === "node" ? "dom.describe" : "dom.query");
      }
      if (params.scrollIntoView !== false || params.searchByScrolling === true) permissions.add("dom.scroll");
      if (params.action.method.startsWith("virtualMouse.") || params.action.method === "virtualKeyboard.input") permissions.add("input.calibrate");
    }
    const defaults = COMMAND_CATALOG.parameterDefaultsByMethod[step.method as keyof typeof COMMAND_CATALOG.parameterDefaultsByMethod];
    // Persist the public command envelope. Parser-only expansions (for example shortcut.actions) are execution details.
    instructions.push({ method: step.method, schemaVersion: step.schemaVersion, params: { ...defaults, ...params }, bindings, delayMs: step.delayMs as number ?? 0 });
  }
  return { instructions, diagnostics, permissions: [...permissions].sort(), capabilities: [...capabilities].sort(), runnable: true };
}
