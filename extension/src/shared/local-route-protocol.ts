export type LocalRouteRequest =
  | { readonly kind: "route.local.open"; readonly requestId: string; readonly durationMs: number }
  | { readonly kind: "route.local.close"; readonly requestId: string; readonly routeId: string };
export type LocalRouteResponse = {
  readonly kind: "route.local.result";
  readonly requestId: string;
} & (
  | { readonly ok: true; readonly result: { readonly routeId: string } | { readonly closed: boolean } }
  | { readonly ok: false; readonly error: { readonly reason: string } }
);
export interface LocalRouteConnection { readonly connectionGeneration: number; readonly relayEpoch: string }
export interface LocalRouteReceipt extends LocalRouteConnection {
  // Only an original App response confirms settlement. A local timeout or
  // connection failure does not prove whether open/close happened in the App.
  readonly confirmed: boolean;
  readonly response: LocalRouteResponse;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function token(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 128; }
function routeId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/u.test(value) && BigInt(value) <= 18446744073709551615n;
}
export function isLocalRouteRequest(value: unknown): value is LocalRouteRequest {
  if (!record(value) || !token(value.requestId)) return false;
  if (value.kind === "route.local.open") return exact(value, ["kind", "requestId", "durationMs"]) &&
    typeof value.durationMs === "number" && Number.isSafeInteger(value.durationMs) && value.durationMs > 0 && value.durationMs <= 0xffffffff;
  return value.kind === "route.local.close" && exact(value, ["kind", "requestId", "routeId"]) && routeId(value.routeId);
}
export function isLocalRouteResponse(value: unknown, request: LocalRouteRequest): value is LocalRouteResponse {
  if (!record(value) || value.kind !== "route.local.result" || value.requestId !== request.requestId) return false;
  if (value.ok === false) return exact(value, ["kind", "requestId", "ok", "error"]) && record(value.error) &&
    exact(value.error, ["reason"]) && token(value.error.reason);
  if (value.ok !== true || !exact(value, ["kind", "requestId", "ok", "result"]) || !record(value.result)) return false;
  return request.kind === "route.local.open"
    ? exact(value.result, ["routeId"]) && routeId(value.result.routeId)
    : exact(value.result, ["closed"]) && typeof value.result.closed === "boolean";
}
export function isLocalRouteReceipt(value: unknown, request: LocalRouteRequest, connection: LocalRouteConnection): value is LocalRouteReceipt {
  return record(value) && exact(value, ["connectionGeneration", "relayEpoch", "confirmed", "response"]) &&
    value.connectionGeneration === connection.connectionGeneration && value.relayEpoch === connection.relayEpoch &&
    typeof value.confirmed === "boolean" && isLocalRouteResponse(value.response, request);
}
export function localRouteFailure(requestId: string, reason: string): LocalRouteResponse {
  return { kind: "route.local.result", requestId, ok: false, error: { reason } };
}
