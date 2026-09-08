import { COMMAND_CATALOG } from "../../generated/command-config.js";
import { isNodeRefShape, type DomLocatorTarget } from "../dom-service.js";
import { isTabRefShape } from "../tab-service.js";

export type ValueType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "tab_ref" | "node_ref" | "window_id";
export interface TabSelector { readonly urlPattern: string; readonly title: string | null; readonly windowId: number | null; readonly urlMatch?: "glob" | "exact" }
export type TabBinding =
  | { readonly kind: "tab"; readonly selector: TabSelector; readonly alias?: string }
  | { readonly kind: "input"; readonly name: string; readonly valueType: "tab_ref" }
  | { readonly kind: "result"; readonly step: number; readonly path: readonly string[]; readonly valueType: "tab_ref" };
export type ActionSource =
  | { readonly kind: "input"; readonly name: string; readonly valueType: ValueType }
  | { readonly kind: "result"; readonly step: number; readonly path: readonly string[]; readonly valueType: ValueType }
  | Extract<TabBinding, { kind: "tab" }>
  | { readonly kind: "element"; readonly tab: TabBinding; readonly locator: Omit<DomLocatorTarget, "kind" | "tabRef"> };
export interface ActionBinding { readonly path: readonly string[]; readonly source: ActionSource }
export interface ActionInstruction {
  readonly method: string;
  readonly schemaVersion: number;
  readonly params: Readonly<Record<string, unknown>>;
  readonly bindings: readonly ActionBinding[];
  readonly delayMs: number;
}
export interface ActionMetadata {
  readonly actionId: number;
  readonly name: string;
  readonly description: string;
  readonly revision: number;
  readonly stepCount: number;
  readonly byteLength: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface ActionSnapshot extends ActionMetadata { readonly instructions: readonly ActionInstruction[] }
export class ActionError extends Error {
  readonly code = "ACTION_OPERATION_FAILED" as const;
  constructor(readonly details: { readonly reason: string; readonly step?: number; readonly revision?: number }) { super(details.reason); }
}
export const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
export const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
export function text(value: unknown, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0) && new TextEncoder().encode(value).byteLength <= COMMAND_CATALOG.limits["command.actions.maximum_text_bytes"];
}
export function validPath(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= COMMAND_CATALOG.limits["command.actions.maximum_binding_depth"] &&
    value.every((part) => typeof part === "string" && part.length > 0 && part.length <= 256 && !["__proto__", "prototype", "constructor"].includes(part));
}
export function valueMatches(value: unknown, type: ValueType): boolean {
  switch (type) {
    case "tab_ref": return isTabRefShape(value);
    case "node_ref": return isNodeRefShape(value);
    case "window_id": return integer(value, 1);
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "object": return record(value);
    case "array": return Array.isArray(value);
    default: return typeof value === type;
  }
}
export function pathValue(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const part of path) {
    if ((!record(current) && !Array.isArray(current)) || !Object.hasOwn(current, part)) throw new ActionError({ reason: "BINDING_PATH_MISSING" });
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
export function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current: Record<string, unknown> | unknown[] = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const next: unknown = (current as Record<string, unknown>)[path[index]!];
    if ((!record(next) && !Array.isArray(next)) || !Object.hasOwn(current, path[index]!)) throw new ActionError({ reason: "BINDING_PATH_MISSING" });
    current = next;
  }
  const last = path[path.length - 1]!;
  if (Array.isArray(current) && (!/^(0|[1-9][0-9]*)$/u.test(last) || Number(last) >= current.length)) throw new ActionError({ reason: "BINDING_PATH_MISSING" });
  (current as Record<string, unknown>)[last] = value;
}
