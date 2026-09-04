#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

import { NativeWebSocket } from "./native-websocket.mjs";
import { TRANSPORT } from "./generated-config.mjs";
import { ArtifactFileError, saveArtifactFile, savePageFile, saveScreenshotFile, saveElementScreenshotFile } from "./artifact-files.mjs";
import { DemoFileError, openDemoFile } from "./demo-files.mjs";

const EXIT = Object.freeze({
  success: 0,
  internal: 1,
  usage: 2,
  relay: 3,
  transport: 4,
  business: 5,
  deliveryUnknown: 6,
});

const DEFAULT_API_KEY_ENV = "BKA_API_KEY";
const DEFAULT_READ_TIMEOUT_MS = TRANSPORT.defaultReadTimeoutMs;
const MAXIMUM_READ_TIMEOUT_MS = TRANSPORT.maximumReadTimeoutMs;
const API_KEY_PATTERN = /^bk1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u;
const RELAY_EPOCH_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const TRACE_REF_PATTERN = /^xr1\.[A-Za-z0-9_-]{43}$/u;
const INSTANCE_NUMBER_PATTERN = /^[1-9][0-9]*$/u;
const METHOD_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const U64_MAXIMUM = 18_446_744_073_709_551_615n;

class CliFailure extends Error {
  constructor(code, exitCode, delivery, details) {
    super(code);
    this.code = code;
    this.exitCode = exitCode;
    this.delivery = delivery;
    this.details = details;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let activeCommand = null;
  try {
    const request = parseArguments(process.argv.slice(2));
    activeCommand = request.command;
    writeOutput(await execute(request));
  } catch (error) {
    const failure = normalizeFailure(error);
    writeOutput({
      ok: false, ...(activeCommand === null ? {} : { command: activeCommand }),
      ...failure.responseMetadata, delivery: failure.delivery,
      error: { code: failure.code, ...(failure.details === undefined ? {} : { details: failure.details }) },
    });
    process.exitCode = failure.exitCode;
  }
}

// Direct-call convenience uses exactly the CLI's validation, connection,
// instance selection and file-writing path; importing this file runs no CLI.
export function savePage(options) { return execute(fileRequest("page-save", options)); }
export function saveArtifact(options) { return execute(fileRequest("artifact-save", options)); }
export function saveScreenshot(options) { return execute(fileRequest("page-shot", options)); }
export function saveElementScreenshot(options) { return execute(fileRequest("element-shot", options)); }
export function openDemo(options) {
  const args = ["demo-open", options.file];
  if (options.tabRef !== undefined) args.push("--tab-ref", options.tabRef);
  if (options.active !== undefined) args.push("--active", String(options.active));
  if (options.windowId !== undefined) args.push("--window-id", String(options.windowId));
  return execute(parseArguments(connectionArguments(args, options)));
}

function fileRequest(command, options) {
  const refFlag = command === "artifact-save" ? "--artifact-ref" : command === "element-shot" ? "--node-ref" : "--tab-ref";
  const ref = command === "artifact-save" ? options.artifactRef : command === "element-shot" ? options.nodeRef : options.tabRef;
  const args = [command, refFlag, ref, "--output", options.output];
  if (options.format !== undefined) args.push("--format", options.format);
  if (options.quality !== undefined) args.push("--quality", String(options.quality));
  if (options.width !== undefined) args.push("--width", String(options.width));
  if (options.height !== undefined) args.push("--height", String(options.height));
  if (options.region !== undefined) args.push("--region-json", JSON.stringify(options.region));
  return parseArguments(connectionArguments(args, options));
}

function connectionArguments(args, options) {
  if (options.instance !== undefined) args.push("--instance", options.instance);
  if (options.apiKeyEnv !== undefined) args.push("--api-key-env", options.apiKeyEnv);
  if (options.readTimeoutMs !== undefined) args.push("--read-timeout-ms", String(options.readTimeoutMs));
  return args;
}

async function execute(request) {
  if (request.command === "help") return helpOutput();
  const connection = await connectClient(request.readTimeoutMs);
  try {
    if (request.command === "instances") {
      const list = await listInstances(connection, request.readTimeoutMs);
      return {
        ok: true,
        command: "instances",
        relayEpoch: list.relayEpoch,
        relayBuildId: connection.buildId,
        instances: list.instances,
      };
    }
    if (request.command === "stop") {
      return await stopRelay(connection, request.readTimeoutMs);
    }
    const session = await extensionSession(connection, request);
    if (request.command === "call") return await session.forward(request.method, request.params, request.schemaVersion);
    const call = async (method, params) => (await session.forward(method, params, 1)).result;
    if (request.command === "demo-open") {
      const result = await openDemoFile({ call, file: request.file, tabRef: request.tabRef ?? undefined,
        active: request.active, windowId: request.windowId });
      return { ok: true, command: request.command, delivery: "extension_response", targetInstance: session.targetInstance, ...result };
    }
    if (request.command === "element-shot") {
      const result = await saveElementScreenshotFile({ call, nodeRef: request.nodeRef, output: request.output,
        width: request.width, height: request.height, region: request.region });
      return { ok: true, command: request.command, delivery: "local_file", targetInstance: session.targetInstance, ...result };
    }
    const result = request.command === "page-save"
      ? await savePageFile({ call, tabRef: request.tabRef, output: request.output })
      : request.command === "page-shot"
        ? await saveScreenshotFile({ call, tabRef: request.tabRef, output: request.output, format: request.format, quality: request.quality })
        : await saveArtifactFile({ call, artifactRef: request.artifactRef, output: request.output });
    return { ok: true, command: request.command, delivery: "local_file", targetInstance: session.targetInstance, ...result };
  } finally {
    connection.socket.close();
  }
}

async function connectClient(readTimeoutMs) {
  let socket;
  try {
    socket = await NativeWebSocket.connect({
      host: TRANSPORT.host,
      port: TRANSPORT.port,
      path: TRANSPORT.path,
      subprotocol: TRANSPORT.subprotocol,
      timeoutMs: Math.min(readTimeoutMs, TRANSPORT.handshakeTimeoutMs),
      maximumMessageBytes: TRANSPORT.maximumMessageBytes,
    });
  } catch (error) {
    throw failure("RELAY_UNREACHABLE", EXIT.relay, "known_not_delivered", systemDetails(error));
  }

  try {
    const hello = await socket.readJson(Math.min(readTimeoutMs, TRANSPORT.handshakeTimeoutMs));
    validateRelayHello(hello);
    socket.sendJson({ kind: "role.hello", role: "client", protocolVersion: TRANSPORT.protocolVersion });
    const ready = await socket.readJson(Math.min(readTimeoutMs, TRANSPORT.handshakeTimeoutMs));
    if (!hasExactKeys(ready, ["kind", "role"]) || ready.kind !== "role.ready" || ready.role !== "client") {
      throw failure("RELAY_INCOMPATIBLE", EXIT.relay, "known_not_delivered");
    }
    return { socket, relayEpoch: hello.relayEpoch, buildId: hello.buildId };
  } catch (error) {
    socket.close();
    if (error instanceof CliFailure) throw error;
    throw failure("RELAY_INCOMPATIBLE", EXIT.relay, "known_not_delivered", systemDetails(error));
  }
}

async function listInstances(connection, readTimeoutMs) {
  let response;
  try {
    connection.socket.sendJson({ kind: "instances.list" });
    response = await connection.socket.readJson(readTimeoutMs);
  } catch (error) {
    throw failure("INSTANCE_LIST_FAILED", EXIT.transport, "known_not_delivered", systemDetails(error));
  }
  if (
    !hasExactKeys(response, ["kind", "relayEpoch", "instances"]) ||
    response.kind !== "instances.list.result" ||
    response.relayEpoch !== connection.relayEpoch ||
    !Array.isArray(response.instances) ||
    response.instances.length > TRANSPORT.maximumOnlineExtensions
  ) {
    throw failure("INSTANCE_LIST_INVALID", EXIT.relay, "known_not_delivered");
  }

  const seen = new Set();
  for (const instance of response.instances) {
    if (
      !hasExactKeys(instance, ["relayEpoch", "instanceNumber"]) ||
      instance.relayEpoch !== response.relayEpoch ||
      !isCanonicalInstanceNumber(instance.instanceNumber)
    ) {
      throw failure("INSTANCE_LIST_INVALID", EXIT.relay, "known_not_delivered");
    }
    const key = `${instance.relayEpoch}/${instance.instanceNumber}`;
    if (seen.has(key)) throw failure("INSTANCE_LIST_INVALID", EXIT.relay, "known_not_delivered");
    seen.add(key);
  }
  return response;
}

async function extensionSession(connection, request) {
  const list = await listInstances(connection, request.readTimeoutMs);
  const targetInstance = selectInstance(list.instances, request.instance);
  const apiKey = process.env[request.apiKeyEnv];
  if (typeof apiKey !== "string" || !API_KEY_PATTERN.test(apiKey)) {
    throw failure("API_KEY_UNAVAILABLE", EXIT.usage, "known_not_delivered", {
      environmentVariable: request.apiKeyEnv,
    });
  }

  return {
    targetInstance,
    forward: (method, params, schemaVersion) => forwardCommand(connection, request.readTimeoutMs,
      targetInstance, apiKey, method, params, schemaVersion),
  };
}

async function forwardCommand(connection, readTimeoutMs, targetInstance, apiKey, method, params, schemaVersion) {
  const clientRequestId = `cr1.${randomBytes(16).toString("base64url")}`;
  const forward = {
    kind: "forward",
    clientRequestId,
    targetInstance,
    auth: { apiKey },
    command: {
      method, schemaVersion, params,
    },
  };
  const encoded = JSON.stringify(forward);
  if (Buffer.byteLength(encoded, "utf8") > TRANSPORT.maximumMessageBytes) {
    throw failure("REQUEST_TOO_LARGE", EXIT.usage, "known_not_delivered", {
      maximumBytes: TRANSPORT.maximumMessageBytes,
    });
  }

  let response;
  try {
    connection.socket.sendJson(forward);
    response = await connection.socket.readJson(readTimeoutMs);
  } catch (error) {
    throw failure("ROUTE_DELIVERY_UNKNOWN", EXIT.deliveryUnknown, "unknown", systemDetails(error));
  }

  if (isRecord(response) && response.kind === "transport.error" && typeof response.error === "string") {
    throw failure(response.error, EXIT.transport, "unknown");
  }
  if (
    !isRecord(response) ||
    response.kind !== "route.response" ||
    !isRecord(response.payload) ||
    response.payload.clientRequestId !== clientRequestId ||
    typeof response.payload.ok !== "boolean" ||
    !isTraceMetadata(response.payload.trace)
  ) {
    throw failure("ROUTE_RESPONSE_INVALID", EXIT.deliveryUnknown, "unknown");
  }
  const trace = response.payload.trace;

  if (!response.payload.ok) {
    const business = isRecord(response.payload.error) && typeof response.payload.error.code === "string"
      ? response.payload.error : { code: "BUSINESS_ERROR_INVALID" };
    const error = failure(business.code, EXIT.business, "extension_response", business.details);
    error.responseMetadata = { targetInstance, clientRequestId, trace };
    throw error;
  }

  return {
    ok: true,
    command: "call",
    delivery: "extension_response",
    targetInstance,
    clientRequestId,
    trace,
    result: response.payload.result,
  };
}

async function stopRelay(connection, readTimeoutMs) {
  let response;
  try {
    connection.socket.sendJson({ kind: "relay.stop" });
    response = await connection.socket.readJson(readTimeoutMs);
  } catch (error) {
    throw failure("RELAY_STOP_DELIVERY_UNKNOWN", EXIT.deliveryUnknown, "unknown", systemDetails(error));
  }
  if (!hasExactKeys(response, ["kind"]) || response.kind !== "relay.stopping") {
    throw failure("RELAY_STOP_RESPONSE_INVALID", EXIT.deliveryUnknown, "unknown");
  }
  return {
    ok: true,
    command: "stop",
    relayEpoch: connection.relayEpoch,
    stopping: true,
  };
}

export function parseArguments(args) {
  if (args.length === 0) throw usageFailure();
  if (args.length === 1 && (args[0] === "help" || args[0] === "--help" || args[0] === "-h")) {
    return { command: "help" };
  }

  const command = args[0];
  if (!new Set(["instances", "call", "stop", "page-save", "artifact-save", "page-shot", "element-shot", "demo-open"]).has(command)) throw usageFailure();
  const options = {
    command,
    method: null,
    schemaVersion: 1,
    params: {},
    instance: null,
    apiKeyEnv: DEFAULT_API_KEY_ENV,
    readTimeoutMs: DEFAULT_READ_TIMEOUT_MS,
    output: null, tabRef: null, artifactRef: null, file: null,
  };
  const seenOptions = new Set();
  let index = 1;
  if (command === "demo-open") {
    if (typeof args[index] !== "string" || !args[index].trim() || args[index].startsWith("--")) throw usageFailure();
    options.file = args[index];
    index += 1;
  }
  while (index < args.length) {
    const name = args[index];
    const value = args[index + 1];
    if (typeof value !== "string" || seenOptions.has(name)) throw usageFailure();
    seenOptions.add(name);
    if (name === "--method") {
      options.method = value;
    } else if (name === "--schema-version") {
      options.schemaVersion = parseBoundedInteger(value, 1, 999);
    } else if (name === "--params-json") {
      options.params = parseParams(value);
    } else if (name === "--instance") {
      options.instance = parseInstanceRef(value);
    } else if (name === "--api-key-env") {
      if (!ENV_NAME_PATTERN.test(value)) throw usageFailure();
      options.apiKeyEnv = value;
    } else if (name === "--read-timeout-ms") {
      options.readTimeoutMs = parseBoundedInteger(value, 100, MAXIMUM_READ_TIMEOUT_MS);
    } else if (name === "--output") {
      options.output = value;
    } else if (name === "--tab-ref") {
      options.tabRef = value;
    } else if (name === "--artifact-ref") {
      options.artifactRef = value;
    } else if (name === "--node-ref") {
      options.nodeRef = value;
    } else if (name === "--width" || name === "--height") {
      options[name.slice(2)] = parseBoundedInteger(value, 1, Number.MAX_SAFE_INTEGER);
    } else if (name === "--region-json") {
      options.region = parseParams(value);
      if (Object.keys(options.region).sort().join(",") !== "height,width,x,y" ||
          !["x", "y", "width", "height"].every((key) => typeof options.region[key] === "number" && Number.isFinite(options.region[key]) && options.region[key] >= 0) ||
          options.region.width <= 0 || options.region.height <= 0) throw usageFailure();
    } else if (name === "--format") {
      if (value !== "png" && value !== "jpeg") throw usageFailure();
      options.format = value;
    } else if (name === "--quality") {
      options.quality = parseBoundedInteger(value, 0, 100);
    } else if (name === "--active") {
      if (value !== "true" && value !== "false") throw usageFailure();
      options.active = value === "true";
    } else if (name === "--window-id") {
      options.windowId = parseBoundedInteger(value, 1, Number.MAX_SAFE_INTEGER);
    } else {
      throw usageFailure();
    }
    index += 2;
  }

  if (command === "call") {
    if (typeof options.method !== "string" || options.method.length > 128 || !METHOD_PATTERN.test(options.method)) {
      throw usageFailure();
    }
    const allowed = new Set(["--method", "--schema-version", "--params-json", "--instance", "--api-key-env", "--read-timeout-ms"]);
    if ([...seenOptions].some((name) => !allowed.has(name))) throw usageFailure();
  } else if (command === "page-save" || command === "artifact-save" || command === "page-shot") {
    const allowed = new Set(["--output", "--instance", "--api-key-env", "--read-timeout-ms",
      command === "artifact-save" ? "--artifact-ref" : "--tab-ref",
      ...(command === "page-shot" ? ["--format", "--quality"] : [])]);
    if ([...seenOptions].some((name) => !allowed.has(name)) || !options.output?.trim() ||
        (command === "artifact-save" ? !/^ar1\.[A-Za-z0-9_-]{43}$/u.test(options.artifactRef ?? "") :
          !/^tr1\.[A-Za-z0-9_-]{22}\.[1-9][0-9]{0,15}\.[A-Za-z0-9_-]{22}$/u.test(options.tabRef ?? ""))) throw usageFailure();
  } else if (command === "element-shot") {
    const allowed = new Set(["--node-ref", "--output", "--width", "--height", "--region-json", "--instance", "--api-key-env", "--read-timeout-ms"]);
    if ([...seenOptions].some((name) => !allowed.has(name)) || !options.output?.trim() || !/^nr1\.[A-Za-z0-9_-]{43}$/u.test(options.nodeRef ?? "")) throw usageFailure();
  } else if (command === "demo-open") {
    const allowed = new Set(["--tab-ref", "--active", "--window-id", "--instance", "--api-key-env", "--read-timeout-ms"]);
    if ([...seenOptions].some((name) => !allowed.has(name)) ||
        options.tabRef !== null && !/^tr1\.[A-Za-z0-9_-]{22}\.[1-9][0-9]{0,15}\.[A-Za-z0-9_-]{22}$/u.test(options.tabRef) ||
        options.tabRef !== null && options.windowId !== undefined) throw usageFailure();
  } else if ([...seenOptions].some((name) => name !== "--read-timeout-ms")) {
    throw usageFailure();
  }
  return options;
}

function parseParams(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw usageFailure();
  }
  if (!isRecord(parsed)) throw usageFailure();
  return parsed;
}

