import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import test from "node:test";

import { NativeWebSocket } from "../apps/client/src/native-websocket.mjs";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

test("an HTTP upgrade timeout closes the connected raw socket", async () => {
  const fixture = await listenFixture((socket) => socket.resume());
  try {
    const connecting = NativeWebSocket.connect({
      port: fixture.port,
      path: "/v1/client",
      subprotocol: "browser-key-client-v1",
      timeoutMs: 100,
    });
    const peer = await fixture.peer;
    const peerEnded = onceWithTimeout(peer, "end", 1_000);
    await assert.rejects(connecting, /Timed out waiting for HTTP upgrade response/u);
    await peerEnded;
  } finally {
    await fixture.close();
  }
});

test("a malformed HTTP upgrade closes the connected raw socket", async () => {
  const fixture = await listenFixture((socket) => {
    socket.once("data", () => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nMalformed\r\n\r\n");
    });
  });
  try {
    const connecting = NativeWebSocket.connect({
      port: fixture.port,
      path: "/v1/client",
      subprotocol: "browser-key-client-v1",
      timeoutMs: 500,
    });
    const peer = await fixture.peer;
    const peerEnded = onceWithTimeout(peer, "end", 1_000);
    await assert.rejects(connecting, /Malformed response header/u);
    await peerEnded;
  } finally {
    await fixture.close();
  }
});

test("an oversized server frame is rejected from its declared length", async () => {
  const fixture = await listenFixture((socket) => {
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk.toString("ascii");
      if (!request.includes("\r\n\r\n")) return;
      const key = /^Sec-WebSocket-Key: (.+)$/imu.exec(request)?.[1]?.trim();
      assert.equal(typeof key, "string");
      const accept = createHash("sha1").update(key).update(GUID).digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n` +
          "Sec-WebSocket-Protocol: browser-key-client-v1\r\n\r\n",
      );
      const frameHead = Buffer.alloc(10);
      frameHead[0] = 0x82;
      frameHead[1] = 127;
      frameHead.writeBigUInt64BE(65_537n, 2);
      socket.write(frameHead);
      socket.removeAllListeners("data");
    });
  });
  let client;
  try {
    client = await NativeWebSocket.connect({
      port: fixture.port,
      path: "/v1/client",
      subprotocol: "browser-key-client-v1",
      timeoutMs: 500,
    });
    await assert.rejects(client.readBinary(500), /WebSocket message exceeded limit/u);
  } finally {
    client?.close();
    await fixture.close();
  }
});

test("a business read timeout exits even when the peer keeps its half open", async () => {
  const fixture = await listenFixture((socket) => {
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk.toString("ascii");
      if (!request.includes("\r\n\r\n")) return;
      const key = /^Sec-WebSocket-Key: (.+)$/imu.exec(request)?.[1]?.trim();
      const accept = createHash("sha1").update(key).update(GUID).digest("base64");
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: browser-key-client-v1\r\n\r\n`);
      socket.removeAllListeners("data");
      socket.resume();
    });
  });
  const moduleUrl = new URL("../apps/client/src/native-websocket.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { NativeWebSocket } from ${JSON.stringify(moduleUrl)};
    const client = await NativeWebSocket.connect({ port: ${fixture.port}, path: '/v1/client', subprotocol: 'browser-key-client-v1' });
    try { await client.readJson(100); process.exitCode = 1; }
    catch { process.exitCode = 6; }
    finally { client.close(); }
  `], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const [code] = await onceWithTimeout(child, "exit", 3000);
    assert.equal(code, 6, stderr);
  } finally {
    if (child.exitCode === null) child.kill();
    await fixture.close();
  }
});

test("server RSV bits and malformed UTF-8 are rejected instead of normalized", async () => {
  for (const bytes of [Buffer.from([0xc2, 2, 0x7b, 0x7d]), Buffer.from([0x82, 3, 0x22, 0xff, 0x22])]) {
    const socket = new net.Socket();
    const client = new NativeWebSocket(socket, bytes, 65_536);
    try { await assert.rejects(client.readJson(100)); }
    finally { socket.destroy(); }
  }
});

async function listenFixture(onConnection) {
  let resolvePeer;
  const peer = new Promise((resolve) => {
    resolvePeer = resolve;
  });
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    resolvePeer(socket);
    onConnection(socket);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    peer,
    async close() {
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function onceWithTimeout(emitter, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const cleanup = () => {
      clearTimeout(timer);
      emitter.off(event, onEvent);
    };
    emitter.once(event, onEvent);
  });
}
