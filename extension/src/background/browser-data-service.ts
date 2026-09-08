import { COMMAND_CATALOG } from "../generated/command-config.js";
import { createTextArtifact } from "./artifact-service.js";
import { BrowserOperationError, exact, featureLimit, integer, object, text } from "./browser-feature-model.js";
import type { DebuggerDispatch } from "./debugger-service.js";

const bound = (name: string): number => featureLimit(`command.browserData.${name}`);
const string = (value: unknown, empty = false): value is string => text(value, bound("maximum_text_bytes"), empty);
const nullableId = (value: unknown): boolean => value === null || string(value);
const nullableInteger = (value: unknown): boolean => value === null || integer(value);
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const nullableTime = (value: unknown): boolean => value === null || timestamp(value);
function url(value: unknown): value is string {
  if (!string(value) || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try { new URL(value); return true; } catch { return false; }
}
function page(params: Record<string, unknown>): boolean {
  return integer(params.offset) && integer(params.limit, 1, bound("maximum_page_size"));
}
export function parseBrowserDataParams(method: string, params: Record<string, unknown>): boolean {
  switch (method) {
    case "bookmarks.get": return exact(params, ["bookmarkId"]) && string(params.bookmarkId);
    case "bookmarks.list": return exact(params, ["parentId", "offset", "limit"]) && nullableId(params.parentId) && page(params);
    case "bookmarks.search": return exact(params, ["query", "offset", "limit"]) && string(params.query, true) && page(params);
    case "bookmarks.create": return exact(params, ["parentId", "index", "title", "url"]) && nullableId(params.parentId) &&
      nullableInteger(params.index) && string(params.title, true) && (params.url === null || url(params.url));
    case "bookmarks.update": return exact(params, ["bookmarkId", "changes"]) && string(params.bookmarkId) && object(params.changes) &&
      Object.keys(params.changes).length > 0 && Object.keys(params.changes).every(key => key === "title" || key === "url") &&
      (!Object.hasOwn(params.changes, "title") || string(params.changes.title, true)) && (!Object.hasOwn(params.changes, "url") || url(params.changes.url));
    case "bookmarks.move": return exact(params, ["bookmarkId", "parentId", "index"]) && string(params.bookmarkId) &&
      nullableId(params.parentId) && nullableInteger(params.index) && (params.parentId !== null || params.index !== null);
    case "bookmarks.delete": return exact(params, ["bookmarkId", "recursive"]) && string(params.bookmarkId) && typeof params.recursive === "boolean";
    case "history.search": return exact(params, ["text", "startTime", "endTime", "maxResults"]) && string(params.text, true) &&
      nullableTime(params.startTime) && nullableTime(params.endTime) &&
      (params.startTime === null || params.endTime === null || Number(params.startTime) <= Number(params.endTime)) &&
      integer(params.maxResults, 1, bound("maximum_history_results"));
    case "history.visits": return exact(params, ["url", "offset", "limit"]) && url(params.url) && page(params);
    case "history.add": case "history.deleteUrl": return exact(params, ["url"]) && url(params.url);
    case "history.deleteRange": return exact(params, ["startTime", "endTime"]) && timestamp(params.startTime) &&
      timestamp(params.endTime) && params.startTime <= params.endTime;
    case "history.deleteAll": return exact(params, []);
    default: return false;
  }
}

function bookmark(node: ChromeBookmarkNode) {
  // Descendants are read through list, never copied or traversed as part of one node.
  return { bookmarkId: node.id, title: node.title, parentId: node.parentId ?? null, index: node.index ?? null,
    url: node.url ?? null, kind: node.url === undefined ? "folder" : "bookmark", dateAdded: node.dateAdded ?? null,
    dateGroupModified: node.dateGroupModified ?? null, dateLastUsed: node.dateLastUsed ?? null,
    folderType: node.folderType ?? null, syncing: node.syncing, unmodifiable: node.unmodifiable ?? null };
}
function historyItem(item: ChromeHistoryItem) {
  return { historyId: item.id, url: item.url ?? null, title: item.title ?? null, lastVisitTime: item.lastVisitTime ?? null,
    visitCount: item.visitCount ?? null, typedCount: item.typedCount ?? null };
}
function visit(item: ChromeHistoryVisit) {
  return { historyId: item.id, visitId: item.visitId, referringVisitId: item.referringVisitId, transition: item.transition,
    isLocal: item.isLocal, visitTime: item.visitTime ?? null };
}
function livePage<T>(items: readonly T[], params: Record<string, unknown>) {
  const offset = params.offset as number, selected = items.slice(offset, offset + (params.limit as number));
  return { items: selected, total: items.length, offset, nextOffset: offset + selected.length < items.length ? offset + selected.length : null,
    observedAt: Date.now(), view: "live" as const };
}
async function present(keyId: string, field: "items" | "bookmark", result: Record<string, unknown>): Promise<unknown> {
  const complete = { ...result, artifact: null }, body = JSON.stringify(complete);
  if (new TextEncoder().encode(body).byteLength <= COMMAND_CATALOG.limits["command.inline.maximum_result_json_bytes"] / 2) return complete;
  const artifact = await createTextArtifact(keyId, "application/json", body);
  return { ...result, [field]: null, artifact };
}
async function read<T>(dispatch: DebuggerDispatch, operation: () => Promise<T>, reason: string): Promise<T> {
  return dispatch(async () => {
    try { return await operation(); } catch { throw new BrowserOperationError(reason); }
  });
}

export async function runBookmarks(keyId: string, method: string, params: Record<string, unknown>, dispatch: DebuggerDispatch): Promise<unknown> {
  const api = chrome.bookmarks;
  if (!api) throw new BrowserOperationError("BOOKMARKS_API_UNAVAILABLE");
  if (method === "bookmarks.get") {
    const nodes = await read(dispatch, () => api.get(params.bookmarkId as string), "BOOKMARK_READ_FAILED");
    const node = nodes.find(item => item.id === params.bookmarkId);
    if (!node) throw new BrowserOperationError("BOOKMARK_NOT_FOUND");
    return present(keyId, "bookmark", { bookmark: bookmark(node) });
  }
  if (method === "bookmarks.list" || method === "bookmarks.search") {
    const nodes = await read(dispatch, () => method === "bookmarks.search" ? api.search(params.query as string) :
      params.parentId === null ? api.getTree() : api.getChildren(params.parentId as string), "BOOKMARK_READ_FAILED");
    if (method === "bookmarks.search") nodes.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const result = livePage(nodes, params);
    return present(keyId, "items", { ...result, items: result.items.map(bookmark) });
  }
  if (!["bookmarks.create", "bookmarks.update", "bookmarks.move", "bookmarks.delete"].includes(method)) throw new BrowserOperationError("UNKNOWN_BOOKMARK_COMMAND");
  let launched = false, apiCompleted = false, bookmarkId = typeof params.bookmarkId === "string" ? params.bookmarkId : null;
  try {
    const node = await dispatch(async () => {
      launched = true;
      let result: ChromeBookmarkNode | null = null;
      if (method === "bookmarks.create") result = await api.create({ title: params.title as string,
        ...(params.parentId === null ? {} : { parentId: params.parentId as string }),
        ...(params.index === null ? {} : { index: params.index as number }), ...(params.url === null ? {} : { url: params.url as string }) });
      else if (method === "bookmarks.update") result = await api.update(bookmarkId!, params.changes as {title?: string; url?: string});
      else if (method === "bookmarks.move") result = await api.move(bookmarkId!, {
        ...(params.parentId === null ? {} : { parentId: params.parentId as string }), ...(params.index === null ? {} : { index: params.index as number }) });
      else if (params.recursive === true) await api.removeTree(bookmarkId!);
      else await api.remove(bookmarkId!);
      apiCompleted = true;
      if (result) bookmarkId = result.id;
      return result;
    });
    if (node) return await present(keyId, "bookmark", { bookmark: bookmark(node) });
    return { bookmarkId, recursive: params.recursive, apiCompleted };
  } catch (error) {
    if (!launched) throw error;
    throw new BrowserOperationError(apiCompleted ? "BOOKMARK_RESULT_EXPORT_FAILED" : "BOOKMARK_OPERATION_FAILED", true,
      { operation: method, bookmarkId, apiCompleted });
  }
}

export async function runHistory(keyId: string, method: string, params: Record<string, unknown>, dispatch: DebuggerDispatch): Promise<unknown> {
  const api = chrome.history;
  if (!api) throw new BrowserOperationError("HISTORY_API_UNAVAILABLE");
  if (method === "history.search") {
    const observedAt = Date.now(), endTime = params.endTime === null ? observedAt : params.endTime as number;
    const startTime = params.startTime === null ? Math.max(0, endTime - 86400000) : params.startTime as number;
    if (startTime > endTime) throw new BrowserOperationError("HISTORY_TIME_RANGE_INVALID");
    const maxResults = params.maxResults as number;
    const items = await read(dispatch, () => api.search({ text: params.text as string, startTime, endTime, maxResults }), "HISTORY_READ_FAILED");
    return present(keyId, "items", { items: items.map(historyItem), startTime, endTime, maxResults, atLimit: items.length >= maxResults,
      observedAt, recordKind: "page_last_visit", view: "live" });
  }
  if (method === "history.visits") {
    const items = await read(dispatch, () => api.getVisits({ url: params.url as string }), "HISTORY_READ_FAILED");
    // Native order is unspecified. Explicit visit identity breaks equal-time ties within this read.
    items.sort((a, b) => (b.visitTime ?? 0) - (a.visitTime ?? 0) || (a.visitId < b.visitId ? -1 : a.visitId > b.visitId ? 1 : 0));
    const result = livePage(items, params);
    return present(keyId, "items", { ...result, items: result.items.map(visit), url: params.url, recordKind: "visit" });
  }
  if (!["history.add", "history.deleteUrl", "history.deleteRange", "history.deleteAll"].includes(method)) throw new BrowserOperationError("UNKNOWN_HISTORY_COMMAND");
  let launched = false;
  try {
    await dispatch(async () => {
      launched = true;
      if (method === "history.add") await api.addUrl({ url: params.url as string });
      else if (method === "history.deleteUrl") await api.deleteUrl({ url: params.url as string });
      else if (method === "history.deleteRange") await api.deleteRange({ startTime: params.startTime as number, endTime: params.endTime as number });
      else await api.deleteAll();
    });
    return { operation: method, apiCompleted: true, observedAt: Date.now() };
  } catch (error) {
    if (!launched) throw error;
    throw new BrowserOperationError("HISTORY_OPERATION_FAILED", true, { operation: method, apiCompleted: false });
  }
}
