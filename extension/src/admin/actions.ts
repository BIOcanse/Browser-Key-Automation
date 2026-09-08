import { AdminPortClient, AdminClientError, AdminRequestUncertainError } from "./port-client.js";
import { t, onLocaleChanged, type UiMessageKey } from "../ui/page-ui.js";
import { COMMAND_CATALOG } from "../generated/command-config.js";
import type { AdminCommandResult, PublicKeyRecord } from "../shared/admin-protocol.js";

type Data = Record<string, unknown>;
interface KeyContext { readonly keyId: string; readonly generation: number }
interface ActionRow { actionId: number; name: string; description: string; revision: number; stepCount: number; byteLength: number }
interface RecordingRow { recordingId: string; mode: string; state: string; scope: string; eventCount: number; lostEvents: number; reason: string | null; expiresAt: number;
  baseline: { viewport: { tabRef: string } } }
const element = <T extends Element>(selector: string): T => {
  const value = document.querySelector<T>(selector);
  if (value === null) throw new Error(`Missing required element: ${selector}`);
  return value;
};
const input = (name: string) => element<HTMLInputElement>(`[data-${name}]`);
const data = (value: unknown): value is Data => typeof value === "object" && value !== null && !Array.isArray(value);
const encode = (value: unknown) => JSON.stringify(value, null, 2);
const keySelect = element<HTMLSelectElement>("[data-action-key]");
const tabSelect = element<HTMLSelectElement>("[data-record-tab]");
const source = element<HTMLTextAreaElement>("[data-action-source]");
const status = element<HTMLElement>("[data-action-status]");
const result = element<HTMLElement>("[data-action-result]");
const client = new AdminPortClient(state => { element("[data-connection]").textContent = t(state); });
const limits = COMMAND_CATALOG.limits;
const pageSize = limits["command.actions.maximum_page_size"];
const recordingPageSize = limits["command.recording.maximum_page_size"];
const keys = new Map<string, PublicKeyRecord>();
const actions = new Map<number, ActionRow>();
const recordings = new Map<string, RecordingRow>();
let generation = 0, busy = 0;
let nextKey: string | null = null, nextAction: number | null = null, nextRecording: string | null = null, nextTab: number | null = null;
let nextEvent: number | null = null;
let actionQuery = "";
let selectedAction: ActionRow | null = null, selectedRecording: RecordingRow | null = null;
let compiledInstructions: readonly unknown[] | null = null;

