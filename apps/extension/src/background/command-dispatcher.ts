import { COMMAND_CATALOG } from "../generated/command-config.js";
import { TRANSPORT_CONFIG } from "../generated/transport-config.js";
import {
  CURRENT_PERMISSION_IDS,
  type CreateKeyParams,
  type ListKeysParams,
  type PermissionId,
  type PublicKeyRecord,
  type RevealKeyParams,
  type RevokeKeyParams,
  type UpdateKeyParams,
} from "../shared/admin-protocol.js";
import {
  ArtifactServiceError,
  appendArtifactUpload,
  beginArtifactUpload,
  commitArtifactUpload,
  isArtifactRefShape,
  readArtifact,
  releaseArtifact,
} from "./artifact-service.js";
import {
  ensureUserScriptsAvailable,
  executeJavaScript,
  getPageDom,
  getPageResources,
  getPageText,
  type JavaScriptWorld,
  type PageDomRoot,
} from "./browser-service.js";
import { CapabilityUnavailableError } from "./capability-error.js";
import {
  capturePageArchive,
  capturePageDomArtifact,
  captureVisibleScreenshot,
  fetchResource,
} from "./capture-service.js";
import { DemoServiceError, openDemo, type OpenDemoParams } from "./demo-service.js";
import { captureElementScreenshot, type ElementScreenshotRequest } from "./capture/element-service.js";
import { ElementScreenshotError } from "./capture/geometry-model.js";
import { attachDebugger, detachDebugger, sendDebuggerCommand, getDebuggerEvents,
  DebuggerServiceError, type DebuggerDispatch, type DebuggerSendRequest } from "./debugger-service.js";
import {
  clickDomNode,
  describeDomNode,
  DomServiceError,
  focusDomNode,
  insertDomNodeText,
  isDocumentRefShape,
  isNodeRefShape,
  listFrames,
  observeDomTarget,
  queryDom,
  scrollDomNode,
  scrollDomTargetSearch,
  selectDomNodeValues,
  setDomNodeValue,
  tabRefForNode,
  type DomTarget,
} from "./dom-service.js";
import {
  EnsureWorkflowError,
  parseDomTarget,
  parseEnsureParameters,
  runEnsure,
  type EnsureAction,
  type EnsureCondition,
  type EnsureRequest,
} from "./ensure-service.js";
import {
  appendExecutionTraceEvent,
  beginExecutionTrace,
  checkpointExecutionTrace,
  exportExecutionTrace,
  finishExecutionTrace,
  isTraceRefShape,
  readExecutionTrace,
  TraceServiceError,
  type ExecutionTraceDraft,
  type ExecutionTraceEventInput,
  type TraceResponseState,
  type TraceTerminal,
} from "./execution-trace-service.js";
import { NativeInputError } from "./native-input-error.js";
import { clickRealDomNode } from "./real-input-service.js";
import { hasOnlyUnicodeScalars, parseKeyboardActions, type NativeKeyboardAction } from "./keyboard-model.js";
import {
  pressKeyboard,
  resetKeyboard,
  tabRefForKeyboardTarget,
  typeKeyboardText,
  typeKeyboardTextHuman,
} from "./keyboard-service.js";
import {
  authenticateApiKey,
  createKeyForCaller,
  getPublicKey,
  KeyManagementAuthorizationError,
  KeyServiceError,
  listKeys,
  revealKey,
  revokeKey,
  updateKeyForCaller,
  type AuthenticationResult,
} from "./key-service.js";
import {
  acquireControl,
  assertControlGate,
  ControlOccupiedError,
  dispatchWithControlGate,
  dispatchWithGlobalControlGate,
  releaseControl,
  type ControlTarget,
} from "./occupation-service.js";
import {
  expandPageTree,
  findPageTree,
  getPageTreeView,
  isPageTreeRefShape,
  openPageTree,
  type PageTreeViewRequest,
  type PageTreeFindRequest,
  PageTreeServiceError,
} from "./page-tree-service.js";
import { observePageCondition, waitForPage, type PageWaitRequest } from "./page-wait-service.js";
import {
  getRuntimeSettings,
  SettingsServiceError,
  updateRuntimeSettings,
  type UpdateSettingsParams,
} from "./settings-service.js";
import {
  activateTab,
  assertResolvedTabTarget,
  closeTab,
  createTab,
  getTab,
  isTabRefShape,
  listTabs,
  navigateTab,
  reloadTab,
  resolveTabTarget,
  TabServiceError,
  type TabsListParams,
} from "./tab-service.js";

interface CatalogEntry {
  readonly method: string;
  readonly schemaVersion: number;
  readonly requiredPermission: PermissionId;
  readonly effectKind: string;
}

interface ParsedCommand {
  readonly kind: string;
  readonly schemaVersion: number;
  readonly requiredPermission: PermissionId;
  readonly effectKind: string;
  readonly params: Record<string, unknown>;
  readonly ensureRequest?: EnsureRequest;
}

interface ParsedRouteRequest {
  readonly routeId: string;
  readonly clientRequestId: string;
  readonly apiKey: string;
  readonly command: ParsedCommand;
}

type CommandErrorCode =
  | "ADMIN_MUTATION_CONFLICT"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_UPLOAD_INVALID"
  | "CAPABILITY_UNAVAILABLE"
  | "CONDITION_NOT_MET"
  | "CONTROL_OCCUPIED"
  | "DOM_OPERATION_FAILED"
  | "DEBUGGER_OPERATION_FAILED"
  | "ELEMENT_SCREENSHOT_FAILED"
  | "DEMO_INPUT_INVALID"
  | "FORBIDDEN"
  | "INTERNAL_ERROR"
  | "KEY_DISABLED"
  | "KEY_EXPIRED"
  | "KEY_NOT_FOUND"
  | "KEY_REVOKED"
  | "LIMIT_EXCEEDED"
  | "NATIVE_INPUT_FAILED"
  | "REVISION_CONFLICT"
  | "SCHEMA_INVALID"
  | "SECRET_NOT_RECOVERABLE"
  | "STORAGE_UNAVAILABLE"
  | "TAB_REF_STALE"
  | "TARGET_AMBIGUOUS"
  | "TARGET_REF_STALE"
  | "TRACE_NOT_FOUND"
  | "UNAUTHENTICATED";

interface PublicCommandError {
  readonly code: CommandErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;
}

const keyLaneTails = new Map<string, Promise<void>>();
const encoder = new TextEncoder();
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const MUTATION_ID_PATTERN = /^am1\.\d{13}\.[A-Za-z0-9_-]{22}$/u;

class DispatchAuthorizationError extends Error {
  readonly code: CommandErrorCode;

  constructor(code: CommandErrorCode) {
    super("Command authority changed before native input dispatch");
    this.name = "DispatchAuthorizationError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (keys.length !== sortedExpected.length) return false;
  let index = 0;
  while (index < keys.length) {
    if (keys[index] !== sortedExpected[index]) return false;
    index += 1;
  }
  return true;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) return false;
  }
  return true;
}

function safeInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function boundedString(value: unknown, maximumBytes: number, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0) && encoder.encode(value).byteLength <= maximumBytes;
}

function integerRange(pointId: keyof typeof COMMAND_CATALOG.limitRanges): { readonly minimum: number; readonly maximum: number } {
  return COMMAND_CATALOG.limitRanges[pointId];
}

function inRegisteredRange(value: unknown, pointId: keyof typeof COMMAND_CATALOG.limitRanges): value is number {
  const range = integerRange(pointId);
  return safeInteger(value, range.minimum, range.maximum);
}

function isKeyId(value: unknown): value is string {
  return typeof value === "string" && KEY_ID_PATTERN.test(value);
}

function isMutationId(value: unknown): value is string {
  return typeof value === "string" && MUTATION_ID_PATTERN.test(value);
}

function isExpiry(value: unknown): value is number | null {
  return value === null || safeInteger(value);
}

function isPermissionList(value: unknown): value is readonly PermissionId[] {
  if (!Array.isArray(value) || value.length > CURRENT_PERMISSION_IDS.length) return false;
  const seen = new Set<string>();
  let index = 0;
  while (index < value.length) {
    const item = value[index];
    if (typeof item !== "string" || !CURRENT_PERMISSION_IDS.includes(item as PermissionId) || seen.has(item)) return false;
    seen.add(item);
    index += 1;
  }
  return true;
}

function isDisplayName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 128;
}

