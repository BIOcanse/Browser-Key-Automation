import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sourceBuildId } from "./build-identity.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const freedomRegistry = JSON.parse(
  await readFile(path.join(workspaceRoot, "registries", "freedom.registry.json"), "utf8"),
);
const profile = JSON.parse(
  await readFile(path.join(workspaceRoot, "protocol", "transport-profile.json"), "utf8"),
);
const manifest = JSON.parse(
  await readFile(path.join(workspaceRoot, "apps", "extension", "manifest.json"), "utf8"),
);
const capabilityRegistry = JSON.parse(
  await readFile(path.join(workspaceRoot, "registries", "capabilities.registry.json"), "utf8"),
);

function requirePoint(pointId, expected) {
  const point = freedomRegistry.points.find((candidate) => candidate.pointId === pointId);
  if (!point) {
    throw new Error(`Missing freedom point: ${pointId}`);
  }
  for (const [field, value] of Object.entries(expected)) {
    if (JSON.stringify(point[field]) !== JSON.stringify(value)) {
      throw new Error(`Freedom point ${pointId} has an unexpected ${field}`);
    }
  }
  return point;
}

const bind = requirePoint("build.transport.loopback_bind", {
  family: "build",
  kind: "loopback_bind",
  owner: "build_profile",
  updateClass: "rebuild",
  editableInSettings: false,
  status: "active",
  emitTargets: ["manifest", "typescript", "zig", "javascript"],
}).defaultLoopbackBind;
const retryIntervalMs = requirePoint("transport.retry_interval_ms", {
  family: "build",
  kind: "integer",
  owner: "build_profile",
  updateClass: "rebuild",
  editableInSettings: false,
  status: "active",
  emitTargets: ["typescript"],
}).defaultInteger;
const nativeInputResponseMarginMs = requirePoint("transport.native_input.response_margin_ms", {
  family: "build", kind: "integer", owner: "build_profile", updateClass: "rebuild",
  editableInSettings: false, status: "active", emitTargets: ["typescript"],
}).defaultInteger;
const nativeInputWindowMatchPollMs = requirePoint("transport.native_input.window_match_poll_ms", {
  family: "build", kind: "integer", owner: "build_profile", updateClass: "rebuild",
  editableInSettings: false, status: "active", emitTargets: ["zig"],
}).defaultInteger;
const nativeKeyboardMaximumChordKeys = requirePoint("command.keyboard.maximum_chord_keys", {
  family: "build", kind: "integer", owner: "build_profile", updateClass: "rebuild",
  editableInSettings: false, status: "active", emitTargets: ["typescript", "zig"],
}).defaultInteger;
const nativeKeyboardMaximumSequenceActions = requirePoint("command.keyboard.maximum_sequence_actions", {
  family: "build", kind: "integer", owner: "build_profile", updateClass: "rebuild",
  editableInSettings: false, status: "active", emitTargets: ["typescript", "zig"],
}).defaultInteger;
const nativeKeyboardMaximumTextBytes = requirePoint("command.keyboard.maximum_text_bytes", {
  family: "build", kind: "integer", owner: "build_profile", updateClass: "rebuild",
  editableInSettings: false, status: "active", emitTargets: ["typescript", "zig"],
}).defaultInteger;
const nativeKeyboardMaximumWaitMs = requirePoint("command.keyboard.maximum_wait_ms", {
  family: "build", kind: "integer", owner: "build_profile", updateClass: "rebuild",
  editableInSettings: false, status: "active", emitTargets: ["typescript", "zig"],
}).defaultInteger;

const handshakePoint = requirePoint("transport.handshake_timeout_ms", {
  family: "build", kind: "integer", owner: "build_profile", updateClass: "rebuild",
  editableInSettings: false, status: "active", emitTargets: ["typescript", "javascript"],
});
const handshakeTimeoutMs = handshakePoint.defaultInteger;
if (!Number.isSafeInteger(handshakeTimeoutMs) ||
    handshakeTimeoutMs < handshakePoint.minimumInteger || handshakeTimeoutMs > handshakePoint.maximumInteger) {
  throw new Error("transport.handshake_timeout_ms must be inside its declared range");
}

