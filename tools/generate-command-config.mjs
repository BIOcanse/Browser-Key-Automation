import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(workspaceRoot, relativePath), "utf8"));
}

const commandRegistry = await readJson("registries/commands.registry.json");
const capabilityRegistry = await readJson("registries/capabilities.registry.json");
const errorRegistry = await readJson("registries/errors.registry.json");
const freedomRegistry = await readJson("registries/freedom.registry.json");
const manifest = await readJson("apps/extension/manifest.json");
const transportProfile = await readJson("protocol/transport-profile.json");

function activeIdentifiers(declarations, idField) {
  const values = declarations
    .filter((declaration) => declaration.status === "active")
    .map((declaration) => declaration[idField]);
  const canonical = [...values].sort();
  if (JSON.stringify(values) !== JSON.stringify(canonical) || new Set(values).size !== values.length) {
    throw new Error(`Active ${idField} values must be sorted and unique`);
  }
  return values;
}

function requireActiveInteger(pointId) {
  const point = freedomRegistry.points.find((candidate) => candidate.pointId === pointId);
  if (
    point?.status !== "active" ||
    point.kind !== "integer" ||
    !Number.isSafeInteger(point.minimumInteger) || !Number.isSafeInteger(point.maximumInteger) ||
    point.minimumInteger > point.maximumInteger ||
    !Number.isSafeInteger(point.defaultInteger) ||
    point.defaultInteger < point.minimumInteger ||
    point.defaultInteger > point.maximumInteger
  ) {
    throw new Error(`Freedom point is not an active bounded integer: ${pointId}`);
  }
  return point.defaultInteger;
}

function defaultPointValue(pointId) {
  const point = freedomRegistry.points.find((candidate) => candidate.pointId === pointId);
  if (point?.status !== "active") throw new Error(`Inactive default Freedom Point: ${pointId}`);
  if (point.kind === "integer") return requireActiveInteger(pointId);
  if (point.kind === "string" && typeof point.defaultString === "string" &&
      Array.isArray(point.allowedStrings) && new Set(point.allowedStrings).size === point.allowedStrings.length &&
      point.allowedStrings.every((value) => typeof value === "string") && point.allowedStrings.includes(point.defaultString)) {
    return point.defaultString;
  }
  if (point.kind === "boolean" && typeof point.defaultBoolean === "boolean") return point.defaultBoolean;
  throw new Error(`Unsupported or invalid typed default Freedom Point: ${pointId}`);
}

function validateParameterDefault(field, value) {
  const integer = Number.isSafeInteger(value);
  const enumValues = {
    image_format: ["jpeg", "png"],
    scroll_behavior: ["auto", "smooth"],
    scroll_alignment: ["center", "end", "nearest", "start"],
    // A default that requires another optional condition parameter is invalid.
    page_wait_until: ["committed", "domcontentloaded", "complete"],
  };
  const valid = field.valueType === "boolean" ? typeof value === "boolean" :
    field.valueType === "positive_integer" ? integer && value > 0 :
    field.valueType === "safe_integer" ? integer && value >= 0 :
    field.valueType === "safe_integer_or_null" ? value === null || integer && value >= 0 :
    field.valueType === "tab_ref_or_null" ? value === null :
    field.valueType === "integer_0_100" ? integer && value >= 0 && value <= 100 :
    enumValues[field.valueType]?.includes(value) === true;
  if (!valid) throw new Error(`Invalid parameter default type/value: ${field.fieldName} (${field.valueType})`);
}

function catalogName(method) {
  const parts = method.split(".");
  let name = parts[0];
  let index = 1;
  while (index < parts.length) {
    const part = parts[index];
    name += part.slice(0, 1).toUpperCase() + part.slice(1);
    index += 1;
  }
  return name;
}

const activePermissions = activeIdentifiers(commandRegistry.permissionDeclarations, "permissionId");
const activeSchemas = commandRegistry.schemaDeclarations.filter((declaration) => declaration.status === "active");
const activeSchemaIds = activeIdentifiers(activeSchemas, "schemaId");
const resolvedCommandDeclarations = commandRegistry.commandDeclarations.map((declaration) => ({
  ...commandRegistry.commandDefaults,
  ...declaration,
  allowedErrorIds: [
    ...commandRegistry.commonAllowedErrorIds,
    ...(declaration.additionalAllowedErrorIds ?? []),
  ].sort(),
}));
const activeCommands = resolvedCommandDeclarations.filter((declaration) => declaration.status === "active");
const activeCommandIds = activeIdentifiers(activeCommands, "stableCommandId");
const activeCapabilities = activeIdentifiers(capabilityRegistry.capabilities, "capabilityId");
const activeErrorIds = new Set(activeIdentifiers(errorRegistry.errors, "errorId"));
const activePointIds = new Set(activeIdentifiers(freedomRegistry.points, "pointId"));

