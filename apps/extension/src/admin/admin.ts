import "./setup.js";
import { createPermissionPicker } from "./permission-picker.js";
import { formatDate, formatNumber, formatRelativeDays, onLocaleChanged, t } from "../ui/page-ui.js";
import {
  ADMIN_PORT_NAME,
  CURRENT_PERMISSION_IDS,
  parseAdminRequest,
  type AdminError,
  type AdminMethod,
  type AdminMethodMap,
  type AdminRequest,
  type AdminResponse,
  type CreateKeyParams,
  type CreateKeyResult,
  type KeyKind,
  type PublicKeyRecord,
} from "../shared/admin-protocol.js";

const MAX_PENDING_REQUESTS = 32;
const REQUEST_TIMEOUT_MS = 10_000;
const PENDING_CREATE_STORAGE_KEY = "browser-key-automation.pending-create.v1";
const RECOVERY_VALIDATION_REQUEST_ID = "ui1.AAAAAAAAAAAAAAAAAAAAAA";
const API_KEY_PATTERN = /^bk1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/u;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timeoutId: number;
}

type ViewStatus = "active" | "disabled" | "expired" | "revoked";

class AdminClientError extends Error {
  readonly adminError: AdminError;

  constructor(error: AdminError) {
    super(`${error.code}: ${error.message}`);
    this.name = "AdminClientError";
    this.adminError = error;
  }
}

class AdminRequestUncertainError extends Error {
  readonly messageKey: "requestTimeout" | "deliveryFailed" | "connectionLost";
  constructor(messageKey: "requestTimeout" | "deliveryFailed" | "connectionLost", options?: ErrorOptions) {
    super(messageKey, options);
    this.name = "AdminRequestUncertainError";
    this.messageKey = messageKey;
  }
}

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (element === null) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  let index = 0;
  while (index < bytes.length) {
    binary += String.fromCharCode(bytes[index] ?? 0);
    index += 1;
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function createRequestId(): string {
  return `ui1.${randomToken()}`;
}

function createMutationId(): string {
  return `am1.${Date.now().toString().padStart(13, "0")}.${randomToken()}`;
}

function isAdminResponse(value: unknown): value is AdminResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.requestId !== "string" || typeof record.ok !== "boolean") return false;
  return record.ok ? "result" in record : typeof record.error === "object" && record.error !== null;
}

class AdminPortClient {
  #port: ChromeRuntimePort | null = null;
  readonly #pending = new Map<string, PendingRequest>();

  constructor() {
    this.#connect();
  }

