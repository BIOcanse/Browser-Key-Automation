export class CdpClient {
  static async connect(webSocketUrl) {
    const client = new CdpClient(webSocketUrl);
    await client.open();
    return client;
  }

  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.webSocket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  open() {
    return new Promise((resolve, reject) => {
      const webSocket = new WebSocket(this.webSocketUrl);
      this.webSocket = webSocket;
      const openingTimeout = setTimeout(() => {
        reject(new Error("CDP WebSocket open timed out"));
        webSocket.close();
      }, 10_000);
      webSocket.addEventListener("open", () => {
        clearTimeout(openingTimeout);
        resolve();
      }, { once: true });
      webSocket.addEventListener("error", () => {
        clearTimeout(openingTimeout);
        reject(new Error("CDP WebSocket failed"));
      }, { once: true });
      webSocket.addEventListener("message", (event) => this.handleMessage(event.data));
      webSocket.addEventListener("close", () => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timeoutId);
          pending.reject(new Error("CDP WebSocket closed"));
        }
        this.pending.clear();
      });
    });
  }

  send(method, params = {}, timeoutMs = 15_000, sessionId) {
    if (this.webSocket === null || this.webSocket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP WebSocket is not open"));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeoutId });
      this.webSocket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  }

  handleMessage(rawMessage) {
    let message;
    try {
      message = JSON.parse(String(rawMessage));
    } catch {
      return;
    }
    if (!Number.isSafeInteger(message?.id)) return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    clearTimeout(pending.timeoutId);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(`CDP command failed: ${String(message.error.message || "unknown error")}`));
      return;
    }
    pending.resolve(message.result ?? {});
  }

  close() {
    try {
      this.webSocket?.close();
    } catch {
      // Test cleanup remains best effort.
    }
  }
}

export async function runtimeEvaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description;
    throw new Error(typeof description === "string" ? description : "Runtime.evaluate failed");
  }
  return response.result?.value;
}

export function pageEvaluate(client, callback, argument = {}) {
  const expression = `(${callback.toString()})(${JSON.stringify(argument)})`;
  return runtimeEvaluate(client, expression);
}