class CommandError extends Error {
  constructor(readonly response: Extract<AdminCommandResult, { ok: false }>) { super(response.error.code); }
}
class ChangedContext extends Error {}
function current(context: KeyContext): boolean { return context.generation === generation && context.keyId === keySelect.value; }
function assertCurrent(context: KeyContext): void { if (!current(context)) throw new ChangedContext(); }
function message(key: UiMessageKey, kind = "info"): void { status.textContent = t(key); status.dataset.kind = kind; }
function updateControls(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("main button")) button.disabled = busy > 0 || !keySelect.value;
  for (const field of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("main form input, main form select, main form textarea")) field.disabled = busy > 0 || !keySelect.value;
  for (const name of ["keys-refresh", "keys-more"]) element<HTMLButtonElement>(`[data-${name}]`).disabled = busy > 0;
  for (const name of ["action-run", "action-delete"]) element<HTMLButtonElement>(`[data-${name}]`).disabled ||= selectedAction === null;
  element<HTMLButtonElement>("[data-action-use-preview]").disabled ||= compiledInstructions === null;
  element<HTMLButtonElement>("[data-record-pause]").disabled ||= selectedRecording?.state !== "recording";
  element<HTMLButtonElement>("[data-record-resume]").disabled ||= selectedRecording?.state !== "paused";
  element<HTMLButtonElement>("[data-record-stop]").disabled ||= !selectedRecording || ["stopped", "interrupted"].includes(selectedRecording.state);
  element<HTMLButtonElement>("[data-record-delete]").disabled ||= !selectedRecording || !["stopped", "interrupted"].includes(selectedRecording.state);
  element<HTMLButtonElement>("[data-record-start]").disabled ||= !tabSelect.value;
}
async function perform(task: (context: KeyContext) => Promise<void>, needsKey = true): Promise<void> {
  const context = { keyId: keySelect.value, generation };
  if (needsKey && !context.keyId) { message("chooseKey", "error"); return; }
  ++busy; updateControls(); message("operationPending");
  try { await task(context); if (current(context)) status.textContent = ""; }
  catch (error) {
    if (!current(context) || error instanceof ChangedContext) return;
    status.dataset.kind = "error";
    if (error instanceof AdminClientError && error.adminError.code === "KEY_NOT_FOUND") {
      keys.delete(context.keyId); keySelect.value = ""; clearKeyContent(); renderKeys(); message("chooseKey", "error");
    }
    else if (error instanceof AdminRequestUncertainError) message("operationUnknown", "error");
    else if (error instanceof CommandError) status.textContent = `${error.response.error.code}: ${encode(error.response.error.details ?? {})}`;
    else if (error instanceof AdminClientError) status.textContent = `${error.adminError.code}: ${error.adminError.message}`;
    else if (error instanceof SyntaxError) message("invalidJson", "error");
    else status.textContent = error instanceof Error ? error.message : t("unknownError");
  } finally { --busy; updateControls(); }
}
async function command<T>(context: KeyContext, method: string, params: Data = {}, show = false): Promise<T> {
  assertCurrent(context);
  const timeout = method === "actions.run" && typeof params.timeoutMs === "number" ? params.timeoutMs + 10_000 : 10_000;
  const response = await client.request("commands.execute", { keyId: context.keyId, command: { method, schemaVersion: 1, params } }, timeout);
  assertCurrent(context);
  if (show) {
    result.textContent = encode({ method, ...response });
    if (response.trace.traceRef !== null) input("trace-ref").value = response.trace.traceRef;
  }
  if (!response.ok) throw new CommandError(response);
  return response.result as T;
}
function click(name: string, task: (context: KeyContext) => Promise<void>, needsKey = true): void {
  element(`[data-${name}]`).addEventListener("click", () => { void perform(task, needsKey); });
}
function more(name: string, available: unknown): void { element<HTMLElement>(`[data-${name}]`).hidden = available === null; }
function resetEditor(): void {
  selectedAction = null; compiledInstructions = null;
  input("action-name").value = ""; input("action-description").value = "";
  source.value = "[]"; element("[data-action-identity]").textContent = ""; result.textContent = "";
  updateControls();
}
function clearKeyContent(): void {
  status.textContent = "";
  ++generation; actions.clear(); recordings.clear(); selectedRecording = null;
  nextAction = null; nextRecording = null; nextEvent = null; nextTab = null;
  actionQuery = "";
  resetEditor(); renderActions(); renderRecordings();
  tabSelect.replaceChildren(); input("trace-ref").value = "";
  for (const name of ["trace-events", "trace-output", "record-events-output"]) element(`[data-${name}]`).replaceChildren();
  element<HTMLElement>("[data-record-details]").hidden = true;
  for (const name of ["action-more", "recordings-more", "events-more", "tabs-more"]) more(name, null);
}
function renderKeys(): void {
  const selected = keySelect.value;
  keySelect.replaceChildren(new Option(t("chooseKey"), ""));
  for (const key of keys.values()) {
    const option = new Option(`${key.displayName} · ${key.keyId}`, key.keyId);
    option.disabled = !key.secretAvailable || !key.enabled || key.status !== "active" || key.expiresAt !== null && key.expiresAt <= Date.now();
    keySelect.add(option);
  }
  keySelect.value = [...keySelect.options].some(option => option.value === selected && !option.disabled) ? selected : "";
}
async function loadKeys(after: string | null): Promise<void> {
  const response = await client.request("keys.list", { afterKeyId: after, limit: 100 });
  if (after === null) keys.clear();
  for (const key of response.items) keys.set(key.keyId, key);
  const before = keySelect.value;
  renderKeys(); nextKey = response.nextAfterKeyId; more("keys-more", nextKey);
  if (keySelect.value !== before) clearKeyContent();
}
function listButton(primary: string, secondary: string, active: boolean, task: (context: KeyContext) => Promise<void>): HTMLLIElement {
  const li = document.createElement("li"), button = document.createElement("button"), title = document.createElement("strong"), subtitle = document.createElement("small");
  button.type = "button"; button.setAttribute("aria-current", String(active)); title.textContent = primary; subtitle.textContent = secondary;
  button.append(title, subtitle); button.addEventListener("click", () => { void perform(task); }); li.append(button); return li;
}
function renderActions(): void {
  element("[data-action-list]").replaceChildren(...[...actions.values()].map(row => listButton(`#${row.actionId} · ${row.name}`,
    `v${row.revision} · ${row.stepCount} · ${row.description}`, selectedAction?.actionId === row.actionId, context => loadAction(context, row.actionId))));
}
function renderRecordings(): void {
  element("[data-recording-list]").replaceChildren(...[...recordings.values()].map(row => listButton(row.recordingId,
    `${row.mode} · ${row.scope} · ${row.state} · ${row.eventCount}`, selectedRecording?.recordingId === row.recordingId, context => loadRecording(context, row.recordingId))));
}
async function listActions(context: KeyContext, after: number): Promise<void> {
  const query = after === 0 ? input("action-search").value : actionQuery;
  const page = await command<{ items: ActionRow[]; nextAfterActionId: number | null }>(context, "actions.list", { afterActionId: after, limit: pageSize, query });
  if (after === 0) { actions.clear(); actionQuery = query; }
  for (const row of page.items) actions.set(row.actionId, row);
  nextAction = page.nextAfterActionId; more("action-more", nextAction); renderActions();
}
async function listRecordings(context: KeyContext, after: string | null): Promise<void> {
  const page = await command<{ items: RecordingRow[]; nextAfterRecordingId: string | null }>(context, "recording.list", { afterRecordingId: after, limit: recordingPageSize });
  if (after === null) recordings.clear();
  for (const row of page.items) recordings.set(row.recordingId, row);
  nextRecording = page.nextAfterRecordingId; more("recordings-more", nextRecording); renderRecordings();
  if (after === null && selectedRecording !== null) await loadRecording(context, selectedRecording.recordingId);
}
async function listTabs(context: KeyContext, after: number | null): Promise<void> {
  const page = await command<{ items: { tabRef: string; title: string | null; url: string | null; windowId: number }[]; nextAfterTabId: number | null }>(context, "tabs.list", { afterTabId: after });
  const previous = tabSelect.value;
  if (after === null) tabSelect.replaceChildren(new Option(t("recordingTarget"), ""));
  for (const tab of page.items) tabSelect.add(new Option(`${tab.title ?? tab.url ?? tab.tabRef} · ${tab.windowId}`, tab.tabRef));
  if ([...tabSelect.options].some(option => option.value === previous)) tabSelect.value = previous;
  nextTab = page.nextAfterTabId; more("tabs-more", nextTab);
}

