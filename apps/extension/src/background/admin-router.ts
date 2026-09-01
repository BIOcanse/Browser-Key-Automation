import {
  ADMIN_PORT_NAME,
  parseAdminRequest,
  type AdminError,
  type AdminResponse,
} from "../shared/admin-protocol.js";
import {
  attachKeySecret,
  createKey,
  KeyServiceError,
  listKeys,
  revealKey,
  revokeKey,
  updateKey,
} from "./key-service.js";

const MAX_IN_FLIGHT_PER_ADMIN_PORT = 8;
const requestIdPattern = /^ui1\.[A-Za-z0-9_-]{22}$/u;

function candidateRequestId(message: unknown): string {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return "ui1.AAAAAAAAAAAAAAAAAAAAAA";
  const value = (message as Record<string, unknown>).requestId;
  return typeof value === "string" && requestIdPattern.test(value) ? value : "ui1.AAAAAAAAAAAAAAAAAAAAAA";
}

function publicError(error: unknown): AdminError {
  if (error instanceof KeyServiceError) {
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof DOMException) {
    return { code: "STORAGE_UNAVAILABLE", message: "Extension storage operation failed" };
  }
  return { code: "INTERNAL_ERROR", message: "Unexpected extension error" };
}

function postResponse(port: ChromeRuntimePort, response: AdminResponse): void {
  try {
    port.postMessage(response);
  } catch {
    // The exact trusted admin route no longer exists. Responses are not transferred elsewhere.
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled admin method: ${String((value as { method?: unknown }).method)}`);
}

async function dispatchRequest(port: ChromeRuntimePort, message: unknown): Promise<void> {
  const request = parseAdminRequest(message);
  if (request === null) {
    postResponse(port, {
      requestId: candidateRequestId(message),
      ok: false,
      error: { code: "SCHEMA_INVALID", message: "Admin request does not match the closed schema" },
    });
    return;
  }

  try {
    let result: unknown;
    switch (request.method) {
      case "keys.create":
        result = await createKey(request.params);
        break;
      case "keys.list":
        result = await listKeys(request.params);
        break;
      case "keys.reveal":
        result = await revealKey(request.params);
        break;
      case "keys.attachSecret":
        result = await attachKeySecret(request.params);
        break;
      case "keys.update":
        result = await updateKey(request.params);
        break;
      case "keys.revoke":
        result = await revokeKey(request.params);
        break;
      default:
        result = assertNever(request);
    }
    postResponse(port, { requestId: request.requestId, ok: true, result });
  } catch (error) {
    postResponse(port, { requestId: request.requestId, ok: false, error: publicError(error) });
  }
}

export function isTrustedAdminPort(port: ChromeRuntimePort): boolean {
  if (port.name !== ADMIN_PORT_NAME || port.sender?.id !== chrome.runtime.id || port.sender.url === undefined) return false;
  return port.sender.url.startsWith(chrome.runtime.getURL("admin/"));
}

export function attachAdminRouter(port: ChromeRuntimePort): void {
  let connected = true;
  let inFlight = 0;

  port.onDisconnect.addListener(() => {
    connected = false;
  });
  port.onMessage.addListener((message) => {
    if (!connected) return;
    if (inFlight >= MAX_IN_FLIGHT_PER_ADMIN_PORT) {
      postResponse(port, {
        requestId: candidateRequestId(message),
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "Admin request concurrency limit reached" },
      });
      return;
    }
    inFlight += 1;
    void dispatchRequest(port, message).finally(() => {
      inFlight -= 1;
    });
  });
}