function isKeyPatch(value: unknown): boolean {
  return isRecord(value) &&
    hasExactKeys(value, ["displayName", "permissions", "expiresAt", "enabled"]) &&
    isDisplayName(value.displayName) &&
    isPermissionList(value.permissions) &&
    isExpiry(value.expiresAt) &&
    typeof value.enabled === "boolean";
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !boundedString(value, COMMAND_CATALOG.limits["command.dom.maximum_value_bytes"])) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isPageTreeIndexPath(value: unknown): value is readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > COMMAND_CATALOG.limits["command.page.tree.maximum_index_depth"]) {
    return false;
  }
  let index = 0;
  while (index < value.length) {
    if (!safeInteger(value[index])) return false;
    index += 1;
  }
  return true;
}

function isPageTreeSiblingRange(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["from", "toExclusive"]) ||
    !isPageTreeIndexPath(value.from) || !isPageTreeIndexPath(value.toExclusive) ||
    value.from.length !== value.toExclusive.length) return false;
  let index = 0;
  while (index < value.from.length - 1) {
    if (value.from[index] !== value.toExclusive[index]) return false;
    index += 1;
  }
  return (value.from[value.from.length - 1] ?? -1) < (value.toExclusive[value.toExclusive.length - 1] ?? -1);
}

function stringArray(value: unknown, maximumItems: number, maximumTotalBytes: number): value is readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) return false;
  let totalBytes = 0;
  let index = 0;
  while (index < value.length) {
    const item = value[index];
    if (typeof item !== "string") return false;
    totalBytes += encoder.encode(item).byteLength;
    if (totalBytes > maximumTotalBytes) return false;
    index += 1;
  }
  return true;
}

function parsed(entry: CatalogEntry, params: Record<string, unknown>): ParsedCommand {
  return {
    kind: entry.method,
    schemaVersion: entry.schemaVersion,
    requiredPermission: entry.requiredPermission,
    effectKind: entry.effectKind,
    params,
  };
}

function captureRegion(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["x", "y", "width", "height"]) &&
    ["x", "y", "width", "height"].every((key) => typeof value[key] === "number" && Number.isFinite(value[key]) &&
      (value[key] as number) >= 0 && (value[key] as number) <= Number.MAX_SAFE_INTEGER) &&
    (value.width as number) > 0 && (value.height as number) > 0;
}

function boundedJsonObject(value: unknown, maximumBytes: number): boolean {
  if (!isRecord(value)) return false;
  try { return encoder.encode(JSON.stringify(value)).byteLength <= maximumBytes; }
  catch { return false; }
}

function commandEntry(value: unknown): CatalogEntry {
  return value as CatalogEntry;
}