const schemaById = new Map(activeSchemas.map((schema) => [schema.schemaId, schema]));
for (const schema of activeSchemas) {
  if (schema.kind !== "closed_object" || !Array.isArray(schema.fields)) {
    throw new Error(`Active schema is not a closed object: ${schema.schemaId}`);
  }
  const fieldNames = schema.fields.map((field) => field.fieldName);
  if (
    new Set(fieldNames).size !== fieldNames.length ||
    schema.fields.some((field) => field.required !== true && field.required !== false)
  ) {
    throw new Error(`Active schema has duplicate fields or an invalid required marker: ${schema.schemaId}`);
  }
}

const methodVersions = new Set();
const usedPermissions = new Set();
const catalog = {};
const schemaVersionByMethod = {};
const parameterDefaultsByMethod = {};
for (const command of activeCommands) {
  const methodVersion = `${command.method}\n${command.schemaVersion}`;
  if (methodVersions.has(methodVersion)) throw new Error(`Duplicate active method/schemaVersion: ${command.method}`);
  methodVersions.add(methodVersion);
  if (
    command.boundary !== "extension" ||
    command.authPolicy !== "key_required" ||
    command.externalExposure !== "agent_relay" ||
    !schemaById.has(command.paramsSchema) ||
    !schemaById.has(command.resultSchema) ||
    command.permissionExpression?.allOf?.length !== 1 ||
    !activePermissions.includes(command.permissionExpression.allOf[0])
  ) {
    throw new Error(`${command.stableCommandId} has an invalid active command boundary`);
  }
  const permission = command.permissionExpression.allOf[0];
  usedPermissions.add(permission);
  for (const capabilityId of command.capabilityRequirements) {
    if (!activeCapabilities.includes(capabilityId)) {
      throw new Error(`${command.stableCommandId} references a non-active capability: ${capabilityId}`);
    }
  }
  for (const pointId of command.limitRefs) {
    if (!activePointIds.has(pointId)) {
      throw new Error(`${command.stableCommandId} references a non-active Freedom Point: ${pointId}`);
    }
  }
  for (const errorId of command.allowedErrorIds) {
    if (!activeErrorIds.has(errorId)) throw new Error(`${command.stableCommandId} references a non-active error: ${errorId}`);
  }
  for (const mapping of command.errorDetailSchemas) {
    if (!command.allowedErrorIds.includes(mapping.errorId) || !schemaById.has(mapping.schemaId)) {
      throw new Error(`${command.stableCommandId} has an invalid error detail mapping`);
    }
  }
  const name = catalogName(command.method);
  if (catalog[name] !== undefined) throw new Error(`Command catalog name collision: ${name}`);
  catalog[name] = {
    stableCommandId: command.stableCommandId,
    method: command.method,
    schemaVersion: command.schemaVersion,
    requiredPermission: permission,
    effectKind: command.effectKind,
    controlPolicy: command.controlPolicy,
  };
  schemaVersionByMethod[command.method] = command.schemaVersion;
  const defaults = {};
  for (const field of schemaById.get(command.paramsSchema).fields) {
    const fromPoint = Object.hasOwn(field, "defaultFromFreedomPoint");
    const literal = Object.hasOwn(field, "defaultValue");
    if (!fromPoint && !literal) continue;
    if (field.required || fromPoint && literal) throw new Error(`Invalid field default: ${command.method}.${field.fieldName}`);
    if (fromPoint && !command.limitRefs.includes(field.defaultFromFreedomPoint)) {
      throw new Error(`Default Freedom Point missing from limitRefs: ${command.method}.${field.fieldName}`);
    }
    const value = fromPoint ? defaultPointValue(field.defaultFromFreedomPoint) : field.defaultValue;
    validateParameterDefault(field, value);
    defaults[field.fieldName] = value;
  }
  parameterDefaultsByMethod[command.method] = defaults;
}

