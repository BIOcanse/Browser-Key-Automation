import type { MouseAction } from "../shared/virtual-input-protocol.js";
import { parseMouseActions } from "./virtual-mouse-model.js";

export type MouseShortcutMethod = "virtualMouse.move" | "virtualMouse.moveWindow" | "virtualMouse.click" | "virtualMouse.down" |
  "virtualMouse.up" | "virtualMouse.drag" | "virtualMouse.scroll";

const fields: Record<MouseShortcutMethod, readonly string[]> = {
  "virtualMouse.move": ["x", "y"],
  "virtualMouse.moveWindow": ["x", "y"],
  "virtualMouse.click": ["at", "button"],
  "virtualMouse.down": ["button"],
  "virtualMouse.up": ["button"],
  "virtualMouse.drag": ["from", "to", "via", "button"],
  "virtualMouse.scroll": ["at", "deltaX", "deltaY"],
};

function point(value: unknown): Extract<MouseAction, { kind: "move" }> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "x,y") return null;
  const x: unknown = Reflect.get(value, "x"), y: unknown = Reflect.get(value, "y");
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || (x as number) < 0 || (x as number) > 32767 ||
      (y as number) < 0 || (y as number) > 32767) return null;
  return { kind: "move", x: x as number, y: y as number };
}

/** Defaults are expanded by the command boundary. This compiler owns no mouse
 * state and performs no I/O; its entire output is one existing input request. */
export function expandMouseShortcut(method: MouseShortcutMethod, params: Record<string, unknown>, maximum: number): readonly MouseAction[] | null {
  const expected = ["tabRef", "timeoutMs", ...fields[method]];
  if (Object.keys(params).length !== expected.length || !expected.every((name) => Object.hasOwn(params, name))) return null;
  const actions: MouseAction[] = [];
  const location = method === "virtualMouse.click" || method === "virtualMouse.scroll" ? params.at :
    method === "virtualMouse.drag" ? params.from : null;
  if (location !== null) {
    const move = point(location);
    if (move === null) return null;
    actions.push(move);
  }
  const button = params.button as Extract<MouseAction, { kind: "button" }>["button"];
  switch (method) {
    case "virtualMouse.move": case "virtualMouse.moveWindow": {
      const move = point({ x: params.x, y: params.y });
      if (move === null) return null;
      actions.push({ ...move, kind: method === "virtualMouse.moveWindow" ? "moveWindow" : "move" });
      break;
    }
    case "virtualMouse.click": actions.push({ kind: "button", button, action: "press" }); break;
    case "virtualMouse.down": actions.push({ kind: "button", button, action: "down" }); break;
    case "virtualMouse.up": actions.push({ kind: "button", button, action: "up" }); break;
    case "virtualMouse.scroll": actions.push({ kind: "wheel", deltaX: params.deltaX as number, deltaY: params.deltaY as number }); break;
    case "virtualMouse.drag": {
      const to = point(params.to);
      if (to === null || !Array.isArray(params.via) || params.via.length > maximum - actions.length - 3) return null;
      actions.push({ kind: "button", button, action: "down" });
      for (const value of params.via) {
        const move = point(value);
        if (move === null) return null;
        actions.push(move);
      }
      actions.push(to, { kind: "button", button, action: "up" });
      break;
    }
  }
  return parseMouseActions(actions, maximum);
}