function parsePrimitiveCommand(value: unknown): ParsedCommand | null {
  if (!isRecord(value) || !hasExactKeys(value, ["method", "schemaVersion", "params"]) || !isRecord(value.params)) return null;
  if (typeof value.method !== "string" || !safeInteger(value.schemaVersion, 1)) return null;
  const expectedSchemaVersion = COMMAND_CATALOG.schemaVersionByMethod[
    value.method as keyof typeof COMMAND_CATALOG.schemaVersionByMethod
  ];
  if (expectedSchemaVersion === undefined || value.schemaVersion !== expectedSchemaVersion) return null;
  // Omission defaults are declared once and generated from the registry. Values
  // explicitly supplied by a caller (including invalid nulls) are not replaced.
  const params: Record<string, unknown> = {
    ...COMMAND_CATALOG.parameterDefaultsByMethod[value.method as keyof typeof COMMAND_CATALOG.parameterDefaultsByMethod],
    ...value.params,
  };

  switch (value.method) {
    case COMMAND_CATALOG.debuggerAttach.method:
    case COMMAND_CATALOG.debuggerDetach.method:
      return hasExactKeys(params, ["tabRef"]) && isTabRefShape(params.tabRef)
        ? parsed(commandEntry(value.method === COMMAND_CATALOG.debuggerAttach.method ? COMMAND_CATALOG.debuggerAttach : COMMAND_CATALOG.debuggerDetach), params) : null;
    case COMMAND_CATALOG.debuggerSend.method:
      return hasOnlyKeys(params, ["tabRef", "method", "params", "sessionId", "response"]) && isTabRefShape(params.tabRef) &&
        boundedString(params.method, COMMAND_CATALOG.limits["command.tabs.maximum_text_bytes"]) && /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/u.test(params.method as string) &&
        boundedJsonObject(params.params, COMMAND_CATALOG.limits["command.debugger.maximum_params_bytes"]) &&
        (params.sessionId === undefined || boundedString(params.sessionId, COMMAND_CATALOG.limits["command.tabs.maximum_text_bytes"])) &&
        (params.response === "inline" || params.response === "artifact")
        ? parsed(commandEntry(COMMAND_CATALOG.debuggerSend), params) : null;
    case COMMAND_CATALOG.debuggerEventsGet.method:
      return hasExactKeys(params, ["tabRef", "afterSequence", "limit"]) && isTabRefShape(params.tabRef) && safeInteger(params.afterSequence) &&
        safeInteger(params.limit, 1, COMMAND_CATALOG.limits["command.debugger.maximum_events"])
        ? parsed(commandEntry(COMMAND_CATALOG.debuggerEventsGet), params) : null;
    case COMMAND_CATALOG.pageScreenshotElement.method:
      return hasOnlyKeys(params, ["nodeRef", "width", "height", "region"]) && isNodeRefShape(params.nodeRef) &&
        safeInteger(params.width, 1, COMMAND_CATALOG.limits["command.page.screenshot.maximum_dimension"]) &&
        safeInteger(params.height, 1, COMMAND_CATALOG.limits["command.page.screenshot.maximum_dimension"]) &&
        params.width * params.height <= COMMAND_CATALOG.limits["command.page.screenshot.maximum_pixels"] &&
        (params.region === undefined || captureRegion(params.region))
        ? parsed(commandEntry(COMMAND_CATALOG.pageScreenshotElement), params) : null;
    case COMMAND_CATALOG.artifactUploadBegin.method:
      return hasExactKeys(params, ["byteLength", "mediaType"]) && safeInteger(params.byteLength) && params.mediaType === "text/html"
        ? parsed(commandEntry(COMMAND_CATALOG.artifactUploadBegin), params) : null;
    case COMMAND_CATALOG.artifactUploadAppend.method:
      return hasExactKeys(params, ["artifactRef", "offset", "dataBase64Url"]) && isArtifactRefShape(params.artifactRef) && safeInteger(params.offset) &&
        boundedString(params.dataBase64Url, Math.ceil(COMMAND_CATALOG.limits["command.artifact.upload.maximum_raw_bytes"] * 4 / 3))
        ? parsed(commandEntry(COMMAND_CATALOG.artifactUploadAppend), params) : null;
    case COMMAND_CATALOG.artifactUploadCommit.method:
      return hasExactKeys(params, ["artifactRef", "sha256"]) && isArtifactRefShape(params.artifactRef) &&
        typeof params.sha256 === "string" && /^[a-f0-9]{64}$/u.test(params.sha256)
        ? parsed(commandEntry(COMMAND_CATALOG.artifactUploadCommit), params) : null;
    case COMMAND_CATALOG.demoOpen.method:
      return hasExactKeys(params, ["artifactRef", "tabRef", "windowId", "active"]) && isArtifactRefShape(params.artifactRef) &&
        (params.tabRef === null || isTabRefShape(params.tabRef)) && (params.windowId === null || safeInteger(params.windowId, 1)) &&
        (params.tabRef === null || params.windowId === null) && typeof params.active === "boolean"
        ? parsed(commandEntry(COMMAND_CATALOG.demoOpen), params) : null;
    case COMMAND_CATALOG.pageWait.method: {
      if (!hasOnlyKeys(params, ["tabRef", "until", "timeoutMs", "url", "selector", "text"]) ||
          !isTabRefShape(params.tabRef) ||
          !safeInteger(params.timeoutMs, 1, COMMAND_CATALOG.limits["command.page.wait.maximum_timeout_ms"]) ||
          typeof params.until !== "string" ||
          !["committed", "domcontentloaded", "complete", "url", "present", "absent", "visible", "enabled", "text"].includes(params.until)) return null;
      const nodeCondition = ["present", "absent", "visible", "enabled", "text"].includes(params.until);
      const maximum = COMMAND_CATALOG.limits["command.dom.maximum_value_bytes"];
      if (nodeCondition ? !boundedString(params.selector, maximum) : params.selector !== undefined) return null;
      if (params.until === "text" ? !boundedString(params.text, maximum) : params.text !== undefined) return null;
      if (params.url !== undefined && !boundedString(params.url, maximum) || params.until === "url" && params.url === undefined) return null;
      return parsed(commandEntry(COMMAND_CATALOG.pageWait), params);
    }
    case COMMAND_CATALOG.pageTreeFind.method: {
      if (!hasOnlyKeys(params, ["rootRef", "text", "role", "selector", "subtree", "from", "limit"]) ||
          !isPageTreeRefShape(params.rootRef) || !safeInteger(params.limit, 1, COMMAND_CATALOG.limits["command.page.tree.maximum_view_items"]) ||
          params.subtree !== undefined && !isPageTreeIndexPath(params.subtree) ||
          params.from !== undefined && !isPageTreeIndexPath(params.from)) return null;
      let filters = 0;
      for (const name of ["text", "role", "selector"]) {
        if (params[name] === undefined) continue;
        if (!boundedString(params[name], COMMAND_CATALOG.limits["command.dom.maximum_value_bytes"])) return null;
        filters += 1;
      }
      return filters > 0 ? parsed(commandEntry(COMMAND_CATALOG.pageTreeFind), params) : null;
    }
    case COMMAND_CATALOG.systemDescribe.method:
      return hasExactKeys(params, []) ? parsed(commandEntry(COMMAND_CATALOG.systemDescribe), params) : null;
    case COMMAND_CATALOG.traceRead.method:
    case COMMAND_CATALOG.traceExport.method:
      return hasExactKeys(params, ["traceRef"]) && (params.traceRef === null || isTraceRefShape(params.traceRef))
        ? parsed(commandEntry(value.method === COMMAND_CATALOG.traceRead.method ? COMMAND_CATALOG.traceRead : COMMAND_CATALOG.traceExport), params)
        : null;
    case COMMAND_CATALOG.controlAcquire.method:
    case COMMAND_CATALOG.controlRelease.method:
      return hasExactKeys(params, ["scope", "tabRef"]) && parseControlTarget(params) !== null
        ? parsed(commandEntry(value.method === COMMAND_CATALOG.controlAcquire.method ? COMMAND_CATALOG.controlAcquire : COMMAND_CATALOG.controlRelease), params)
        : null;
    case COMMAND_CATALOG.tabsList.method:
      return hasExactKeys(params, ["afterTabId", "limit"]) &&
        (params.afterTabId === null || safeInteger(params.afterTabId)) &&
        safeInteger(params.limit, 1, COMMAND_CATALOG.limits["command.tabs.list.maximum_items"])
        ? parsed(commandEntry(COMMAND_CATALOG.tabsList), params)
        : null;
    case COMMAND_CATALOG.tabsGet.method:
    case COMMAND_CATALOG.tabsActivate.method:
    case COMMAND_CATALOG.tabsClose.method: {
      if (!hasExactKeys(params, ["tabRef"]) || !isTabRefShape(params.tabRef)) return null;
      const entry = value.method === COMMAND_CATALOG.tabsGet.method
        ? COMMAND_CATALOG.tabsGet
        : value.method === COMMAND_CATALOG.tabsActivate.method
          ? COMMAND_CATALOG.tabsActivate
          : COMMAND_CATALOG.tabsClose;
      return parsed(commandEntry(entry), params);
    }
    case COMMAND_CATALOG.tabsCreate.method:
      return hasExactKeys(params, ["active", "url", "windowId"]) &&
        typeof params.active === "boolean" &&
        boundedString(params.url, COMMAND_CATALOG.limits["command.dom.maximum_value_bytes"]) &&
        safeInteger(params.windowId, 1)
        ? parsed(commandEntry(COMMAND_CATALOG.tabsCreate), params)
        : null;
    case COMMAND_CATALOG.tabsNavigate.method:
      return hasExactKeys(params, ["tabRef", "url"]) && isTabRefShape(params.tabRef) &&
        boundedString(params.url, COMMAND_CATALOG.limits["command.dom.maximum_value_bytes"])
        ? parsed(commandEntry(COMMAND_CATALOG.tabsNavigate), params)
        : null;
    case COMMAND_CATALOG.tabsReload.method:
      return hasExactKeys(params, ["bypassCache", "tabRef"]) && typeof params.bypassCache === "boolean" && isTabRefShape(params.tabRef)
        ? parsed(commandEntry(COMMAND_CATALOG.tabsReload), params)
        : null;
    case COMMAND_CATALOG.pageDomGet.method:
    case COMMAND_CATALOG.pageDomCapture.method: {
      if (!hasExactKeys(params, ["root", "tabRef"]) || (params.root !== "body" && params.root !== "document") || !isTabRefShape(params.tabRef)) return null;
      return parsed(commandEntry(value.method === COMMAND_CATALOG.pageDomGet.method ? COMMAND_CATALOG.pageDomGet : COMMAND_CATALOG.pageDomCapture), params);
    }
    case COMMAND_CATALOG.pageTextGet.method:
    case COMMAND_CATALOG.pageArchiveCapture.method:
      if (!hasExactKeys(params, ["tabRef"]) || !isTabRefShape(params.tabRef)) return null;
      return parsed(commandEntry(value.method === COMMAND_CATALOG.pageTextGet.method ? COMMAND_CATALOG.pageTextGet : COMMAND_CATALOG.pageArchiveCapture), params);
    case COMMAND_CATALOG.pageTreeOpen.method:
      return hasExactKeys(params, ["targetRef"]) &&
        (isTabRefShape(params.targetRef) || isDocumentRefShape(params.targetRef))
        ? parsed(commandEntry(COMMAND_CATALOG.pageTreeOpen), params)
        : null;
    case COMMAND_CATALOG.pageTreeExpand.method:
      return hasExactKeys(params, ["treeRef"]) && isPageTreeRefShape(params.treeRef)
        ? parsed(commandEntry(COMMAND_CATALOG.pageTreeExpand), params)
        : null;
    case COMMAND_CATALOG.pageTreeViewGet.method: {
      if (!hasOnlyKeys(params, ["maximumLevel", "range", "rootRef", "subtree"]) ||
        !isPageTreeRefShape(params.rootRef)) return null;
      if ("maximumLevel" in params && !safeInteger(
        params.maximumLevel,
        0,
        COMMAND_CATALOG.limits["command.page.tree.maximum_index_depth"] - 1,
      )) return null;
      if ("range" in params && !isPageTreeSiblingRange(params.range)) return null;
      if ("subtree" in params && !isPageTreeIndexPath(params.subtree)) return null;
      return parsed(commandEntry(COMMAND_CATALOG.pageTreeViewGet), params);
    }
    case COMMAND_CATALOG.pageResourcesList.method:
      return hasExactKeys(params, ["limit", "tabRef"]) && isTabRefShape(params.tabRef) &&
        safeInteger(params.limit, 1, COMMAND_CATALOG.limits["command.page.resources.maximum_items"])
        ? parsed(commandEntry(COMMAND_CATALOG.pageResourcesList), params)
        : null;
    case COMMAND_CATALOG.pageScreenshotCapture.method:
      return hasExactKeys(params, ["format", "quality", "tabRef"]) &&
        (params.format === "jpeg" || params.format === "png") && safeInteger(params.quality, 0, 100) && isTabRefShape(params.tabRef)
        ? parsed(commandEntry(COMMAND_CATALOG.pageScreenshotCapture), params)
        : null;
    case COMMAND_CATALOG.framesList.method:
      return hasExactKeys(params, ["limit", "tabRef"]) && isTabRefShape(params.tabRef) &&
        safeInteger(params.limit, 1, COMMAND_CATALOG.limits["command.frames.list.maximum_items"])
        ? parsed(commandEntry(COMMAND_CATALOG.framesList), params)
        : null;
    case COMMAND_CATALOG.domQuery.method:
      return hasExactKeys(params, ["documentRef", "limit", "selector"]) && isDocumentRefShape(params.documentRef) &&
        safeInteger(params.limit, 1, COMMAND_CATALOG.limits["command.dom.query.maximum_results"]) &&
        boundedString(params.selector, COMMAND_CATALOG.limits["command.dom.maximum_value_bytes"])
        ? parsed(commandEntry(COMMAND_CATALOG.domQuery), params)
        : null;
    case COMMAND_CATALOG.domDescribe.method:
    case COMMAND_CATALOG.domClick.method:
      if (!hasExactKeys(params, ["nodeRef"]) || !isNodeRefShape(params.nodeRef)) return null;
      return parsed(commandEntry(value.method === COMMAND_CATALOG.domDescribe.method ? COMMAND_CATALOG.domDescribe : COMMAND_CATALOG.domClick), params);
    case COMMAND_CATALOG.domClickReal.method:
      return hasExactKeys(params, ["nodeRef", "scrollIntoView", "timeoutMs"]) && isNodeRefShape(params.nodeRef) &&
        typeof params.scrollIntoView === "boolean" &&
        safeInteger(params.timeoutMs, 1, COMMAND_CATALOG.limits["command.dom.click.real.maximum_timeout_ms"])
        ? parsed(commandEntry(COMMAND_CATALOG.domClickReal), params)
        : null;
    case COMMAND_CATALOG.domFocus.method:
      return hasExactKeys(params, ["nodeRef", "preventScroll"]) && isNodeRefShape(params.nodeRef) && typeof params.preventScroll === "boolean"
        ? parsed(commandEntry(COMMAND_CATALOG.domFocus), params)
        : null;
    case COMMAND_CATALOG.domInsertText.method:
      return hasExactKeys(params, ["nodeRef", "text"]) && isNodeRefShape(params.nodeRef) &&
        boundedString(params.text, COMMAND_CATALOG.limits["command.dom.maximum_value_bytes"])
        ? parsed(commandEntry(COMMAND_CATALOG.domInsertText), params)
        : null;
    case COMMAND_CATALOG.domScroll.method:
      return hasExactKeys(params, ["behavior", "block", "inline", "nodeRef"]) &&
        (params.behavior === "auto" || params.behavior === "smooth") &&
        (params.block === "center" || params.block === "end" || params.block === "nearest" || params.block === "start") &&
        (params.inline === "center" || params.inline === "end" || params.inline === "nearest" || params.inline === "start") &&
        isNodeRefShape(params.nodeRef)
        ? parsed(commandEntry(COMMAND_CATALOG.domScroll), params)
        : null;
    case COMMAND_CATALOG.domSelect.method:
      return hasExactKeys(params, ["nodeRef", "values"]) && isNodeRefShape(params.nodeRef) &&
        stringArray(params.values, COMMAND_CATALOG.limits["command.dom.query.maximum_results"], COMMAND_CATALOG.limits["command.dom.maximum_value_bytes"])
        ? parsed(commandEntry(COMMAND_CATALOG.domSelect), params)
        : null;
    case COMMAND_CATALOG.domSetValue.method:
      return hasExactKeys(params, ["nodeRef", "value"]) && isNodeRefShape(params.nodeRef) &&
        boundedString(params.value, COMMAND_CATALOG.limits["command.dom.maximum_value_bytes"], true)
        ? parsed(commandEntry(COMMAND_CATALOG.domSetValue), params)
        : null;
    case COMMAND_CATALOG.jsExecute.method:
      return hasExactKeys(params, ["code", "tabRef", "timeoutMs", "world"]) && isTabRefShape(params.tabRef) &&
        (params.world === "USER_SCRIPT" || params.world === "MAIN") &&
        boundedString(params.code, COMMAND_CATALOG.limits["command.js.maximum_source_bytes"], true) &&
        safeInteger(params.timeoutMs, 1, COMMAND_CATALOG.limits["command.js.maximum_timeout_ms"])
        ? parsed(commandEntry(COMMAND_CATALOG.jsExecute), params)
        : null;
    case COMMAND_CATALOG.keyboardPress.method: {
      if (!hasExactKeys(params, ["gapMs", "holdMs", "keys", "targetRef", "timeoutMs"]) ||
          !(isTabRefShape(params.targetRef) || isNodeRefShape(params.targetRef)) ||
          !safeInteger(params.holdMs, 0, COMMAND_CATALOG.limits["command.keyboard.maximum_wait_ms"]) ||
          !safeInteger(params.gapMs, 0, COMMAND_CATALOG.limits["command.keyboard.maximum_wait_ms"]) ||
          !safeInteger(params.timeoutMs, 1, COMMAND_CATALOG.limits["command.keyboard.maximum_short_timeout_ms"])) return null;
      const actions = parseKeyboardActions(
        params.keys,
        params.holdMs,
        params.gapMs,
        COMMAND_CATALOG.limits["command.keyboard.maximum_sequence_actions"],
        COMMAND_CATALOG.limits["command.keyboard.maximum_chord_keys"],
        COMMAND_CATALOG.limits["command.keyboard.maximum_wait_ms"],
      );
      return actions === null ? null : parsed(commandEntry(COMMAND_CATALOG.keyboardPress), { ...params, actions });
    }
    case COMMAND_CATALOG.keyboardReset.method:
      return hasExactKeys(params, ["timeoutMs"]) &&
        safeInteger(params.timeoutMs, 1, COMMAND_CATALOG.limits["command.keyboard.maximum_short_timeout_ms"])
        ? parsed(commandEntry(COMMAND_CATALOG.keyboardReset), params)
        : null;
    case COMMAND_CATALOG.keyboardType.method:
      return hasExactKeys(params, ["targetRef", "text", "timeoutMs"]) &&
        (isTabRefShape(params.targetRef) || isNodeRefShape(params.targetRef)) &&
        boundedString(params.text, COMMAND_CATALOG.limits["command.keyboard.maximum_text_bytes"]) &&
        hasOnlyUnicodeScalars(params.text) &&
        safeInteger(params.timeoutMs, 1, COMMAND_CATALOG.limits["command.keyboard.maximum_short_timeout_ms"])
        ? parsed(commandEntry(COMMAND_CATALOG.keyboardType), params)
        : null;
    case COMMAND_CATALOG.keyboardTypeHuman.method:
      return hasExactKeys(params, ["charactersPerMinute", "mistakePercent", "randomSeed", "targetRef", "text", "timeoutMs"]) &&
        (isTabRefShape(params.targetRef) || isNodeRefShape(params.targetRef)) &&
        boundedString(params.text, COMMAND_CATALOG.limits["command.keyboard.maximum_text_bytes"]) &&
        hasOnlyUnicodeScalars(params.text) &&
        inRegisteredRange(params.charactersPerMinute, "command.keyboard.human.default_characters_per_minute") &&
        inRegisteredRange(params.mistakePercent, "command.keyboard.human.default_mistake_percent") &&
        (params.randomSeed === null || safeInteger(params.randomSeed, 0, 0xffff_ffff)) &&
        safeInteger(params.timeoutMs, 1, COMMAND_CATALOG.limits["command.keyboard.maximum_human_timeout_ms"])
        ? parsed(commandEntry(COMMAND_CATALOG.keyboardTypeHuman), params)
        : null;
    case COMMAND_CATALOG.artifactRead.method:
      return hasExactKeys(params, ["artifactRef", "maximumBytes", "offset"]) && isArtifactRefShape(params.artifactRef) &&
        safeInteger(params.maximumBytes, 1, COMMAND_CATALOG.limits["command.artifact.read.maximum_raw_bytes"]) && safeInteger(params.offset)
        ? parsed(commandEntry(COMMAND_CATALOG.artifactRead), params)
        : null;
    case COMMAND_CATALOG.artifactRelease.method:
      return hasExactKeys(params, ["artifactRef"]) && isArtifactRefShape(params.artifactRef)
        ? parsed(commandEntry(COMMAND_CATALOG.artifactRelease), params)
        : null;
    case COMMAND_CATALOG.resourceFetch.method:
      return hasExactKeys(params, ["cache", "credentials", "url"]) && isHttpUrl(params.url) &&
        boundedString(params.url, COMMAND_CATALOG.limits["command.tabs.maximum_text_bytes"]) &&
        (params.credentials === "include" || params.credentials === "omit") &&
        (params.cache === "default" || params.cache === "no-store" || params.cache === "reload")
        ? parsed(commandEntry(COMMAND_CATALOG.resourceFetch), params)
        : null;
    case COMMAND_CATALOG.keysList.method:
      return hasExactKeys(params, ["afterKeyId", "limit"]) && (params.afterKeyId === null || isKeyId(params.afterKeyId)) &&
        safeInteger(params.limit, 1, COMMAND_CATALOG.limits["command.keys.list.maximum_items"])
        ? parsed(commandEntry(COMMAND_CATALOG.keysList), params)
        : null;
    case COMMAND_CATALOG.keysGet.method:
    case COMMAND_CATALOG.keysReveal.method: {
      if (!hasExactKeys(params, ["keyId"]) || !isKeyId(params.keyId)) return null;
      return parsed(commandEntry(value.method === COMMAND_CATALOG.keysGet.method ? COMMAND_CATALOG.keysGet : COMMAND_CATALOG.keysReveal), params);
    }
    case COMMAND_CATALOG.keysCreate.method:
      return hasExactKeys(params, ["displayName", "enabled", "expiresAt", "keyKind", "mutationId", "permissions"]) &&
        isMutationId(params.mutationId) && isDisplayName(params.displayName) &&
        (params.keyKind === "root" || params.keyKind === "regular") && isPermissionList(params.permissions) &&
        (params.keyKind !== "root" || params.permissions.length === 0) && isExpiry(params.expiresAt) && typeof params.enabled === "boolean"
        ? parsed(commandEntry(COMMAND_CATALOG.keysCreate), params)
        : null;
    case COMMAND_CATALOG.keysUpdate.method:
      return hasExactKeys(params, ["expectedRevision", "keyId", "mutationId", "patch"]) &&
        safeInteger(params.expectedRevision, 1) && isKeyId(params.keyId) && isMutationId(params.mutationId) && isKeyPatch(params.patch)
        ? parsed(commandEntry(COMMAND_CATALOG.keysUpdate), params)
        : null;
    case COMMAND_CATALOG.keysRevoke.method:
      return hasExactKeys(params, ["expectedRevision", "keyId", "mutationId"]) && safeInteger(params.expectedRevision, 1) &&
        isKeyId(params.keyId) && isMutationId(params.mutationId)
        ? parsed(commandEntry(COMMAND_CATALOG.keysRevoke), params)
        : null;
    case COMMAND_CATALOG.settingsGet.method:
      return hasExactKeys(params, []) ? parsed(commandEntry(COMMAND_CATALOG.settingsGet), params) : null;
    case COMMAND_CATALOG.settingsUpdate.method:
      return hasExactKeys(params, ["artifactMaximumBytes", "artifactMaximumCount", "artifactMaximumTotalBytes", "artifactRetentionMs", "expectedRevision"]) &&
        safeInteger(params.expectedRevision, 1) &&
        inRegisteredRange(params.artifactMaximumBytes, "runtime.artifact.default_maximum_bytes") &&
        inRegisteredRange(params.artifactMaximumCount, "runtime.artifact.default_maximum_count") &&
        inRegisteredRange(params.artifactMaximumTotalBytes, "runtime.artifact.default_maximum_total_bytes") &&
        inRegisteredRange(params.artifactRetentionMs, "runtime.artifact.default_retention_ms") &&
        params.artifactMaximumBytes <= params.artifactMaximumTotalBytes
        ? parsed(commandEntry(COMMAND_CATALOG.settingsUpdate), params)
        : null;
    default:
      return null;
  }
}