  request<Method extends AdminMethod>(
    method: Method,
    params: AdminMethodMap[Method]["params"],
  ): Promise<AdminMethodMap[Method]["result"]> {
    if (this.#pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error("requestBusy"));
    let port: ChromeRuntimePort;
    try {
      port = this.#connect();
    } catch (error) {
      return Promise.reject(new Error("connectFailed", { cause: error }));
    }
    const requestId = createRequestId();
    const request = { requestId, method, params } as AdminRequest;
    return new Promise<AdminMethodMap[Method]["result"]>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new AdminRequestUncertainError("requestTimeout"));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(requestId, {
        resolve: (value) => resolve(value as AdminMethodMap[Method]["result"]),
        reject,
        timeoutId,
      });
      try {
        port.postMessage(request);
      } catch (error) {
        this.#handleDisconnect(
          port,
          new AdminRequestUncertainError("deliveryFailed", { cause: error }),
        );
      }
    });
  }

  #connect(): ChromeRuntimePort {
    if (this.#port !== null) return this.#port;
    const port = chrome.runtime.connect({ name: ADMIN_PORT_NAME });
    this.#port = port;
    port.onMessage.addListener((message) => this.#handleMessage(port, message));
    port.onDisconnect.addListener(() => this.#handleDisconnect(port));
    setConnectionState("connected");
    return port;
  }

  #handleMessage(port: ChromeRuntimePort, message: unknown): void {
    if (this.#port !== port) return;
    if (!isAdminResponse(message)) return;
    const pending = this.#pending.get(message.requestId);
    if (pending === undefined) return;
    window.clearTimeout(pending.timeoutId);
    this.#pending.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new AdminClientError(message.error));
  }

  #handleDisconnect(
    port: ChromeRuntimePort,
    error = new AdminRequestUncertainError("connectionLost"),
  ): void {
    if (this.#port !== port) return;
    this.#port = null;
    for (const pending of this.#pending.values()) {
      window.clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.#pending.clear();
    setConnectionState("disconnected");
  }
}

const connectionNode = requiredElement<HTMLElement>("[data-connection]");
const statusNode = requiredElement<HTMLElement>("[data-status]");
const openCreateButton = requiredElement<HTMLButtonElement>("[data-open-create]");
const emptyCreateButton = requiredElement<HTMLButtonElement>("[data-empty-create]");
const createDialog = requiredElement<HTMLDialogElement>("[data-create-dialog]");
const createForm = requiredElement<HTMLFormElement>("[data-create-form]");
const displayNameInput = requiredElement<HTMLInputElement>("[data-create-name]");
const keyKindSelect = requiredElement<HTMLSelectElement>("[data-create-kind]");
const expiryInput = requiredElement<HTMLInputElement>("[data-create-expiry]");
const enabledInput = requiredElement<HTMLInputElement>("[data-create-enabled]");
const createPermissionsNode = requiredElement<HTMLElement>("[data-create-permissions]");
const rootPermissionNote = requiredElement<HTMLElement>("[data-root-permission-note]");
const createButton = requiredElement<HTMLButtonElement>("[data-create-submit]");
const secretDialog = requiredElement<HTMLDialogElement>("[data-secret-dialog]");
const secretText = requiredElement<HTMLInputElement>("[data-secret]");
const copySecretButton = requiredElement<HTMLButtonElement>("[data-copy-secret]");
const keyTableBody = requiredElement<HTMLTableSectionElement>("[data-key-rows]");
const keyTable = requiredElement<HTMLTableElement>("table");
const keyCountNode = requiredElement<HTMLElement>("[data-key-count]");
const emptyState = requiredElement<HTMLElement>("[data-empty-state]");
const emptyTitle = requiredElement<HTMLElement>("[data-empty-title]");
const searchInput = requiredElement<HTMLInputElement>("[data-search]");
const statusFilter = requiredElement<HTMLSelectElement>("[data-status-filter]");
const refreshButton = requiredElement<HTMLButtonElement>("[data-refresh]");
const loadMoreButton = requiredElement<HTMLButtonElement>("[data-load-more]");
const editDialog = requiredElement<HTMLDialogElement>("[data-edit-dialog]");
const editForm = requiredElement<HTMLFormElement>("[data-edit-form]");
const editIdentity = requiredElement<HTMLElement>("[data-edit-identity]");
const editNameInput = requiredElement<HTMLInputElement>("[data-edit-name]");
const editExpiryInput = requiredElement<HTMLInputElement>("[data-edit-expiry]");
const editEnabledInput = requiredElement<HTMLInputElement>("[data-edit-enabled]");
const editPermissionFieldset = requiredElement<HTMLFieldSetElement>("[data-edit-permission-fieldset]");
const editPermissionsNode = requiredElement<HTMLElement>("[data-edit-permissions]");
const saveEditButton = requiredElement<HTMLButtonElement>("[data-save-edit]");
const openRevokeButton = requiredElement<HTMLButtonElement>("[data-open-revoke]");
const attachDialog = requiredElement<HTMLDialogElement>("[data-attach-dialog]");
const attachForm = requiredElement<HTMLFormElement>("[data-attach-form]");
const attachIdentity = requiredElement<HTMLElement>("[data-attach-identity]");
const attachSecretInput = requiredElement<HTMLInputElement>("[data-attach-secret]");
const attachSubmitButton = requiredElement<HTMLButtonElement>("[data-attach-submit]");
const revokeDialog = requiredElement<HTMLDialogElement>("[data-revoke-dialog]");
const revokeSummary = requiredElement<HTMLElement>("[data-revoke-summary]");
const confirmRevokeButton = requiredElement<HTMLButtonElement>("[data-confirm-revoke]");

const client = new AdminPortClient();
const records = new Map<string, PublicKeyRecord>();
const revealedKeys = new Map<string, string>();
const createPermissions = createPermissionPicker(createPermissionsNode, CURRENT_PERMISSION_IDS);
const editPermissions = createPermissionPicker(editPermissionsNode, []);
let nextAfterKeyId: string | null = null;
let pendingCreateParams = readPendingCreate();
let editingKeyId: string | null = null;
let attachingKeyId: string | null = null;
let revokingKeyId: string | null = null;
let statusTimer: number | null = null;
let statusText: (() => string) | null = null;

function setConnectionState(state: "connected" | "disconnected"): void {
  connectionNode.textContent = t(state);
  connectionNode.dataset.state = state;
}

function setStatus(message: string | (() => string), kind: "info" | "error" = "info", persistent = false): void {
  statusText = typeof message === "string" ? () => message : message;
  statusNode.textContent = statusText();
  statusNode.dataset.kind = kind;
  statusNode.dataset.visible = "true";
  if (statusTimer !== null) window.clearTimeout(statusTimer);
  statusTimer = persistent ? null : window.setTimeout(() => {
    statusNode.dataset.visible = "false";
    statusText = null;
    statusTimer = null;
  }, 3_800);
}

function clearStatus(): void {
  if (statusTimer !== null) window.clearTimeout(statusTimer);
  statusTimer = null;
  statusText = null;
  statusNode.dataset.visible = "false";
}

function errorMessage(error: unknown): string {
  if (error instanceof AdminClientError) {
    const friendly: Record<AdminError["code"], Parameters<typeof t>[0]> = {
      ADMIN_MUTATION_CONFLICT: "mutationConflict", INTERNAL_ERROR: "internalError", KEY_NOT_FOUND: "keyNotFound",
      KEY_REVOKED: "keyRevoked", KEY_SECRET_MISMATCH: "keyMismatch", REVISION_CONFLICT: "revisionConflict",
      SCHEMA_INVALID: "invalidRequest", SECRET_NOT_RECOVERABLE: "secretUnrecoverable", STORAGE_UNAVAILABLE: "storageUnavailable",
    };
    return t(friendly[error.adminError.code]);
  }
  if (error instanceof AdminRequestUncertainError) return t(error.messageKey);
  if (error instanceof Error && (error.message === "requestBusy" || error.message === "connectFailed")) return t(error.message);
  if (error instanceof Error && error.message === "invalidExpiry") return t("invalidExpiry");
  if (error instanceof Error && error.message === "mutationConflict") return t("mutationConflict");
  if (error instanceof Error && error.message === "keyNotFound") return t("keyNotFound");
  return t("unknownError");
}

function readPendingCreate(): CreateKeyParams | null {
  try {
    const serialized = sessionStorage.getItem(PENDING_CREATE_STORAGE_KEY);
    if (serialized === null) return null;
    const params: unknown = JSON.parse(serialized);
    const parsed = parseAdminRequest({
      requestId: RECOVERY_VALIDATION_REQUEST_ID,
      method: "keys.create",
      params,
    });
    if (parsed?.method === "keys.create") return parsed.params;
    sessionStorage.removeItem(PENDING_CREATE_STORAGE_KEY);
    return null;
  } catch {
    return null;
  }
}

function persistPendingCreate(params: CreateKeyParams): void {
  sessionStorage.setItem(PENDING_CREATE_STORAGE_KEY, JSON.stringify(params));
  pendingCreateParams = params;
}

function clearPendingCreate(): void {
  pendingCreateParams = null;
  clearStatus();
  try {
    sessionStorage.removeItem(PENDING_CREATE_STORAGE_KEY);
  } catch {
    // A stale non-secret entry can only cause a safe idempotent replay after reload.
  }
}

function canonicalCreateIntent(params: CreateKeyParams): string {
  return JSON.stringify([
    params.displayName.trim(),
    params.keyKind,
    params.keyKind === "root" ? [] : [...params.permissions].sort(),
    params.expiresAt,
    params.enabled,
  ]);
}

function sameCreateIntent(left: CreateKeyParams, right: CreateKeyParams): boolean {
  return canonicalCreateIntent(left) === canonicalCreateIntent(right);
}

function isUnknownMutationOutcome(error: unknown): boolean {
  if (error instanceof AdminRequestUncertainError) return true;
  return error instanceof AdminClientError &&
    (error.adminError.code === "INTERNAL_ERROR" || error.adminError.code === "STORAGE_UNAVAILABLE");
}

function expiryFromInput(input: HTMLInputElement): number | null {
  if (input.value === "") return null;
  const value = new Date(input.value).getTime();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalidExpiry");
  return value;
}

function expiryToInput(value: number | null): string {
  if (value === null) return "";
  const date = new Date(value);
  const local = new Date(value - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}


function setCreateKindState(kind: KeyKind): void {
  const isRoot = kind === "root";
  createPermissionsNode.hidden = isRoot;
  rootPermissionNote.hidden = !isRoot;
  createPermissions.setDisabled(isRoot);
}

function createParamsFromForm(mutationId: string): CreateKeyParams {
  const keyKind: KeyKind = keyKindSelect.value === "root" ? "root" : "regular";
  return {
    mutationId,
    displayName: displayNameInput.value,
    keyKind,
    permissions: keyKind === "root" ? [] : createPermissions.selectedPermissions(),
    expiresAt: expiryFromInput(expiryInput),
    enabled: enabledInput.checked,
  };
}

function restoreCreateForm(params: CreateKeyParams): void {
  displayNameInput.value = params.displayName;
  keyKindSelect.value = params.keyKind;
  expiryInput.value = expiryToInput(params.expiresAt);
  enabledInput.checked = params.enabled;
  createPermissions.setSelection(params.keyKind === "root" ? CURRENT_PERMISSION_IDS : params.permissions);
  setCreateKindState(params.keyKind);
}

function resetCreateForm(): void {
  createForm.reset();
  displayNameInput.value = t("defaultKeyName");
  keyKindSelect.value = "regular";
  expiryInput.value = "";
  enabledInput.checked = true;
  createPermissions.setSelection(CURRENT_PERMISSION_IDS);
  setCreateKindState("regular");
}

function showDialog(dialog: HTMLDialogElement): void {
  if (!dialog.open) dialog.showModal();
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (dialog.open) dialog.close();
}

function openCreateDialog(): void {
  if (pendingCreateParams !== null) restoreCreateForm(pendingCreateParams);
  else resetCreateForm();
  showDialog(createDialog);
  displayNameInput.focus();
  displayNameInput.select();
}

function showCreatedSecret(result: CreateKeyResult): void {
  if (!API_KEY_PATTERN.test(result.apiKey)) throw new Error("扩展后台返回了无效的 Key 格式");
  secretDialog.hidden = false;
  secretText.value = result.apiKey;
  showDialog(secretDialog);
  secretText.focus();
  secretText.select();
}

function wipeCreatedSecret(): void {
  secretText.value = "";
  secretDialog.hidden = true;
}

function closeCreatedSecret(): void {
  wipeCreatedSecret();
  closeDialog(secretDialog);
}

function recordViewStatus(record: PublicKeyRecord): ViewStatus {
  if (record.status === "revoked") return "revoked";
  if (record.expiresAt !== null && Date.now() >= record.expiresAt) return "expired";
  return record.enabled ? "active" : "disabled";
}

function statusLabel(status: ViewStatus): string {
  return t(status);
}

function maskedKey(record: PublicKeyRecord): string {
  return `bk1.${record.keyId.slice(0, 6)}…${record.keyId.slice(-4)}.••••••••`;
}

function expirySecondary(record: PublicKeyRecord): string {
  if (record.expiresAt === null) return t("createdOn", { date: formatDate(record.createdAt) });
  const days = Math.ceil((record.expiresAt - Date.now()) / 86_400_000);
  return t(days < 0 ? "expiredPast" : "expiresFuture", { when: formatRelativeDays(days) });
}

function createCell(row: HTMLTableRowElement, column: string): HTMLTableCellElement {
  const cell = document.createElement("td");
  cell.dataset.column = column;
  row.append(cell);
  return cell;
}

function iconButton(label: string, dataName: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "row-icon-button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.dataset[dataName] = "";
  return button;
}

function copyIcon(): HTMLElement {
  const icon = document.createElement("span");
  icon.className = "copy-icon";
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function revealIcon(): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(namespace, "svg");
  icon.classList.add("reveal-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.8");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  const outline = document.createElementNS(namespace, "path");
  outline.setAttribute("d", "M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z");
  const pupil = document.createElementNS(namespace, "circle");
  pupil.setAttribute("cx", "12");
  pupil.setAttribute("cy", "12");
  pupil.setAttribute("r", "2.75");
  icon.append(outline, pupil);
  return icon;
}

async function revealOrHide(record: PublicKeyRecord): Promise<void> {
  if (revealedKeys.has(record.keyId)) {
    revealedKeys.delete(record.keyId);
    renderRows();
    return;
  }
  const result = await client.request("keys.reveal", { keyId: record.keyId });
  if (result.keyId !== record.keyId || !API_KEY_PATTERN.test(result.apiKey)) throw new Error("扩展后台返回了无效的 Key");
  revealedKeys.set(record.keyId, result.apiKey);
  renderRows();
}

async function copyKey(record: PublicKeyRecord): Promise<void> {
  let apiKey = revealedKeys.get(record.keyId) ?? null;
  if (apiKey === null) {
    const result = await client.request("keys.reveal", { keyId: record.keyId });
    if (result.keyId !== record.keyId || !API_KEY_PATTERN.test(result.apiKey)) throw new Error("扩展后台返回了无效的 Key");
    apiKey = result.apiKey;
  }
  await navigator.clipboard.writeText(apiKey);
  setStatus(() => t("copied", { name: record.displayName }));
}

function openEditDialog(record: PublicKeyRecord): void {
  editingKeyId = record.keyId;
  editIdentity.textContent = `${record.displayName} · ${record.keyId}`;
  editNameInput.value = record.displayName;
  editExpiryInput.value = expiryToInput(record.expiresAt);
  editEnabledInput.checked = record.enabled;
  editPermissionFieldset.hidden = record.keyKind === "root";
  editPermissions.setSelection(record.keyKind === "root" ? CURRENT_PERMISSION_IDS : record.permissions);
  showDialog(editDialog);
  editNameInput.focus();
  editNameInput.select();
}

function openAttachDialog(record: PublicKeyRecord): void {
  attachingKeyId = record.keyId;
  attachIdentity.textContent = `${record.displayName} · ${record.keyId}`;
  attachSecretInput.value = "";
  showDialog(attachDialog);
  attachSecretInput.focus();
}

function openRevokeDialog(record: PublicKeyRecord): void {
  revokingKeyId = record.keyId;
  revokeSummary.textContent = `${record.displayName} · ${record.keyId}`;
  showDialog(revokeDialog);
}

function renderKey(record: PublicKeyRecord): void {
  const row = document.createElement("tr");
  row.dataset.keyId = record.keyId;
  row.dataset.keyName = record.displayName;

  const nameCell = createCell(row, "name");
  const name = document.createElement("span");
  name.className = "key-name";
  name.textContent = record.displayName;
  const keyId = document.createElement("code");
  keyId.className = "key-id";
  keyId.textContent = record.keyId;
  nameCell.append(name, keyId);

  const keyCell = createCell(row, "key");
  const tokenControl = document.createElement("div");
  tokenControl.className = "token-control";
  const revealed = revealedKeys.get(record.keyId) ?? null;
  tokenControl.dataset.revealed = String(revealed !== null);
  const tokenValue = document.createElement("code");
  tokenValue.className = "token-value";
  tokenValue.dataset.keyToken = "";
  tokenValue.textContent = revealed ?? maskedKey(record);
  tokenControl.append(tokenValue);
  if (record.secretAvailable) {
    const revealButton = iconButton(t(revealed === null ? "showKey" : "hideKey"), "keyReveal");
    revealButton.append(revealIcon());
    revealButton.addEventListener("click", () => {
      revealButton.disabled = true;
      void revealOrHide(record).catch((error: unknown) => {
        revealButton.disabled = false;
        setStatus(() => errorMessage(error), "error");
      });
    });
    const copyButton = iconButton(t("copy"), "keyCopy");
    copyButton.append(copyIcon());
    copyButton.addEventListener("click", () => {
      copyButton.disabled = true;
      void copyKey(record).catch((error: unknown) => {
        setStatus(() => t("copyFailed", { error: errorMessage(error) }), "error");
      }).finally(() => {
        copyButton.disabled = false;
      });
    });
    tokenControl.append(revealButton, copyButton);
  }
  keyCell.append(tokenControl);
  if (!record.secretAvailable) {
    if (record.status === "active") {
      const attachButton = document.createElement("button");
      attachButton.type = "button";
      attachButton.className = "row-icon-button legacy-action";
      attachButton.dataset.keyAttach = "";
      attachButton.textContent = t("attachExisting");
      attachButton.addEventListener("click", () => openAttachDialog(record));
      keyCell.append(attachButton);
    } else {
      const unavailable = document.createElement("span");
      unavailable.className = "permission-summary";
      unavailable.textContent = t("noCompleteKey");
      keyCell.append(unavailable);
    }
  }

  const typeCell = createCell(row, "type");
  const type = document.createElement("span");
  type.className = "type-label";
  type.textContent = record.keyKind === "root" ? "Root" : "Regular";
  const permissionSummary = document.createElement("span");
  permissionSummary.className = "permission-summary";
  permissionSummary.textContent = record.keyKind === "root" ? t("allPermissions") :
    t("permissionCount", { count: formatNumber(record.permissions.length) });
  typeCell.append(type, permissionSummary);

  const stateCell = createCell(row, "status");
  const state = recordViewStatus(record);
  const badge = document.createElement("span");
  badge.className = `badge badge-${state}`;
  badge.dataset.keyState = state;
  badge.textContent = statusLabel(state);
  stateCell.append(badge);
  if (!record.secretAvailable && record.status === "active") {
    stateCell.append(document.createElement("br"));
    const legacyBadge = document.createElement("span");
    legacyBadge.className = "badge badge-legacy";
    legacyBadge.textContent = t("legacy");
    stateCell.append(legacyBadge);
  }

  const expiryCell = createCell(row, "expiry");
  const expiryPrimary = document.createElement("span");
  expiryPrimary.className = "expiry-primary";
  expiryPrimary.textContent = record.expiresAt === null ? t("never") : formatDate(record.expiresAt);
  const expiryMeta = document.createElement("span");
  expiryMeta.className = "expiry-secondary";
  expiryMeta.textContent = expirySecondary(record);
  expiryCell.append(expiryPrimary, expiryMeta);

  const actionsCell = createCell(row, "actions");
  const actions = document.createElement("div");
  actions.className = "row-actions";
  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "button button-quiet edit-button";
  editButton.dataset.keyEdit = "";
  editButton.textContent = record.status === "revoked" ? t("revoked") : t("editTitle");
  editButton.disabled = record.status === "revoked";
  editButton.addEventListener("click", () => openEditDialog(record));
  actions.append(editButton);
  actionsCell.append(actions);
  keyTableBody.append(row);
}

function filterMatches(record: PublicKeyRecord): boolean {
  const query = searchInput.value.trim().toLocaleLowerCase();
  if (query !== "" && !record.displayName.toLocaleLowerCase().includes(query) && !record.keyId.toLocaleLowerCase().includes(query)) {
    return false;
  }
  const filter = statusFilter.value;
  if (filter === "all") return true;
  if (filter === "legacy") return !record.secretAvailable;
  return recordViewStatus(record) === filter;
}

function sortedRecords(): readonly PublicKeyRecord[] {
  return [...records.values()].sort((left, right) => right.createdAt - left.createdAt);
}

function renderRows(): void {
  keyTableBody.replaceChildren();
  const visible = sortedRecords().filter(filterMatches);
  for (const record of visible) renderKey(record);
  keyCountNode.textContent = String(records.size);
  const isEmpty = visible.length === 0;
  keyTable.hidden = isEmpty;
  emptyState.hidden = !isEmpty;
  emptyCreateButton.hidden = records.size !== 0;
  if (records.size === 0) {
    emptyTitle.textContent = t("noKeys");
  } else if (isEmpty) {
    emptyTitle.textContent = t("noMatches");
  }
}

function setLoadedStatus(): void {
  if (pendingCreateParams !== null) {
    setStatus(() => t("pendingCreate"), "error", true);
  }
}

async function loadKeyPage(reset: boolean): Promise<void> {
  if (reset) {
    nextAfterKeyId = null;
    records.clear();
    keyTableBody.dataset.loaded = "false";
  }
  const result = await client.request("keys.list", { afterKeyId: nextAfterKeyId, limit: 100 });
  for (const record of result.items) records.set(record.keyId, record);
  nextAfterKeyId = result.nextAfterKeyId;
  loadMoreButton.hidden = nextAfterKeyId === null;
  renderRows();
  keyTableBody.dataset.loaded = "true";
  setLoadedStatus();
}

async function refreshKeys(): Promise<void> {
  refreshButton.disabled = true;
  loadMoreButton.disabled = true;
  try {
    await loadKeyPage(true);
  } catch (error) {
    setStatus(() => errorMessage(error), "error", true);
  } finally {
    refreshButton.disabled = false;
    loadMoreButton.disabled = false;
  }
}

function clearSensitiveDom(): void {
  revealedKeys.clear();
  secretText.value = "";
  secretDialog.hidden = true;
  attachSecretInput.value = "";
  closeDialog(secretDialog);
  closeDialog(attachDialog);
  for (const token of document.querySelectorAll<HTMLElement>("[data-key-token]")) token.textContent = "";
}

keyKindSelect.addEventListener("change", () => setCreateKindState(keyKindSelect.value === "root" ? "root" : "regular"));
openCreateButton.addEventListener("click", openCreateDialog);
emptyCreateButton.addEventListener("click", openCreateDialog);
requiredElement<HTMLButtonElement>("[data-close-create]").addEventListener("click", () => closeDialog(createDialog));
requiredElement<HTMLButtonElement>("[data-cancel-create]").addEventListener("click", () => closeDialog(createDialog));

createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  createButton.disabled = true;
  let submitted: CreateKeyParams;
  try {
    const candidate = createParamsFromForm(pendingCreateParams?.mutationId ?? createMutationId());
    if (pendingCreateParams !== null && !sameCreateIntent(pendingCreateParams, candidate)) {
      restoreCreateForm(pendingCreateParams);
      throw new Error("mutationConflict");
    }
    submitted = pendingCreateParams ?? candidate;
    if (pendingCreateParams === null) persistPendingCreate(submitted);
  } catch (error) {
    createButton.disabled = false;
    setStatus(() => errorMessage(error), "error", true);
    return;
  }

  void client.request("keys.create", submitted).then(async (result) => {
    clearPendingCreate();
    closeDialog(createDialog);
    showCreatedSecret(result);
    resetCreateForm();
    await refreshKeys();
  }).catch(async (error: unknown) => {
    if (error instanceof AdminClientError && error.adminError.code === "SECRET_NOT_RECOVERABLE") {
      clearPendingCreate();
      await refreshKeys();
      setStatus(() => t("secretUnrecoverable"), "error", true);
      return;
    }
    if (!isUnknownMutationOutcome(error)) clearPendingCreate();
    setStatus(() => errorMessage(error), "error", true);
  }).finally(() => {
    createButton.disabled = false;
  });
});

copySecretButton.addEventListener("click", () => {
  void navigator.clipboard.writeText(secretText.value).then(() => {
    setStatus(() => t("copied", { name: "API Key" }));
  }).catch((error: unknown) => {
    setStatus(() => t("copyFailed", { error: errorMessage(error) }), "error");
  });
});
requiredElement<HTMLButtonElement>("[data-clear-secret]").addEventListener("click", closeCreatedSecret);
requiredElement<HTMLButtonElement>("[data-done-secret]").addEventListener("click", closeCreatedSecret);
secretDialog.addEventListener("close", wipeCreatedSecret);

editForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const record = editingKeyId === null ? undefined : records.get(editingKeyId);
  if (record === undefined) {
    setStatus(() => t("keyNotFound"), "error");
    return;
  }
  saveEditButton.disabled = true;
  let expiresAt: number | null;
  try {
    expiresAt = expiryFromInput(editExpiryInput);
  } catch (error) {
    saveEditButton.disabled = false;
    setStatus(() => errorMessage(error), "error");
    return;
  }
  void client.request("keys.update", {
    mutationId: createMutationId(),
    keyId: record.keyId,
    expectedRevision: record.recordRevision,
    patch: {
      displayName: editNameInput.value,
      permissions: record.keyKind === "root" ? [] : editPermissions.selectedPermissions(),
      expiresAt,
      enabled: editEnabledInput.checked,
    },
  }).then(async () => {
    closeDialog(editDialog);
    editingKeyId = null;
    await refreshKeys();
  }).catch((error: unknown) => {
    setStatus(() => errorMessage(error), "error", true);
  }).finally(() => {
    saveEditButton.disabled = false;
  });
});