if (!bind || bind.host !== "127.0.0.1" || !Number.isInteger(bind.port)) {
  throw new Error("The current transport slice requires one exact 127.0.0.1 bind");
}
if (profile.nativeInputClickCapability !== "native.input.click.v1") {
  throw new Error("The native input capability token must match the v1 subprotocol contract");
}
if (profile.nativeInputKeyboardCapability !== "native.input.keyboard.v1") {
  throw new Error("The native keyboard capability token must match the v1 subprotocol contract");
}
if (!Number.isInteger(retryIntervalMs) || retryIntervalMs < 1000) {
  throw new Error("transport.retry_interval_ms must be an integer >= 1000");
}
const literalConnectSources = [...new Set(
  capabilityRegistry.capabilities
    .filter((capability) => capability.status === "active")
    .flatMap((capability) => capability.connectSourceLiterals ?? []),
)].sort();
const expectedExtensionCsp = `script-src 'self'; object-src 'self'; connect-src 'self' ${literalConnectSources.join(" ")} ws://${bind.host}:${bind.port}`;
if (manifest.content_security_policy?.extension_pages !== expectedExtensionCsp) {
  throw new Error("Extension CSP loopback projection does not match build.transport.loopback_bind");
}
if (typeof manifest.key !== "string" || manifest.key.length === 0) {
  throw new Error("Manifest must contain one fixed public key for deterministic extension identity");
}
const extensionPublicKey = Buffer.from(manifest.key, "base64");
if (extensionPublicKey.length === 0 || extensionPublicKey.toString("base64") !== manifest.key) {
  throw new Error("Manifest public key must use canonical base64");
}
const extensionIdHex = createHash("sha256").update(extensionPublicKey).digest("hex").slice(0, 32);
const extensionId = Array.from(
  extensionIdHex,
  (nibble) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(nibble, 16)),
).join("");
const extensionOrigin = `chrome-extension://${extensionId}`;
const relayBuildId = await sourceBuildId(workspaceRoot, "relay");
const extensionBuildId = await sourceBuildId(workspaceRoot, "extension");
function clientInteger(pointId) {
  const point = freedomRegistry.points.find((candidate) => candidate.pointId === pointId);
  if (point?.kind !== "integer" || point.status !== "active" || point.owner !== "build_profile" ||
      point.updateClass !== "rebuild" || point.editableInSettings !== false ||
      !Number.isSafeInteger(point.defaultInteger) || !Number.isSafeInteger(point.minimumInteger) ||
      !Number.isSafeInteger(point.maximumInteger) || point.minimumInteger > point.maximumInteger ||
      point.defaultInteger < point.minimumInteger || point.defaultInteger > point.maximumInteger) {
    throw new Error(`Invalid client integer Freedom Point: ${pointId}`);
  }
  return point.defaultInteger;
}
const client = {
  host: bind.host, port: bind.port, path: profile.clientPath, subprotocol: profile.clientSubprotocol,
  product: profile.product, profile: profile.profileId, protocolVersion: profile.protocolVersion,
  maximumMessageBytes: profile.maximumMessageBytes, maximumHttpHeadBytes: profile.maximumHttpHeadBytes,
  maximumOnlineExtensions: profile.maximumOnlineExtensions, handshakeTimeoutMs,
  defaultReadTimeoutMs: clientInteger("client.default_read_timeout_ms"),
  maximumReadTimeoutMs: clientInteger("client.maximum_read_timeout_ms"),
};

const zigString = (value) => JSON.stringify(value);
const zig = `// Generated by tools/generate-transport-config.mjs. Do not edit.
pub const product = ${zigString(profile.product)};
pub const build_id = ${zigString(relayBuildId)};
pub const profile_id = ${zigString(profile.profileId)};
pub const protocol_version: u16 = ${profile.protocolVersion};
pub const loopback_host = ${zigString(bind.host)};
pub const loopback_port: u16 = ${bind.port};
pub const extension_path = ${zigString(profile.extensionPath)};
pub const client_path = ${zigString(profile.clientPath)};
pub const extension_subprotocol = ${zigString(profile.extensionSubprotocol)};
pub const client_subprotocol = ${zigString(profile.clientSubprotocol)};
pub const native_input_click_capability = ${zigString(profile.nativeInputClickCapability)};
pub const native_input_keyboard_capability = ${zigString(profile.nativeInputKeyboardCapability)};
pub const expected_extension_origin = ${zigString(extensionOrigin)};
pub const retry_interval_ms: u32 = ${retryIntervalMs};
pub const native_input_window_match_poll_ms: u32 = ${nativeInputWindowMatchPollMs};
pub const native_keyboard_maximum_chord_keys: usize = ${nativeKeyboardMaximumChordKeys};
pub const native_keyboard_maximum_wire_actions: usize = ${nativeKeyboardMaximumSequenceActions * 2};
pub const native_keyboard_maximum_text_bytes: usize = ${nativeKeyboardMaximumTextBytes};
pub const native_keyboard_maximum_wait_ms: u32 = ${nativeKeyboardMaximumWaitMs};
pub const maximum_http_head_bytes: usize = ${profile.maximumHttpHeadBytes};
pub const maximum_message_bytes: usize = ${profile.maximumMessageBytes};
pub const maximum_online_extensions: usize = ${profile.maximumOnlineExtensions};
pub const maximum_pending_routes: usize = ${profile.maximumPendingRoutes};
`;

const ts = `// Generated by tools/generate-transport-config.mjs. Do not edit.
export const TRANSPORT_CONFIG = ${JSON.stringify(
  {
    product: profile.product,
    buildId: extensionBuildId,
    profileId: profile.profileId,
    protocolVersion: profile.protocolVersion,
    webSocketUrl: `ws://${bind.host}:${bind.port}${profile.extensionPath}`,
    extensionSubprotocol: profile.extensionSubprotocol,
    expectedExtensionId: extensionId,
    expectedExtensionOrigin: extensionOrigin,
    nativeInputClickCapability: profile.nativeInputClickCapability,
    nativeInputKeyboardCapability: profile.nativeInputKeyboardCapability,
    nativeInputResponseMarginMs,
    retryIntervalMs,
    handshakeTimeoutMs,
    maximumMessageBytes: profile.maximumMessageBytes,
  },
  null,
  2,
)} as const;
`;

await writeFile(
  path.join(workspaceRoot, "apps", "relay", "src", "generated_config.zig"),
  zig,
  "utf8",
);
await writeFile(path.join(workspaceRoot, "apps", "client", "src", "generated-config.mjs"),
  `// Generated by tools/generate-transport-config.mjs. Do not edit.\nexport const TRANSPORT = Object.freeze(${JSON.stringify(client, null, 2)});\n`, "utf8");
await writeFile(
  path.join(workspaceRoot, "apps", "extension", "src", "generated", "transport-config.ts"),
  ts,
  "utf8",
);