const ENSURE_NODE_REF_PLACEHOLDER = `nr1.${"A".repeat(43)}`;
const ENSURE_NODE_ACTIONS = new Set([
  "dom.click",
  "dom.click.real",
  "dom.focus",
  "dom.insertText",
  "dom.scroll",
  "dom.select",
  "dom.setValue",
]);
const ENSURE_OPTIONAL_TARGET_ACTIONS = new Set(["keyboard.press", "keyboard.type", "keyboard.typeHuman"]);

function derivedEnsureGoal(method: string, target: DomTarget | null, params: Readonly<Record<string, unknown>>): EnsureCondition | null {
  if (method === "dom.setValue" && target !== null) {
    return { kind: "value_is", target, value: textParam(params as Record<string, unknown>, "value") };
  }
  if (method === "dom.select" && target !== null) {
    return { kind: "selected_values_are", target, values: params.values as readonly string[] };
  }
  if (method === "dom.focus" && target !== null) return { kind: "focused", target };
  if (method === "tabs.activate") return { kind: "tab_active", tabRef: textParam(params as Record<string, unknown>, "tabRef") };
  return null;
}

function parseEnsureAction(value: unknown): EnsureAction | null {
  if (!isRecord(value) || typeof value.method !== "string" || !safeInteger(value.schemaVersion, 1) || !isRecord(value.params)) return null;
  const policy = COMMAND_CATALOG.ensurePolicyByMethod[value.method as keyof typeof COMMAND_CATALOG.ensurePolicyByMethod];
  if (policy === undefined || policy.allowed !== true) return null;
  const needsTarget = ENSURE_NODE_ACTIONS.has(value.method);
  const optionalTarget = ENSURE_OPTIONAL_TARGET_ACTIONS.has(value.method);
  const hasTarget = Object.hasOwn(value, "target");
  if (needsTarget || optionalTarget && hasTarget ? !hasExactKeys(value, ["method", "schemaVersion", "target", "params"]) :
      !hasExactKeys(value, ["method", "schemaVersion", "params"])) return null;
  const target = needsTarget || optionalTarget && hasTarget ? parseDomTarget(value.target) : null;
  const targetParameter = optionalTarget ? "targetRef" : "nodeRef";
  if ((needsTarget || optionalTarget && hasTarget) && (target === null || Object.hasOwn(value.params, targetParameter))) return null;
  const primitive = parsePrimitiveCommand({
    method: value.method,
    schemaVersion: value.schemaVersion,
    params: needsTarget || optionalTarget && hasTarget
      ? { ...value.params, [targetParameter]: ENSURE_NODE_REF_PLACEHOLDER }
      : value.params,
  });
  if (primitive === null || primitive.kind === "ensure.run") return null;
  const normalizedParams = { ...primitive.params };
  if (needsTarget || optionalTarget && hasTarget) delete normalizedParams[targetParameter];
  return {
    method: primitive.kind,
    schemaVersion: value.schemaVersion,
    requiredPermission: primitive.requiredPermission,
    params: normalizedParams,
    target,
    policy: { completion: policy.completion, repeat: policy.repeat },
    derivedGoal: derivedEnsureGoal(primitive.kind, target, normalizedParams),
  };
}

