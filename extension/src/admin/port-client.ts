import { ADMIN_PORT_NAME, type AdminError, type AdminMethod, type AdminMethodMap,
  type AdminRequest, type AdminResponse } from "../shared/admin-protocol.js";

const MAX_PENDING_REQUESTS = 32;
const REQUEST_TIMEOUT_MS = 10_000;
interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timeoutId: number;
}

export class AdminClientError extends Error {
  constructor(readonly adminError: AdminError) {
    super(`${adminError.code}: ${adminError.message}`);
    this.name = "AdminClientError";
  }
}
export class AdminRequestUncertainError extends Error {
  constructor(readonly messageKey: "requestTimeout" | "deliveryFailed" | "connectionLost", options?: ErrorOptions) {
    super(messageKey, options);
    this.name = "AdminRequestUncertainError";
  }
}
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function isAdminResponse(value: unknown): value is AdminResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.requestId !== "string" || typeof record.ok !== "boolean") return false;
  return record.ok ? "result" in record : typeof record.error === "object" && record.error !== null;
}

export class AdminPortClient {
  #port: ChromeRuntimePort | null = null;
  readonly #pending = new Map<string, PendingRequest>();
  constructor(readonly connectionChanged: (state: "connected" | "disconnected") => void = () => {}) {
    this.#connect();
  }
  request<Method extends AdminMethod>(method: Method, params: AdminMethodMap[Method]["params"],
    timeoutMs = REQUEST_TIMEOUT_MS): Promise<AdminMethodMap[Method]["result"]> {
    if (this.#pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error("requestBusy"));
    let port: ChromeRuntimePort;
    try { port = this.#connect(); }
    catch (error) { return Promise.reject(new Error("connectFailed", { cause: error })); }
    const requestId = `ui1.${randomToken()}`;
    const request = { requestId, method, params } as AdminRequest;
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new AdminRequestUncertainError("requestTimeout"));
      }, timeoutMs);
      this.#pending.set(requestId, { resolve: value => resolve(value as AdminMethodMap[Method]["result"]), reject, timeoutId });
      try { port.postMessage(request); }
      catch (error) { this.#handleDisconnect(port, new AdminRequestUncertainError("deliveryFailed", { cause: error })); }
    });
  }
  #connect(): ChromeRuntimePort {
    if (this.#port !== null) return this.#port;
    const port = chrome.runtime.connect({ name: ADMIN_PORT_NAME });
    this.#port = port;
    port.onMessage.addListener(message => this.#handleMessage(port, message));
    port.onDisconnect.addListener(() => this.#handleDisconnect(port));
    this.connectionChanged("connected");
    return port;
  }
  #handleMessage(port: ChromeRuntimePort, message: unknown): void {
    if (this.#port !== port || !isAdminResponse(message)) return;
    const pending = this.#pending.get(message.requestId);
    if (pending === undefined) return;
    window.clearTimeout(pending.timeoutId);
    this.#pending.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new AdminClientError(message.error));
  }
  #handleDisconnect(port: ChromeRuntimePort, error = new AdminRequestUncertainError("connectionLost")): void {
    if (this.#port !== port) return;
    this.#port = null;
    for (const pending of this.#pending.values()) {
      window.clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.#pending.clear();
    this.connectionChanged("disconnected");
  }
}
