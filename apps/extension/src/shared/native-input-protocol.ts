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

export function isNativeInputClickResponse(value: unknown, requestId?: string): value is NativeInputClickResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
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