export function parseCommand(value: unknown): ParsedCommand | null {
  if (!isRecord(value) || value.method !== COMMAND_CATALOG.ensureRun.method) return parsePrimitiveCommand(value);
  if (!hasExactKeys(value, ["method", "schemaVersion", "params"]) ||
      value.schemaVersion !== COMMAND_CATALOG.ensureRun.schemaVersion || !isRecord(value.params)) return null;
  const params: Record<string, unknown> = {
    ...COMMAND_CATALOG.parameterDefaultsByMethod[COMMAND_CATALOG.ensureRun.method],
    ...value.params,
  };
  const ensureRequest = parseEnsureParameters(params, parseEnsureAction);
  return ensureRequest === null ? null : {
    kind: COMMAND_CATALOG.ensureRun.method,
    schemaVersion: COMMAND_CATALOG.ensureRun.schemaVersion,
    requiredPermission: COMMAND_CATALOG.ensureRun.requiredPermission,
    effectKind: COMMAND_CATALOG.ensureRun.effectKind,
    params,
    ensureRequest,
  };
}

function parseControlTarget(params: Record<string, unknown>): ControlTarget | null {
  if (params.scope === "global" && params.tabRef === null) return { scope: "global", tabRef: null };
  if (params.scope === "tab" && isTabRefShape(params.tabRef)) return { scope: "tab", tabRef: params.tabRef };
  return null;
}

function parseRouteRequest(value: unknown): ParsedRouteRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "routeId", "payload"])) return null;
  if (value.kind !== "route.request" || typeof value.routeId !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value.routeId)) return null;
  const payload = value.payload;
  if (!isRecord(payload) || !hasExactKeys(payload, ["clientRequestId", "auth", "command"])) return null;
  if (typeof payload.clientRequestId !== "string" || payload.clientRequestId.length === 0 || payload.clientRequestId.length > 128) return null;
  const auth = payload.auth;
  if (!isRecord(auth) || !hasExactKeys(auth, ["apiKey"]) || typeof auth.apiKey !== "string") return null;
  const command = parseCommand(payload.command);
  return command === null
    ? null
    : { routeId: value.routeId, clientRequestId: payload.clientRequestId, apiKey: auth.apiKey, command };
}

interface TraceResponseMetadata {
  readonly state: TraceResponseState;
  readonly traceRef: string | null;
}

const NOT_ADMITTED_TRACE: TraceResponseMetadata = { state: "not_admitted", traceRef: null };

function errorResponse(
  routeId: string,
  clientRequestId: string,
  error: PublicCommandError,
  trace: TraceResponseMetadata = NOT_ADMITTED_TRACE,
): unknown {
  return {
    kind: "route.response",
    routeId,
    payload: {
      clientRequestId,
      ok: false,
      error: error.details === undefined ? { code: error.code } : { code: error.code, details: error.details },
      trace,
    },
  };
}

function successResponse(
  routeId: string,
  clientRequestId: string,
  result: unknown,
  trace: TraceResponseMetadata,
): unknown {
  return { kind: "route.response", routeId, payload: { clientRequestId, ok: true, result, trace } };
}

function authErrorCode(result: AuthenticationResult): CommandErrorCode {
  return result.ok ? "INTERNAL_ERROR" : result.code;
}