requiredElement<HTMLButtonElement>("[data-close-edit]").addEventListener("click", () => closeDialog(editDialog));
requiredElement<HTMLButtonElement>("[data-cancel-edit]").addEventListener("click", () => closeDialog(editDialog));
openRevokeButton.addEventListener("click", () => {
  const record = editingKeyId === null ? undefined : records.get(editingKeyId);
  if (record === undefined) return;
  closeDialog(editDialog);
  openRevokeDialog(record);
});

attachForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const record = attachingKeyId === null ? undefined : records.get(attachingKeyId);
  if (record === undefined) {
    setStatus(() => t("keyNotFound"), "error");
    return;
  }
  const apiKey = attachSecretInput.value;
  attachSecretInput.value = "";
  attachSubmitButton.disabled = true;
  void client.request("keys.attachSecret", {
    mutationId: createMutationId(),
    keyId: record.keyId,
    apiKey,
  }).then(async () => {
    closeDialog(attachDialog);
    attachingKeyId = null;
    await refreshKeys();
  }).catch((error: unknown) => {
    setStatus(() => errorMessage(error), "error", true);
    attachSecretInput.focus();
  }).finally(() => {
    attachSubmitButton.disabled = false;
  });
});

requiredElement<HTMLButtonElement>("[data-close-attach]").addEventListener("click", () => closeDialog(attachDialog));
requiredElement<HTMLButtonElement>("[data-cancel-attach]").addEventListener("click", () => closeDialog(attachDialog));
attachDialog.addEventListener("close", () => { attachSecretInput.value = ""; });