// Every page belongs to one immutable Artifact. No partial source is installed
// in the editor, and its digest is checked before a compiled array can be used.
async function readJsonArtifact(context: KeyContext, artifact: Data): Promise<unknown> {
  const total = artifact.byteLength;
  if (!Number.isSafeInteger(total) || typeof total !== "number" || total < 0 || total > limits["command.actions.maximum_bytes"]) throw new Error(t("incompleteSource"));
  const bytes = new Uint8Array(total); let offset = 0;
  do {
    const chunk = await command<Data>(context, "artifact.read", { artifactRef: artifact.artifactRef, offset });
    if (chunk.artifactRef !== artifact.artifactRef || chunk.sha256 !== artifact.sha256 || chunk.byteLength !== total || chunk.mediaType !== "application/json" || chunk.offset !== offset || typeof chunk.dataBase64Url !== "string") throw new Error(t("incompleteSource"));
    const decoded = Uint8Array.from(atob(chunk.dataBase64Url.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
    if (!decoded.length && total !== 0 || offset + decoded.length > total) throw new Error(t("incompleteSource"));
    bytes.set(decoded, offset); offset += decoded.length;
    if (chunk.nextOffset !== (offset === total ? null : offset)) throw new Error(t("incompleteSource"));
  } while (offset < total);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  assertCurrent(context);
  if ([...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("") !== artifact.sha256) throw new Error(t("incompleteSource"));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
async function loadAction(context: KeyContext, id: number): Promise<void> {
  let meta: ActionRow | null = null, instructions: unknown[] = [], offset: number | null = 0;
  try {
    while (offset !== null) {
      const page: ActionRow & { instructions: unknown[]; offset: number; nextOffset: number | null } = await command(context, "actions.get", { actionId: id, offset, limit: pageSize });
      if (meta && (page.revision !== meta.revision || page.stepCount !== meta.stepCount) || page.actionId !== id || page.offset !== instructions.length ||
        !Array.isArray(page.instructions) || instructions.length + page.instructions.length > limits["command.actions.maximum_steps"]) throw new Error(t("incompleteSource"));
      meta ??= page; instructions.push(...page.instructions);
      if (page.nextOffset !== null && (page.nextOffset !== instructions.length || page.nextOffset <= offset)) throw new Error(t("incompleteSource"));
      offset = page.nextOffset;
    }
  } catch (error) {
    if (!(error instanceof CommandError) || error.response.error.details?.reason !== "USE_ARTIFACT_EXPORT") throw error;
    const exported = await command<{ action: ActionRow; artifact: Data }>(context, "actions.export", { actionId: id });
    const body = await readJsonArtifact(context, exported.artifact);
    if (!Array.isArray(body)) throw new Error(t("incompleteSource"));
    meta = exported.action; instructions = body;
  }
  if (meta === null || instructions.length !== meta.stepCount || new TextEncoder().encode(JSON.stringify(instructions)).byteLength !== meta.byteLength) throw new Error(t("incompleteSource"));
  selectedAction = meta; compiledInstructions = null; input("action-name").value = meta.name; input("action-description").value = meta.description;
  source.value = encode(instructions); element("[data-action-identity]").textContent = `#${meta.actionId} · v${meta.revision}`;
  renderActions();
}
async function compile(context: KeyContext): Promise<void> {
  const compiled = await command<Data>(context, "actions.compile", { instructions: JSON.parse(source.value) }, true);
  compiledInstructions = null;
  if (compiled.runnable === true) {
    const body = compiled.complete === true ? compiled.instructions : data(compiled.artifact) ? await readJsonArtifact(context, compiled.artifact) : null;
    if (Array.isArray(body) && body.length === compiled.stepCount) compiledInstructions = body;
  }
}
async function save(context: KeyContext): Promise<void> {
  const edit = selectedAction;
  const saved = await command<{ action: ActionRow }>(context, edit ? "actions.update" : "actions.create", {
    ...(edit ? { actionId: edit.actionId, revision: edit.revision } : {}), name: input("action-name").value,
    description: input("action-description").value, instructions: JSON.parse(source.value),
  }, true);
  selectedAction = saved.action; actions.set(saved.action.actionId, saved.action);
  element("[data-action-identity]").textContent = `#${saved.action.actionId} · v${saved.action.revision}`; renderActions();
}
async function loadRecording(context: KeyContext, id: string): Promise<void> {
  let response: { recording: RecordingRow };
  try { response = await command(context, "recording.get", { recordingId: id }); }
  catch (error) {
    if (!(error instanceof CommandError) || error.response.error.code !== "RECORDING_OPERATION_FAILED" || error.response.error.details?.reason !== "NOT_FOUND") throw error;
    recordings.delete(id); selectedRecording = null; nextEvent = null;
    element<HTMLElement>("[data-record-details]").hidden = true;
    element("[data-record-identity]").textContent = ""; element("[data-record-summary]").textContent = "";
    element("[data-record-events-output]").textContent = ""; more("events-more", null); renderRecordings(); return;
  }
  selectedRecording = response.recording; recordings.set(id, response.recording);
  element<HTMLElement>("[data-record-details]").hidden = false;
  element("[data-record-identity]").textContent = id;
  element("[data-record-summary]").textContent = encode(response.recording);
  element("[data-record-events-output]").textContent = ""; nextEvent = null; more("events-more", null); renderRecordings();
}
async function readEvents(context: KeyContext, after: number): Promise<void> {
  if (!selectedRecording) return;
  const page = await command<Data>(context, "recording.read", { recordingId: selectedRecording.recordingId, afterSequence: after, limit: recordingPageSize });
  // Show the current page with its explicit cursor, instead of accumulating an
  // unbounded raw stream in the management page.
  element("[data-record-events-output]").textContent = encode(page);
  nextEvent = typeof page.nextAfterSequence === "number" ? page.nextAfterSequence : null; more("events-more", nextEvent);
}

click("keys-refresh", () => loadKeys(null), false); click("keys-more", () => loadKeys(nextKey), false);
click("action-new", async () => resetEditor()); click("action-more", context => listActions(context, nextAction ?? 0));
click("action-compile", compile); click("action-use-preview", async () => {
  if (compiledInstructions) { source.value = encode(compiledInstructions); compiledInstructions = null; }
});
click("action-run", async context => {
  if (selectedAction) await command(context, "actions.run", { actionId: selectedAction.actionId,
    inputs: JSON.parse(input("action-inputs").value), timeoutMs: Number(input("action-timeout").value) }, true);
});
click("action-delete", async context => {
  const action = selectedAction;
  if (!action || !window.confirm(`${t("confirmDelete")} #${action.actionId} · ${action.name}`)) return;
  await command(context, "actions.delete", { actionId: action.actionId, revision: action.revision }, true);
  actions.delete(action.actionId); resetEditor(); renderActions();
});
click("recordings-refresh", context => listRecordings(context, null)); click("recordings-more", context => listRecordings(context, nextRecording));
click("tabs-refresh", context => listTabs(context, null)); click("tabs-more", context => listTabs(context, nextTab));
for (const verb of ["pause", "resume", "stop", "delete"] as const) click(`record-${verb}`, async context => {
  const recording = selectedRecording;
  if (!recording || verb === "delete" && !window.confirm(`${t("confirmDelete")} ${recording.recordingId}`)) return;
  if(verb==="resume"&&recording.mode==="real")await prepareRealTarget(context,recording.baseline.viewport.tabRef);
  await command(context, `recording.${verb}`, { recordingId: recording.recordingId }, true);
  if (verb === "delete") { recordings.delete(recording.recordingId); selectedRecording = null; element<HTMLElement>("[data-record-details]").hidden = true; renderRecordings(); }
  else await loadRecording(context, recording.recordingId);
});
click("record-compile", async context => {
  if (!selectedRecording) return;
  const id = selectedRecording.recordingId;
  resetEditor(); source.value = encode({ recordingId: id, options: { timing: "preserve", mergeInputs: "none", includeHover: selectedRecording.mode === "real" } });
  await compile(context);
});
click("record-events", context => readEvents(context, 0)); click("events-more", context => readEvents(context, nextEvent ?? 0));
click("trace-read", async context => {
  const response = await command<{ trace: Data }>(context, "trace.read", { traceRef: input("trace-ref").value.trim() || null });
  element("[data-trace-output]").textContent = encode(response);
  element("[data-trace-events]").replaceChildren(...(Array.isArray(response.trace.events) ? response.trace.events : []).map(event => {
    const li = document.createElement("li");
    li.textContent = data(event) ? `${event.sequence} · ${event.elapsedMs} ms · ${event.actionId ?? "—"}/${event.stepIndex ?? "—"} · ${event.phase} / ${event.operation}: ${event.status}` : encode(event);
    return li;
  }));
});
element("[data-action-editor]").addEventListener("submit", event => { event.preventDefault(); void perform(save); });
element("[data-action-search-form]").addEventListener("submit", event => { event.preventDefault(); void perform(context => listActions(context, 0)); });
async function prepareRealTarget(context:KeyContext,tabRef:string):Promise<void> {
  const target=await command<{tab:{windowId:number}}>(context,"tabs.get",{tabRef});
  await command(context,"tabs.activate",{tabRef});
  await command(context,"windows.focus",{windowId:target.tab.windowId});
}
element("[data-record-form]").addEventListener("submit", event => {
  event.preventDefault();
  void perform(async context => {
    const mode=element<HTMLSelectElement>("[data-record-mode]").value;
    if(mode==="real")await prepareRealTarget(context,tabSelect.value);
    const response = await command<{ recording: RecordingRow }>(context, "recording.start", {
      tabRef: tabSelect.value, scope: element<HTMLSelectElement>("[data-record-scope]").value,
      mode, includeFrames: input("record-frames").checked,
      durationMs: Number(input("record-duration").value), retentionMs: Number(input("record-retention").value),
    }, true);
    await loadRecording(context, response.recording.recordingId);
  });
});
source.addEventListener("input", () => { compiledInstructions = null; updateControls(); });
tabSelect.addEventListener("change", updateControls);
keySelect.addEventListener("change", () => { clearKeyContent(); status.textContent = ""; updateControls(); });
window.addEventListener("focus", () => { if (busy === 0) void perform(() => loadKeys(null), false); });
onLocaleChanged(() => { renderKeys(); renderActions(); renderRecordings(); updateControls(); });
input("action-timeout").value = String(COMMAND_CATALOG.parameterDefaultsByMethod["actions.run"].timeoutMs);
input("action-timeout").max = String(limits["command.actions.maximum_timeout_ms"]);
input("record-duration").value = String(COMMAND_CATALOG.parameterDefaultsByMethod["recording.start"].durationMs);
input("record-duration").max = String(limits["command.recording.maximum_duration_ms"]);
input("record-retention").value = String(COMMAND_CATALOG.parameterDefaultsByMethod["recording.start"].retentionMs);
input("record-retention").max = String(limits["command.recording.maximum_retention_ms"]);
void perform(() => loadKeys(null), false);
