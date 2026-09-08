import type { MouseAction, VirtualInputResult } from "../shared/virtual-input-protocol.js";
import { COMMAND_CATALOG } from "../generated/command-config.js";

export class VirtualMouseError extends Error {
  readonly code = "NATIVE_INPUT_FAILED" as const;
  constructor(readonly reason: string, readonly progress?: VirtualInputResult) { super(reason); this.name = "VirtualMouseError"; }
  get details(): Readonly<Record<string, unknown>> { return { backend: "virtualInput", reason: this.reason,
    ...(this.progress === undefined ? {} : { progress: this.progress, progressCoordinates: this.progress.input?.mouse.coordinates ?? "css_viewport" }) }; }
}

export function parseMouseActions(value: unknown, maximum: number, maximumWaitMs = COMMAND_CATALOG.limits["command.virtualMouse.maximum_wait_ms"]): readonly MouseAction[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) return null;
  const output: MouseAction[] = [];
  const int = (x: unknown, min: number, max: number): x is number => Number.isSafeInteger(x) && (x as number) >= min && (x as number) <= max;
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const keys = Object.keys(item).sort().join(",");
    if ((item.kind === "move" || item.kind === "moveWindow") && keys === "kind,x,y" && int(item.x, 0, 32767) && int(item.y, 0, 32767)) {
      output.push({ kind: item.kind, x: item.x, y: item.y });
    } else if (item.kind === "button" && keys === "action,button,kind" &&
        ["left", "right", "middle", "back", "forward"].includes(item.button) && ["press", "down", "up"].includes(item.action)) {
      output.push({ kind: "button", button: item.button, action: item.action });
    } else if (item.kind === "wheel" && keys === "deltaX,deltaY,kind" && int(item.deltaX, -32768, 32767) && int(item.deltaY, -32768, 32767)) {
      output.push({ kind: "wheel", deltaX: item.deltaX, deltaY: item.deltaY });
    } else if (item.kind === "wait" && keys === "kind,waitMs" && int(item.waitMs, 0, maximumWaitMs)) {
      output.push({ kind: "wait", waitMs: item.waitMs });
    } else return null;
  }
  return output;
}