if (JSON.stringify([...usedPermissions].sort()) !== JSON.stringify(activePermissions)) {
  throw new Error("Every active permission must be consumed by an active command");
}
for (const errorId of commandRegistry.boundaryErrorIds) {
  if (!activeErrorIds.has(errorId)) throw new Error(`Boundary references a non-active error: ${errorId}`);
}
for (const mapping of commandRegistry.boundaryErrorDetailSchemas) {
  if (!commandRegistry.boundaryErrorIds.includes(mapping.errorId) || !activeSchemaIds.includes(mapping.schemaId)) {
    throw new Error("Boundary has an invalid error detail mapping");
  }
}

const projectedManifestPermissions = new Set();
const projectedManifestHostPermissions = new Set();
for (const capability of capabilityRegistry.capabilities.filter((candidate) => candidate.status === "active")) {
  if (!Array.isArray(capability.consumers) || capability.consumers.length === 0) {
    throw new Error(`Active capability has no source consumer: ${capability.capabilityId}`);
  }
  for (const consumer of capability.consumers) await access(path.join(workspaceRoot, consumer));
  for (const permission of capability.manifestPermissions) projectedManifestPermissions.add(permission);
  for (const hostPermission of capability.manifestHostPermissions) projectedManifestHostPermissions.add(hostPermission);
}
if (JSON.stringify([...(manifest.permissions ?? [])].sort()) !== JSON.stringify([...projectedManifestPermissions].sort())) {
  throw new Error("Manifest permissions do not exactly match active Capability Registry projections");
}
if (JSON.stringify([...(manifest.host_permissions ?? [])].sort()) !== JSON.stringify([...projectedManifestHostPermissions].sort())) {
  throw new Error("Manifest host permissions do not exactly match active Capability Registry projections");
}
const sandboxCapability = capabilityRegistry.capabilities.find((item) => item.capabilityId === "platform.extension.sandbox" && item.status === "active");
if (sandboxCapability !== undefined) {
  if (JSON.stringify(manifest.sandbox?.pages) !== JSON.stringify(sandboxCapability.sandboxPages) ||
      manifest.content_security_policy?.sandbox !== sandboxCapability.sandboxContentSecurityPolicy ||
      sandboxCapability.sandboxContentSecurityPolicy.includes("allow-same-origin")) {
    throw new Error("Manifest sandbox must match its unique-origin Capability Registry declaration");
  }
  for (const page of sandboxCapability.sandboxPages) await access(path.join(workspaceRoot, "apps", "extension", "static", page));
}

const limits = {};
const limitRanges = {};
for (const point of freedomRegistry.points.filter((candidate) => candidate.status === "active")) {
  if (!Array.isArray(point.consumers) || point.consumers.length === 0) {
    throw new Error(`Active Freedom Point has no source consumer: ${point.pointId}`);
  }
  for (const consumer of point.consumers) await access(path.join(workspaceRoot, consumer));
  if (point.family === "build" && (point.owner !== "build_profile" || point.updateClass !== "rebuild" || point.editableInSettings !== false)) {
    throw new Error(`Build Freedom Point has inconsistent ownership: ${point.pointId}`);
  }
  if (point.kind === "integer") {
    limits[point.pointId] = requireActiveInteger(point.pointId);
    limitRanges[point.pointId] = { minimum: point.minimumInteger, maximum: point.maximumInteger };
  } else if (point.kind === "string" || point.kind === "boolean") {
    defaultPointValue(point.pointId);
  } else if (point.kind !== "loopback_bind") {
    throw new Error(`Unsupported Freedom Point kind: ${point.pointId}`);
  }
}

if (limits["command.page.wait.default_timeout_ms"] > limits["command.page.wait.maximum_timeout_ms"] ||
    limits["command.page.wait.poll_interval_ms"] > limits["command.page.wait.maximum_timeout_ms"]) {
  throw new Error("page.wait defaults must fit its finite maximum deadline");
}
if (limits["command.dom.click.real.default_timeout_ms"] > limits["command.dom.click.real.maximum_timeout_ms"]) {
  throw new Error("dom.click.real default timeout exceeds its maximum");
}
if (limits["client.default_read_timeout_ms"] > limits["client.maximum_read_timeout_ms"]) {
  throw new Error("CLI default read timeout exceeds its maximum");
}

