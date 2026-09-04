export const NATIVE_INPUT_MESSAGE_CHANNEL = "browser-key-automation.native-input.v1";

export interface NativeInputClickRequest {
  readonly kind: "native.input.click";
  readonly requestId: string;
  readonly routeId: string;
  readonly timeoutMs: number;
  readonly marker: string;
  readonly point: { readonly x: number; readonly y: number };
  readonly viewport: { readonly width: number; readonly height: number };
}

export interface NativeKeyboardKey {
  readonly virtualKey: number;
  readonly extended: boolean;
}

export type NativeKeyboardAction =
  | { readonly kind: "press"; readonly keys: readonly NativeKeyboardKey[]; readonly holdMs: number }
  | { readonly kind: "down" | "up"; readonly keys: readonly NativeKeyboardKey[] }
  | { readonly kind: "wait"; readonly waitMs: number };

export interface NativeKeyboardMistake {
  readonly index: number;
  readonly wrong: string;
  readonly beforeBackspaceMs: number;
  readonly beforeCorrectionMs: number;
}

export type NativeKeyboardOperation =
  | { readonly kind: "press"; readonly actions: readonly NativeKeyboardAction[] }
  | { readonly kind: "reset" }
  | { readonly kind: "type"; readonly text: string }
  | {
      readonly kind: "type_human";
      readonly text: string;
      readonly delaysMs: readonly number[];
      readonly mistakes: readonly NativeKeyboardMistake[];
    };

export interface NativeInputKeyboardRequest {
  readonly kind: "native.input.keyboard";
  readonly requestId: string;
  readonly routeId: string;
  readonly timeoutMs: number;
  readonly marker: string | null;
  readonly operation: NativeKeyboardOperation;
}

export type NativeInputClickResponse =
  | {
      readonly kind: "native.input.result";
      readonly requestId: string;
      readonly ok: true;
      readonly result: { readonly status: "input_sent" };
    }
  | {
      readonly kind: "native.input.result";
      readonly requestId: string;
      readonly ok: false;
      readonly error: {
        readonly reason: string;
        readonly phase: "prepare" | "input";
        readonly clickState: "not_sent" | "unknown";
      };
    };

export type NativeInputKeyboardResponse =
  | {
      readonly kind: "native.keyboard.result";
      readonly requestId: string;
      readonly ok: true;
      readonly result: {
        readonly status: "input_sent";
        readonly completedActions: number;
        readonly submittedScalars: number;
        readonly correctedMistakes: number;
        readonly heldVirtualKeys: readonly number[];
      };
    }
  | {
      readonly kind: "native.keyboard.result";
      readonly requestId: string;
      readonly ok: false;
      readonly error: {
        readonly reason: string;
        readonly phase: "prepare" | "input";
        readonly inputState: "not_sent" | "partially_sent" | "unknown";
        readonly completedActions: number;
      };
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNativeInputClickResponse(value: unknown, requestId?: string): value is NativeInputClickResponse {
  if (!isRecord(value)) return false;
  const candidate = value;
  if (candidate.kind !== "native.input.result" || typeof candidate.requestId !== "string" ||
      requestId !== undefined && candidate.requestId !== requestId || typeof candidate.ok !== "boolean") return false;
  if (candidate.ok) {
    const result = candidate.result;
    return typeof result === "object" && result !== null && Reflect.get(result, "status") === "input_sent";
  }
  const error = candidate.error;
  return typeof error === "object" && error !== null && typeof Reflect.get(error, "reason") === "string" &&
    (Reflect.get(error, "phase") === "prepare" || Reflect.get(error, "phase") === "input") &&
    (Reflect.get(error, "clickState") === "not_sent" || Reflect.get(error, "clickState") === "unknown");
}


export function isNativeInputKeyboardResponse(value: unknown, requestId?: string): value is NativeInputKeyboardResponse {
  if (!isRecord(value) || value.kind !== "native.keyboard.result" || typeof value.requestId !== "string" ||
      requestId !== undefined && value.requestId !== requestId || typeof value.ok !== "boolean") return false;
  if (value.ok) {
    const result = value.result;
    return isRecord(result) && result.status === "input_sent" && Number.isSafeInteger(result.completedActions) &&
      Number.isSafeInteger(result.submittedScalars) && Number.isSafeInteger(result.correctedMistakes) &&
      Array.isArray(result.heldVirtualKeys) && result.heldVirtualKeys.every((key) => Number.isSafeInteger(key) && key > 0 && key < 256);
  }
  const error = value.error;
  return isRecord(error) && typeof error.reason === "string" &&
    (error.phase === "prepare" || error.phase === "input") &&
    (error.inputState === "not_sent" || error.inputState === "partially_sent" || error.inputState === "unknown") &&
    Number.isSafeInteger(error.completedActions) && (error.completedActions as number) >= 0;
}