function parseInstanceRef(value) {
  const slash = value.indexOf("/");
  if (slash !== 22 || value.indexOf("/", slash + 1) !== -1) throw usageFailure();
  const relayEpoch = value.slice(0, slash);
  const instanceNumber = value.slice(slash + 1);
  if (!RELAY_EPOCH_PATTERN.test(relayEpoch) || !isCanonicalInstanceNumber(instanceNumber)) {
    throw usageFailure();
  }
  return { relayEpoch, instanceNumber };
}

function selectInstance(instances, requested) {
  if (requested !== null) {
    const current = instances.find(
      (instance) =>
        instance.relayEpoch === requested.relayEpoch &&
        instance.instanceNumber === requested.instanceNumber,
    );
    if (current === undefined) throw failure("STALE_INSTANCE", EXIT.transport, "known_not_delivered");
    return current;
  }
  if (instances.length === 0) {
    throw failure("EXTENSION_UNAVAILABLE", EXIT.transport, "known_not_delivered");
  }
  if (instances.length !== 1) {
    throw failure("TARGET_INSTANCE_REQUIRED", EXIT.transport, "known_not_delivered", {
      instanceCount: instances.length,
    });
  }
  return instances[0];
}

function validateRelayHello(value) {
  if (
    !hasExactKeys(value, ["kind", "product", "buildId", "transportProfile", "protocolVersion", "relayEpoch"]) ||
    value.kind !== "relay.hello" ||
    value.product !== TRANSPORT.product ||
    value.transportProfile !== TRANSPORT.profile ||
    value.protocolVersion !== TRANSPORT.protocolVersion ||
    typeof value.buildId !== "string" || !/^relay-[a-f0-9]{24}$/u.test(value.buildId) ||
    typeof value.relayEpoch !== "string" ||
    !RELAY_EPOCH_PATTERN.test(value.relayEpoch)
  ) {
    throw failure("RELAY_INCOMPATIBLE", EXIT.relay, "known_not_delivered");
  }
}