async function runInKeyLane<T>(keyId: string, operation: () => Promise<T>): Promise<T> {
  const previous = keyLaneTails.get(keyId) ?? Promise.resolve();
  let release!: () => void;
  const completion = new Promise<void>((resolve) => { release = resolve; });
  keyLaneTails.set(keyId, completion);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (keyLaneTails.get(keyId) === completion) keyLaneTails.delete(keyId);
  }
}

function textParam(params: Record<string, unknown>, name: string): string {
  return params[name] as string;
}

function numberParam(params: Record<string, unknown>, name: string): number {
  return params[name] as number;
}

function booleanParam(params: Record<string, unknown>, name: string): boolean {
  return params[name] as boolean;
}

async function executePrimitiveCommand(
  command: ParsedCommand,
  caller: PublicKeyRecord,
  context: {
    readonly routeId: string;
    readonly apiKey: string;
    readonly recordTraceEvent: (event: ExecutionTraceEventInput) => void;
    readonly checkpointTrace: () => Promise<void>;
  },
): Promise<unknown> {
  const params = command.params;
  switch (command.kind) {
    case "debugger.attach":
    case "debugger.detach":
    case "debugger.send": {
      const tabRef = textParam(params, "tabRef");
      const dispatch: DebuggerDispatch = async (effect) => {
        const auth = await authenticateApiKey(context.apiKey, "debugger");
        if (!auth.ok) throw new DispatchAuthorizationError(authErrorCode(auth));
        if (auth.key.keyId !== caller.keyId) throw new DispatchAuthorizationError("UNAUTHENTICATED");
        return dispatchWithControlGate(caller.keyId, tabRef, effect);
      };
      if (command.kind === "debugger.attach") return attachDebugger(tabRef, dispatch);
      if (command.kind === "debugger.detach") return detachDebugger(tabRef, dispatch);
      return sendDebuggerCommand(caller.keyId, params as unknown as DebuggerSendRequest, dispatch);
    }
    case "debugger.events.get":
      return getDebuggerEvents(textParam(params, "tabRef"), numberParam(params, "afterSequence"), numberParam(params, "limit"));
    case "page.screenshot.element":
      return captureElementScreenshot(caller.keyId, params as unknown as ElementScreenshotRequest);
    case "artifact.upload.begin":
      return beginArtifactUpload(caller.keyId, numberParam(params, "byteLength"), "text/html");
    case "artifact.upload.append":
      return appendArtifactUpload(caller.keyId, textParam(params, "artifactRef"), numberParam(params, "offset"), textParam(params, "dataBase64Url"));
    case "artifact.upload.commit":
      return commitArtifactUpload(caller.keyId, textParam(params, "artifactRef"), textParam(params, "sha256"));
    case "demo.open":
      return openDemo(caller.keyId, params as unknown as OpenDemoParams);
    case "system.describe": {
      const manifest = chrome.runtime.getManifest();
      return {
        product: TRANSPORT_CONFIG.product,
        extensionVersion: manifest.version,
        buildId: TRANSPORT_CONFIG.buildId,
        callerKeyId: caller.keyId,
        effectivePermissions: caller.keyKind === "root" ? COMMAND_CATALOG.activePermissionIds : caller.permissions,
        transportProfile: TRANSPORT_CONFIG.profileId,
        activeCommandIds: COMMAND_CATALOG.activeCommandIds,
        activePermissionIds: COMMAND_CATALOG.activePermissionIds,
        activeCapabilityIds: COMMAND_CATALOG.activeCapabilityIds,
      };
    }
    case "trace.read":
      return { trace: await readExecutionTrace(caller.keyId, params.traceRef as string | null) };
    case "trace.export":
      return exportExecutionTrace(caller.keyId, params.traceRef as string | null);
    case "control.acquire": {
      const target = parseControlTarget(params);
      if (target === null) throw new Error("Validated control target became invalid");
      if (target.scope !== "tab") return acquireControl(caller.keyId, target);
      const resolved = await resolveTabTarget(target.tabRef ?? "");
      return acquireControl(caller.keyId, target, () => assertResolvedTabTarget(resolved));
    }
    case "control.release": {
      const target = parseControlTarget(params);
      if (target === null) throw new Error("Validated control target became invalid");
      return releaseControl(target);
    }
    case "tabs.list":
      return listTabs(params as unknown as TabsListParams);
    case "tabs.get":
      return { tab: await getTab(textParam(params, "tabRef")) };
    case "tabs.create":
      return dispatchWithGlobalControlGate(caller.keyId, () => createTab({
        url: textParam(params, "url"), active: booleanParam(params, "active"), windowId: numberParam(params, "windowId"),
      }));
    case "tabs.navigate": {
      const tabRef = textParam(params, "tabRef");
      return dispatchWithControlGate(caller.keyId, tabRef, () => navigateTab(tabRef, textParam(params, "url")));
    }
    case "tabs.activate": {
      const tabRef = textParam(params, "tabRef");
      return dispatchWithControlGate(caller.keyId, tabRef, () => activateTab(tabRef));
    }
    case "tabs.reload": {
      const tabRef = textParam(params, "tabRef");
      return dispatchWithControlGate(caller.keyId, tabRef, () => reloadTab(tabRef, booleanParam(params, "bypassCache")));
    }
    case "tabs.close": {
      const tabRef = textParam(params, "tabRef");
      return dispatchWithControlGate(caller.keyId, tabRef, () => closeTab(tabRef));
    }
    case "page.dom.get":
      return getPageDom(textParam(params, "tabRef"), textParam(params, "root") as PageDomRoot);
    case "page.dom.capture":
      return capturePageDomArtifact(caller.keyId, textParam(params, "tabRef"), textParam(params, "root") as PageDomRoot);
    case "page.text.get":
      return getPageText(textParam(params, "tabRef"));
    case "page.wait":
      return waitForPage(params as unknown as PageWaitRequest);
    case "page.tree.find":
      return findPageTree(caller.keyId, params as unknown as PageTreeFindRequest);
    case "page.tree.open":
      return openPageTree(textParam(params, "targetRef"), caller.keyId);
    case "page.tree.expand":
      return expandPageTree(textParam(params, "treeRef"), caller.keyId);
    case "page.tree.view.get":
      return getPageTreeView(caller.keyId, params as unknown as PageTreeViewRequest);
    case "page.resources.list":
      return getPageResources(textParam(params, "tabRef"), numberParam(params, "limit"));
    case "page.archive.capture":
      return capturePageArchive(caller.keyId, textParam(params, "tabRef"));
    case "page.screenshot.capture":
      return captureVisibleScreenshot(
        caller.keyId,
        textParam(params, "tabRef"),
        textParam(params, "format") as "jpeg" | "png",
        numberParam(params, "quality"),
      );
    case "frames.list":
      return listFrames(textParam(params, "tabRef"), numberParam(params, "limit"));
    case "dom.query":
      return queryDom(textParam(params, "documentRef"), textParam(params, "selector"), numberParam(params, "limit"));
    case "dom.describe":
      return describeDomNode(textParam(params, "nodeRef"));
    case "dom.click": {
      const nodeRef = textParam(params, "nodeRef");
      return dispatchWithControlGate(caller.keyId, tabRefForNode(nodeRef), () => clickDomNode(nodeRef));
    }
    case "dom.click.real": {
      const nodeRef = textParam(params, "nodeRef");
      const tabRef = tabRefForNode(nodeRef);
      return dispatchWithControlGate(caller.keyId, tabRef, () => clickRealDomNode({
        routeId: context.routeId,
        nodeRef,
        scrollIntoView: booleanParam(params, "scrollIntoView"),
        timeoutMs: numberParam(params, "timeoutMs"),
        revalidateAuthority: async () => {
          const auth = await authenticateApiKey(context.apiKey, "dom.click.real");
          if (!auth.ok) throw new DispatchAuthorizationError(authErrorCode(auth));
          if (auth.key.keyId !== caller.keyId) throw new DispatchAuthorizationError("UNAUTHENTICATED");
          await assertControlGate(caller.keyId, tabRef);
        },
      }));
    }
    case "dom.focus": {
      const nodeRef = textParam(params, "nodeRef");
      return dispatchWithControlGate(caller.keyId, tabRefForNode(nodeRef), () => focusDomNode(nodeRef, booleanParam(params, "preventScroll")));
    }
    case "dom.insertText": {
      const nodeRef = textParam(params, "nodeRef");
      return dispatchWithControlGate(caller.keyId, tabRefForNode(nodeRef), () => insertDomNodeText(nodeRef, textParam(params, "text")));
    }
    case "dom.scroll": {
      const nodeRef = textParam(params, "nodeRef");
      return dispatchWithControlGate(caller.keyId, tabRefForNode(nodeRef), () => scrollDomNode(
        nodeRef,
        textParam(params, "behavior") as "auto" | "smooth",
        textParam(params, "block") as "center" | "end" | "nearest" | "start",
        textParam(params, "inline") as "center" | "end" | "nearest" | "start",
      ));
    }
    case "dom.select": {
      const nodeRef = textParam(params, "nodeRef");
      return dispatchWithControlGate(caller.keyId, tabRefForNode(nodeRef), () => selectDomNodeValues(nodeRef, params.values as readonly string[]));
    }
    case "dom.setValue": {
      const nodeRef = textParam(params, "nodeRef");
      return dispatchWithControlGate(caller.keyId, tabRefForNode(nodeRef), () => setDomNodeValue(nodeRef, textParam(params, "value")));
    }
    case "keyboard.press": {
      const targetRef = textParam(params, "targetRef");
      const tabRef = tabRefForKeyboardTarget(targetRef);
      return dispatchWithControlGate(caller.keyId, tabRef, () => pressKeyboard({
        routeId: context.routeId,
        targetRef,
        timeoutMs: numberParam(params, "timeoutMs"),
        revalidateAuthority: async () => {
          const auth = await authenticateApiKey(context.apiKey, "keyboard.press");
          if (!auth.ok) throw new DispatchAuthorizationError(authErrorCode(auth));
          if (auth.key.keyId !== caller.keyId) throw new DispatchAuthorizationError("UNAUTHENTICATED");
          await assertControlGate(caller.keyId, tabRef);
        },
      }, params.actions as readonly NativeKeyboardAction[]));
    }
    case "keyboard.reset":
      return resetKeyboard({
        routeId: context.routeId,
        timeoutMs: numberParam(params, "timeoutMs"),
        revalidateAuthority: async () => {
          const auth = await authenticateApiKey(context.apiKey, "keyboard.reset");
          if (!auth.ok) throw new DispatchAuthorizationError(authErrorCode(auth));
          if (auth.key.keyId !== caller.keyId) throw new DispatchAuthorizationError("UNAUTHENTICATED");
        },
      });
    case "keyboard.type": {
      const targetRef = textParam(params, "targetRef");
      const tabRef = tabRefForKeyboardTarget(targetRef);
      return dispatchWithControlGate(caller.keyId, tabRef, () => typeKeyboardText({
        routeId: context.routeId,
        targetRef,
        timeoutMs: numberParam(params, "timeoutMs"),
        revalidateAuthority: async () => {
          const auth = await authenticateApiKey(context.apiKey, "keyboard.type");
          if (!auth.ok) throw new DispatchAuthorizationError(authErrorCode(auth));
          if (auth.key.keyId !== caller.keyId) throw new DispatchAuthorizationError("UNAUTHENTICATED");
          await assertControlGate(caller.keyId, tabRef);
        },
      }, textParam(params, "text")));
    }
    case "keyboard.typeHuman": {
      const targetRef = textParam(params, "targetRef");
      const tabRef = tabRefForKeyboardTarget(targetRef);
      return dispatchWithControlGate(caller.keyId, tabRef, () => typeKeyboardTextHuman({
        routeId: context.routeId,
        targetRef,
        timeoutMs: numberParam(params, "timeoutMs"),
        revalidateAuthority: async () => {
          const auth = await authenticateApiKey(context.apiKey, "keyboard.typeHuman");
          if (!auth.ok) throw new DispatchAuthorizationError(authErrorCode(auth));
          if (auth.key.keyId !== caller.keyId) throw new DispatchAuthorizationError("UNAUTHENTICATED");
          await assertControlGate(caller.keyId, tabRef);
        },
      }, textParam(params, "text"), numberParam(params, "charactersPerMinute"),
      numberParam(params, "mistakePercent"), params.randomSeed as number | null));
    }
    case "js.execute": {
      const tabRef = textParam(params, "tabRef");
      const target = await resolveTabTarget(tabRef);
      await ensureUserScriptsAvailable();
      assertResolvedTabTarget(target);
      return dispatchWithControlGate(caller.keyId, tabRef, () => executeJavaScript(
        target,
        textParam(params, "world") as JavaScriptWorld,
        textParam(params, "code"),
        numberParam(params, "timeoutMs"),
      ));
    }
    case "artifact.read":
      return readArtifact(caller.keyId, textParam(params, "artifactRef"), numberParam(params, "offset"), numberParam(params, "maximumBytes"));
    case "artifact.release":
      return releaseArtifact(caller.keyId, textParam(params, "artifactRef"));
    case "resource.fetch":
      return fetchResource(
        caller.keyId,
        textParam(params, "url"),
        textParam(params, "credentials") as "include" | "omit",
        textParam(params, "cache") as "default" | "no-store" | "reload",
      );
    case "keys.list":
      return listKeys(params as unknown as ListKeysParams);
    case "keys.get":
      return { key: await getPublicKey(textParam(params, "keyId")) };
    case "keys.create":
      return createKeyForCaller(caller, params as unknown as CreateKeyParams);
    case "keys.update":
      return { key: await updateKeyForCaller(caller, params as unknown as UpdateKeyParams) };
    case "keys.revoke":
      return { key: await revokeKey(params as unknown as RevokeKeyParams) };
    case "keys.reveal":
      return revealKey(params as unknown as RevealKeyParams);
    case "settings.get":
      return { settings: await getRuntimeSettings() };
    case "settings.update":
      return { settings: await updateRuntimeSettings(params as unknown as UpdateSettingsParams) };
    default:
      throw new Error(`Unhandled parsed command: ${command.kind}`);
  }
}