confirmRevokeButton.addEventListener("click", () => {
  const record = revokingKeyId === null ? undefined : records.get(revokingKeyId);
  if (record === undefined) {
    setStatus(() => t("keyNotFound"), "error");
    return;
  }
  confirmRevokeButton.disabled = true;
  void client.request("keys.revoke", {
    mutationId: createMutationId(),
    keyId: record.keyId,
    expectedRevision: record.recordRevision,
  }).then(async () => {
    revealedKeys.delete(record.keyId);
    closeDialog(revokeDialog);
    revokingKeyId = null;
    await refreshKeys();
  }).catch((error: unknown) => {
    setStatus(() => errorMessage(error), "error", true);
  }).finally(() => {
    confirmRevokeButton.disabled = false;
  });
});

requiredElement<HTMLButtonElement>("[data-cancel-revoke]").addEventListener("click", () => closeDialog(revokeDialog));
searchInput.addEventListener("input", renderRows);
statusFilter.addEventListener("change", renderRows);
refreshButton.addEventListener("click", () => void refreshKeys());
loadMoreButton.addEventListener("click", () => {
  loadMoreButton.disabled = true;
  void loadKeyPage(false).catch((error: unknown) => {
    setStatus(() => errorMessage(error), "error", true);
  }).finally(() => {
    loadMoreButton.disabled = false;
  });
});
window.addEventListener("pagehide", clearSensitiveDom);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) renderRows();
});

onLocaleChanged(() => {
  setConnectionState(connectionNode.dataset.state === "disconnected" ? "disconnected" : "connected");
  renderRows();
  if (statusText !== null) statusNode.textContent = statusText();
});
setCreateKindState("regular");
if (pendingCreateParams !== null) restoreCreateForm(pendingCreateParams);
void refreshKeys();