function isCanonicalInstanceNumber(value) {
  if (typeof value !== "string" || !INSTANCE_NUMBER_PATTERN.test(value)) return false;
  try {
    return BigInt(value) <= U64_MAXIMUM;
  } catch {
    return false;
  }
}

function parseBoundedInteger(value, minimum, maximum) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw usageFailure();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw usageFailure();
  return number;
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTraceMetadata(value) {
  if (!hasExactKeys(value, ["state", "traceRef"])) return false;
  if (value.state === "complete" || value.state === "partial") {
    return typeof value.traceRef === "string" && TRACE_REF_PATTERN.test(value.traceRef);
  }
  return (value.state === "unavailable" || value.state === "not_admitted") && value.traceRef === null;
}

function helpOutput() {
  return {
    ok: true,
    command: "help",
    usage: [
      "browser-key-cli.mjs instances [--read-timeout-ms <ms>]",
      "browser-key-cli.mjs call --method <method> [--schema-version <n>] [--params-json <object>] [--instance <relayEpoch/instanceNumber>] [--api-key-env <name>] [--read-timeout-ms <ms>]",
      "browser-key-cli.mjs page-save --tab-ref <TabRef> --output <page.mhtml> [--instance <relayEpoch/instanceNumber>] [--api-key-env <name>] [--read-timeout-ms <ms>]",
      "browser-key-cli.mjs artifact-save --artifact-ref <ArtifactRef> --output <file> [--instance <relayEpoch/instanceNumber>] [--api-key-env <name>] [--read-timeout-ms <ms>]",
      "browser-key-cli.mjs page-shot --tab-ref <TabRef> --output <image> [--format png|jpeg] [--quality 0..100] [--instance <relayEpoch/instanceNumber>] [--api-key-env <name>] [--read-timeout-ms <ms>]",
      "browser-key-cli.mjs element-shot --node-ref <NodeRef> --output <image.png> [--width <px>] [--height <px>] [--region-json <element-local-rectangle>] [--instance <relayEpoch/instanceNumber>] [--api-key-env <name>] [--read-timeout-ms <ms>]",
      "browser-key-cli.mjs demo-open <UTF-8-self-contained.html> [--tab-ref <existing demo TabRef> | --window-id <id>] [--active true|false] [--instance <relayEpoch/instanceNumber>] [--api-key-env <name>] [--read-timeout-ms <ms>]",
      "browser-key-cli.mjs stop [--read-timeout-ms <ms>]",
    ],
    defaults: {
      apiKeyEnvironmentVariable: DEFAULT_API_KEY_ENV,
      readTimeoutMs: DEFAULT_READ_TIMEOUT_MS,
    },
  };
}

function systemDetails(error) {
  const code = error?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/u.test(code) ? { systemCode: code } : undefined;
}

function usageFailure() {
  return failure("CLI_USAGE", EXIT.usage, "known_not_delivered");
}

function failure(code, exitCode, delivery, details) {
  return new CliFailure(code, exitCode, delivery, details);
}

function normalizeFailure(error) {
  if (error instanceof CliFailure) return error;
  if (error instanceof DemoFileError) return failure(error.code, EXIT.business, "demo_not_opened", error.details);
  if (error instanceof ArtifactFileError) return failure(error.code, EXIT.business, "local_file_not_saved", error.details);
  return failure("CLIENT_INTERNAL_ERROR", EXIT.internal, "known_not_delivered", systemDetails(error));
}

function writeOutput(value) {
  if (value === null) return;
  const encoded = JSON.stringify(value).replace(
    /bk1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/gu,
    "[REDACTED_API_KEY]",
  );
  process.stdout.write(`${encoded}\n`);
}