const frameBytes = transportProfile.maximumMessageBytes;
const textBytes = limits["command.tabs.maximum_text_bytes"];
const inlineResultBytes = limits["command.inline.maximum_result_json_bytes"];
if (inlineResultBytes + 12000 >= frameBytes) {
  throw new Error("The common inline result budget must leave room for the routed response envelope");
}
if ((26 * limits["command.dom.maximum_descriptor_text_characters"] * 6) + 4096 > inlineResultBytes) {
  throw new Error("One worst-case escaped DOM descriptor must fit the common inline result budget");
}
if ((limits["command.page.tree.maximum_preview_characters"] * 6) + 8192 > inlineResultBytes) {
  throw new Error("One worst-case escaped page-tree item must fit the common inline result budget");
}
if (
  limits["command.page.tree.maximum_index_depth"] > limits["command.page.tree.maximum_view_scan_nodes"] ||
  limits["command.page.tree.maximum_label_scan_nodes"] > limits["command.page.tree.maximum_view_scan_nodes"]
) {
  throw new Error("Page-tree index depth and per-label work must fit inside the view scan bound");
}
if (
  limits["command.page.tree.maximum_refs_per_document"] <
    limits["command.page.tree.maximum_view_items"] + 1
) {
  throw new Error("Page-tree reference capacity must admit one root and one complete maximum-size view");
}
if (limits["command.page.dom.maximum_html_json_bytes"] + textBytes + 4096 >= frameBytes) {
  throw new Error("The DOM preview and response envelope must fit one transport message");
}
if (limits["command.page.text.maximum_json_bytes"] + textBytes + 4096 >= frameBytes) {
  throw new Error("The text preview and response envelope must fit one transport message");
}
if (limits["command.js.maximum_value_json_bytes"] + (2 * textBytes) + 4096 >= frameBytes) {
  throw new Error("The JavaScript value preview and response envelope must fit one transport message");
}
if (Math.ceil(limits["command.artifact.read.maximum_raw_bytes"] * 4 / 3) + 12000 >= frameBytes) {
  throw new Error("The Artifact base64url chunk and response envelope must fit one transport message");
}
if (Math.ceil(limits["command.artifact.upload.maximum_raw_bytes"] * 4 / 3) + 12000 >= frameBytes) {
  throw new Error("The upload base64url chunk and authenticated request envelope must fit one transport message");
}
if (limits["build.artifact.chunk_bytes"] < limits["command.artifact.read.maximum_raw_bytes"]) {
  throw new Error("One Artifact read may intersect at most two storage chunks");
}
if (Math.ceil(limits["build.artifact.hard_maximum_bytes"] / limits["build.artifact.chunk_bytes"]) > 1024) {
  throw new Error("One Artifact must have at most 1024 committed storage chunks");
}
if (
  limits["runtime.artifact.default_maximum_bytes"] > limits["build.artifact.hard_maximum_bytes"] ||
  limits["runtime.artifact.default_maximum_total_bytes"] > limits["build.artifact.hard_maximum_total_bytes"] ||
  limits["runtime.artifact.default_maximum_bytes"] > limits["runtime.artifact.default_maximum_total_bytes"]
) {
  throw new Error("Artifact runtime defaults exceed their build hard limits");
}

const generated = `// Generated by tools/generate-command-config.mjs. Do not edit.
export const COMMAND_CATALOG = ${JSON.stringify(
  {
    ...catalog,
    schemaVersionByMethod,
    parameterDefaultsByMethod,
    activeCommandIds,
    activePermissionIds: activePermissions,
    activeCapabilityIds: activeCapabilities,
    limits,
    limitRanges,
  },
  null,
  2,
)} as const;
`;

await writeFile(path.join(workspaceRoot, "apps", "extension", "src", "generated", "command-config.ts"), generated, "utf8");
await copyFile(
  path.join(workspaceRoot, "registries", "commands.registry.json"),
  path.join(workspaceRoot, "skills", "browser-key-automation", "references", "commands.registry.json"),
);
await copyFile(
  path.join(workspaceRoot, "registries", "freedom.registry.json"),
  path.join(workspaceRoot, "skills", "browser-key-automation", "references", "freedom.registry.json"),
);