async function executeCommand(
  command: ParsedCommand,
  caller: PublicKeyRecord,
  context: {
    readonly routeId: string;
    readonly apiKey: string;
    readonly recordTraceEvent: (event: ExecutionTraceEventInput) => void;
    readonly checkpointTrace: () => Promise<void>;
  },
): Promise<unknown> {
  if (command.kind !== "ensure.run") {
    if (command.effectKind === "none") return executePrimitiveCommand(command, caller, context);
    context.recordTraceEvent({ phase: "effect", operation: "effect_entered", status: "started" });
    await context.checkpointTrace();
    try {
      const result = await executePrimitiveCommand(command, caller, context);
      context.recordTraceEvent({ phase: "effect", operation: "effect_returned", status: "succeeded" });
      return result;
    } catch (error) {
      context.recordTraceEvent({ phase: "effect", operation: "effect_returned", status: "unknown" });
      throw error;
    }
  }
  const request = command.ensureRequest;
  if (request === undefined) throw new Error("Validated ensure command lost its normalized request");
  const authorize = async (permission: PermissionId): Promise<void> => {
    const workflowAuth = await authenticateApiKey(context.apiKey, "workflow.run");
    if (!workflowAuth.ok) throw new DispatchAuthorizationError(authErrorCode(workflowAuth));
    if (workflowAuth.key.keyId !== caller.keyId) throw new DispatchAuthorizationError("UNAUTHENTICATED");
    if (permission === "workflow.run") return;
    const childAuth = await authenticateApiKey(context.apiKey, permission);
    if (!childAuth.ok) throw new DispatchAuthorizationError(authErrorCode(childAuth));
    if (childAuth.key.keyId !== caller.keyId) throw new DispatchAuthorizationError("UNAUTHENTICATED");
  };
  return runEnsure(request, {
    authorize,
    observeTarget: observeDomTarget,
    observeLoaded: async (tabRef, state) => (await observePageCondition({
      tabRef,
      until: state,
      timeoutMs: 1,
    }))?.conditionSatisfied === true,
    observeTab: async (tabRef) => {
      const tab = await getTab(tabRef);
      if (tab.urlTruncated) throw new EnsureWorkflowError("DOM_OPERATION_FAILED", "The tab URL exceeds the observable condition bound");
      return { active: tab.active, url: tab.url };
    },
    executeJavascriptCondition: async (tabRef, world, code, timeoutMs) => {
      const target = await resolveTabTarget(tabRef);
      await ensureUserScriptsAvailable();
      assertResolvedTabTarget(target);
      const result = await dispatchWithControlGate(caller.keyId, tabRef, () => executeJavaScript(target, world, code, timeoutMs));
      if (result.status !== "fulfilled" || result.valueTruncated || (result.valueJson !== "true" && result.valueJson !== "false")) {
        throw new EnsureWorkflowError("DOM_OPERATION_FAILED", "A JavaScript condition must fulfill with one untruncated boolean value");
      }
      return result.valueJson === "true";
    },
    executeAction: (action, nodeRef) => executePrimitiveCommand({
      kind: action.method,
      schemaVersion: action.schemaVersion,
      requiredPermission: action.requiredPermission,
      effectKind: "page_effect",
      params: action.target === null ? { ...action.params } : {
        ...action.params,
        [ENSURE_OPTIONAL_TARGET_ACTIONS.has(action.method) ? "targetRef" : "nodeRef"]: nodeRef,
      },
    }, caller, context),
    scrollTarget: async (nodeRef) => {
      const defaults = COMMAND_CATALOG.parameterDefaultsByMethod[COMMAND_CATALOG.domScroll.method];
      await dispatchWithControlGate(caller.keyId, tabRefForNode(nodeRef), () => scrollDomNode(
        nodeRef,
        defaults.behavior,
        defaults.block,
        defaults.inline,
      ));
    },
    scrollSearch: (target, percent, cursor, scope) => dispatchWithControlGate(
      caller.keyId,
      target.tabRef,
      () => scrollDomTargetSearch(target, percent, cursor, scope),
    ),
    recordEvent: context.recordTraceEvent,
    checkpointEffect: context.checkpointTrace,
    normalizeError: publicCommandError,
    now: () => performance.now(),
    setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimer: (handle) => clearTimeout(handle),
  });
}

