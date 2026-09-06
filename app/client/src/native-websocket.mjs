import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import { TRANSPORT } from "./generated-config.mjs";

const WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export class NativeWebSocket {
  #socket;
  #buffer = Buffer.alloc(0);
  #changeWaiters = new Set();
  #closedError;
  #closing = false;
  #maximumMessageBytes;

  constructor(socket, initialBytes, maximumMessageBytes) {
    this.#socket = socket;
    this.#buffer = initialBytes;
    this.#maximumMessageBytes = maximumMessageBytes;
    socket.on("data", (chunk) => {
      if (this.#buffer.length + chunk.length > this.#maximumMessageBytes + 256) {
        this.#closedError = new Error("WebSocket receive buffer exceeded limit");
        socket.destroy();
        this.#notifyChange();
        return;
      }
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#notifyChange();
    });
    socket.on("error", (error) => {
      this.#closedError = error;
      this.#notifyChange();
    });
    socket.on("close", () => {
      this.#closedError ??= new Error("WebSocket closed");
      this.#notifyChange();
    });
  }

  static async connect({
    host = TRANSPORT.host,
    port = TRANSPORT.port,
    path,
    subprotocol,
    origin,
    timeoutMs = TRANSPORT.handshakeTimeoutMs,
    maximumMessageBytes = TRANSPORT.maximumMessageBytes,
  }) {
    const socket = net.createConnection({ host, port });
    await waitForSocketConnect(socket, timeoutMs);
    try {
      const key = randomBytes(16).toString("base64");
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Protocol: ${subprotocol}`,
      ];
      if (origin !== undefined) lines.push(`Origin: ${origin}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);

      const { head, remainder } = await readHttpHead(socket, timeoutMs);
      const responseLines = head.toString("ascii").split("\r\n");
      if (responseLines[0] !== "HTTP/1.1 101 Switching Protocols") {
        throw new Error(`Unexpected upgrade status: ${responseLines[0]}`);
      }
      const headers = new Map();
      for (const line of responseLines.slice(1)) {
        if (line.length === 0) continue;
        const colon = line.indexOf(":");
        if (colon < 1) throw new Error(`Malformed response header: ${line}`);
        const name = line.slice(0, colon).toLowerCase();
        if (headers.has(name)) throw new Error(`Duplicate response header: ${name}`);
        headers.set(name, line.slice(colon + 1).trim());
      }
      const expectedAccept = createHash("sha1")
        .update(key)
        .update(WEB_SOCKET_GUID)
        .digest("base64");
      if (headers.get("sec-websocket-accept") !== expectedAccept) {
        throw new Error("Invalid Sec-WebSocket-Accept");
      }
      if (headers.get("sec-websocket-protocol") !== subprotocol) {
        throw new Error("Relay selected the wrong subprotocol");
      }
      if (remainder.length > maximumMessageBytes + 256) {
        throw new Error("WebSocket receive buffer exceeded limit");
      }
      return new NativeWebSocket(socket, remainder, maximumMessageBytes);
    } catch (error) {
      await closeRawSocket(socket);
      throw error;
    }
  }

  #notifyChange() {
    for (const resolve of this.#changeWaiters) resolve();
    this.#changeWaiters.clear();
  }

  async #readExact(length, deadline) {
    while (this.#buffer.length < length) {
      if (this.#closedError) throw this.#closedError;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${length} WebSocket bytes`);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#changeWaiters.delete(onChange);
          reject(new Error(`Timed out waiting for ${length} WebSocket bytes`));
        }, remaining);
        const onChange = () => {
          clearTimeout(timer);
          resolve();
        };
        this.#changeWaiters.add(onChange);
      });
    }
    const result = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return result;
  }

  async readBinary(timeoutMs = TRANSPORT.defaultReadTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const first = await this.#readExact(2, deadline);
    const fin = (first[0] & 0x80) !== 0;
    const opcode = first[0] & 0x0f;
    const masked = (first[1] & 0x80) !== 0;
    if (!fin || (first[0] & 0x70) !== 0 || masked || opcode !== 2) {
      throw new Error(`Unexpected server frame fin=${fin} masked=${masked} opcode=${opcode}`);
    }
    let length = first[1] & 0x7f;
    if (length === 126) {
      const bytes = await this.#readExact(2, deadline);
      length = bytes.readUInt16BE(0);
      if (length < 126) throw new Error("Non-canonical server frame length");
    } else if (length === 127) {
      const bytes = await this.#readExact(8, deadline);
      const value = bytes.readBigUInt64BE(0);
      if (value <= 65535n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Invalid server frame length");
      }
      length = Number(value);
    }
    if (length > this.#maximumMessageBytes) throw new Error("WebSocket message exceeded limit");
    return this.#readExact(length, deadline);
  }

  async readJson(timeoutMs = TRANSPORT.defaultReadTimeoutMs) {
    return JSON.parse(utf8Decoder.decode(await this.readBinary(timeoutMs)));
  }

  sendBinary(payload) {
    this.#sendFrame(2, payload, false);
  }

  #sendFrame(opcode, payload, endSocket) {
    const body = Buffer.from(payload);
    const mask = randomBytes(4);
    let header;
    if (body.length <= 125) {
      header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
    } else if (body.length <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(body.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(body.length), 2);
    }
    const masked = Buffer.alloc(body.length);
    for (let index = 0; index < body.length; index += 1) {
      masked[index] = body[index] ^ mask[index & 3];
    }
    const frame = Buffer.concat([header, mask, masked]);
    if (endSocket) this.#socket.end(frame);
    else this.#socket.write(frame);
  }

  sendJson(value) {
    this.sendBinary(Buffer.from(JSON.stringify(value), "utf8"));
  }

  close() {
    if (this.#closing || this.#socket.destroyed || this.#socket.writableEnded) return;
    this.#closing = true;
    this.#sendFrame(8, Buffer.alloc(0), true);
    void closeRawSocket(this.#socket);
  }
}

async function closeRawSocket(socket) {
  if (socket.destroyed) return;
  const closed = new Promise((resolve) => socket.once("close", resolve));
  if (!socket.writableEnded) socket.end();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, 250);
  });
  await Promise.race([closed, timeout]);
  clearTimeout(timer);
  if (!socket.destroyed) socket.destroy();
}

async function waitForSocketConnect(socket, timeoutMs) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("Timed out connecting to relay"));
    }, timeoutMs);
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

async function readHttpHead(socket, timeoutMs) {
  let buffer = Buffer.alloc(0);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const marker = buffer.indexOf("\r\n\r\n");
    if (marker >= 0) {
      return {
        head: buffer.subarray(0, marker + 4),
        remainder: buffer.subarray(marker + 4),
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Timed out waiting for HTTP upgrade response");
    const chunk = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for HTTP upgrade response"));
      }, remaining);
      const onData = (value) => {
        cleanup();
        resolve(value);
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Relay closed during HTTP upgrade"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      socket.once("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > TRANSPORT.maximumHttpHeadBytes) throw new Error("HTTP upgrade response exceeded limit");
  }
}