function mappedKeyServiceError(error: KeyServiceError): PublicCommandError {
  switch (error.code) {
    case "ADMIN_MUTATION_CONFLICT":
    case "INTERNAL_ERROR":
    case "KEY_NOT_FOUND":
    case "KEY_REVOKED":
    case "REVISION_CONFLICT":
    case "SCHEMA_INVALID":
    case "SECRET_NOT_RECOVERABLE":
    case "STORAGE_UNAVAILABLE":
      return error.code === "REVISION_CONFLICT" && error.details !== undefined
        ? { code: error.code, details: error.details }
        : { code: error.code };
    default:
      return { code: "INTERNAL_ERROR" };
  }
}

function publicCommandError(error: unknown): PublicCommandError {
  if (error instanceof DispatchAuthorizationError) return { code: error.code };
  if (error instanceof EnsureWorkflowError) {
    return error.details === undefined ? { code: error.code } : { code: error.code, details: error.details };
  }
  if (error instanceof ControlOccupiedError) {
    return { code: error.code, details: error.details as unknown as Readonly<Record<string, unknown>> };
  }
  if (error instanceof CapabilityUnavailableError) return { code: error.code, details: error.details as unknown as Readonly<Record<string, unknown>> };
  if (error instanceof TabServiceError) return { code: error.code };
  if (error instanceof DomServiceError) return { code: error.code };
  if (error instanceof DebuggerServiceError || error instanceof ElementScreenshotError) return { code: error.code, details: error.details };
  if (error instanceof NativeInputError) {
    return { code: error.code, details: error.details as unknown as Readonly<Record<string, unknown>> };
  }
  if (error instanceof PageTreeServiceError) return { code: error.code };
  if (error instanceof TraceServiceError) return { code: error.code };
  if (error instanceof ArtifactServiceError || error instanceof DemoServiceError) {
    return error.details === undefined ? { code: error.code } : { code: error.code, details: error.details };
  }
  if (error instanceof KeyManagementAuthorizationError) return { code: error.code };
  if (error instanceof KeyServiceError) return mappedKeyServiceError(error);
  if (error instanceof SettingsServiceError) return { code: error.code, details: error.details };
  if (error instanceof DOMException) return { code: "STORAGE_UNAVAILABLE" };
  return { code: "INTERNAL_ERROR" };
}

function appendTraceSafely(draft: ExecutionTraceDraft | null, event: ExecutionTraceEventInput): void {
  if (draft === null) return;
  try { appendExecutionTraceEvent(draft, event); }
  catch {
    // Diagnostics are subordinate to the admitted command and never change its outcome.
  }
}

function successfulTraceTerminal(command: ParsedCommand, result: unknown): TraceTerminal {
  if (command.kind !== COMMAND_CATALOG.ensureRun.method || !isRecord(result)) {
    return { outcome: "succeeded", errorCode: null, ensureStatus: null, ensureStage: null };
  }
  const status = result.status === "satisfied" || result.status === "failed" || result.status === "unknown"
    ? result.status
    : "unknown";
  const stage = result.stage === "condition" || result.stage === "prepare" || result.stage === "effect" || result.stage === "verify"
    ? result.stage
    : null;
  const nestedError = isRecord(result.error) && typeof result.error.code === "string" ? result.error.code : null;
  return {
    outcome: status === "satisfied" ? "succeeded" : status,
    errorCode: nestedError,
    ensureStatus: status,
    ensureStage: stage,
  };
}

function failedTraceTerminal(
  command: ParsedCommand,
  draft: ExecutionTraceDraft | null,
  error: PublicCommandError,
): TraceTerminal {
  const effectEntered = (draft?.effectEntries ?? 0) > 0;
  const uncertain = command.kind === COMMAND_CATALOG.ensureRun.method
    ? effectEntered
    : command.effectKind !== "none";
  return {
    outcome: uncertain ? "unknown" : "failed",
    errorCode: error.code,
    ensureStatus: command.kind === COMMAND_CATALOG.ensureRun.method ? (uncertain ? "unknown" : "failed") : null,
    ensureStage: command.kind === COMMAND_CATALOG.ensureRun.method
      ? effectEntered ? "effect" : "condition"
      : null,
  };
}

async function finishTraceSafely(
  draft: ExecutionTraceDraft | null,
  terminal: TraceTerminal,
): Promise<TraceResponseMetadata> {
  if (draft === null) return { state: "unavailable", traceRef: null };
  try {
    await finishExecutionTrace(draft, terminal);
    return { state: "complete", traceRef: draft.traceRef };
  } catch {
    return { state: "partial", traceRef: draft.traceRef };
  }
}

async function runAdmittedCommand(request: ParsedRouteRequest, caller: PublicKeyRecord): Promise<unknown> {
  let draft: ExecutionTraceDraft | null = null;
  const diagnostic = request.command.kind === "trace.read" || request.command.kind === "trace.export";
  if (!diagnostic) {
    try {
      draft = await beginExecutionTrace(
        caller.keyId,
        request.command.kind,
        request.command.schemaVersion,
        request.command.effectKind,
      );
    } catch {
      // The primary command remains available when diagnostic storage is unavailable.
    }
  }
  const recordTraceEvent = (event: ExecutionTraceEventInput): void => appendTraceSafely(draft, event);
  const checkpointTrace = async (): Promise<void> => {
    if (draft === null) return;
    try { await checkpointExecutionTrace(draft); }
    catch { /* A bounded diagnostic checkpoint never changes command semantics. */ }
  };
  recordTraceEvent({ phase: "command", operation: "handler_entered", status: "started" });
  try {
    const result = await executeCommand(request.command, caller, {
      routeId: request.routeId,
      apiKey: request.apiKey,
      recordTraceEvent,
      checkpointTrace,
    });
    recordTraceEvent({ phase: "command", operation: "handler_returned", status: "succeeded" });
    const trace = await finishTraceSafely(draft, successfulTraceTerminal(request.command, result));
    return successResponse(request.routeId, request.clientRequestId, result, trace);
  } catch (cause) {
    const error = publicCommandError(cause);
    recordTraceEvent({
      phase: "command",
      operation: "handler_returned",
      status: request.command.effectKind === "none" ? "failed" : "unknown",
    });
    const trace = await finishTraceSafely(draft, failedTraceTerminal(request.command, draft, error));
    return errorResponse(request.routeId, request.clientRequestId, error, trace);
  }
}

export async function dispatchRouteRequest(value: unknown): Promise<unknown> {
  const request = parseRouteRequest(value);
  if (request === null) {
    const routeId = isRecord(value) && typeof value.routeId === "string" ? value.routeId : "0";
    return errorResponse(routeId, "", { code: "SCHEMA_INVALID" });
  }
  try {
    const initialAuth = await authenticateApiKey(request.apiKey, request.command.requiredPermission);
    if (!initialAuth.ok) return errorResponse(request.routeId, request.clientRequestId, { code: authErrorCode(initialAuth) });
    return await runInKeyLane(initialAuth.key.keyId, async () => {
      const dispatchAuth = await authenticateApiKey(request.apiKey, request.command.requiredPermission);
      if (!dispatchAuth.ok) return errorResponse(request.routeId, request.clientRequestId, { code: authErrorCode(dispatchAuth) });
      return runAdmittedCommand(request, dispatchAuth.key);
    });
  } catch (error) {
    return errorResponse(request.routeId, request.clientRequestId, publicCommandError(error));
  }
}
