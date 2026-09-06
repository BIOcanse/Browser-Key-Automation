import { COMMAND_CATALOG } from "../generated/command-config.js";
import { CapabilityUnavailableError, type CapabilityUnavailableReason } from "./capability-error.js";
import { isUserScriptsAvailable, USER_SCRIPTS_SETUP_REQUIRED } from "../shared/user-scripts.js";
import {
  assertResolvedTabTarget,
  resolveTabTarget,
  type ResolvedTabTarget,
} from "./tab-service.js";

export type JavaScriptWorld = "MAIN" | "USER_SCRIPT";
export type JavaScriptStatus = "fulfilled" | "rejected" | "serialization_error" | "timed_out";

export interface PageDomResult {
  readonly tabRef: string;
  readonly root: PageDomRoot;
  readonly url: string;
  readonly urlTruncated: boolean;
  readonly html: string;
  readonly htmlTruncated: boolean;
}

export type PageDomRoot = "body" | "document";

export interface PageTextResult {
  readonly tabRef: string;
  readonly url: string;
  readonly urlTruncated: boolean;
  readonly text: string;
  readonly textTruncated: boolean;
}

export interface FullPageDomResult {
  readonly tabRef: string;
  readonly root: PageDomRoot;
  readonly url: string;
  readonly html: string;
}

export interface PageResourceItem {
  readonly url: string;
  readonly source: "dom" | "performance";
}

export interface PageResourcesResult {
  readonly tabRef: string;
  readonly items: readonly PageResourceItem[];
  readonly truncated: boolean;
}

export interface JavaScriptResult {
  readonly tabRef: string;
  readonly world: JavaScriptWorld;
  readonly status: JavaScriptStatus;
  readonly valueJson: string | null;
  readonly valueTruncated: boolean;
  readonly errorName: string | null;
  readonly errorMessage: string | null;
}

interface PageSnapshot {
  readonly url: string;
  readonly urlTruncated: boolean;
  readonly html: string;
  readonly htmlTruncated: boolean;
}

type JavaScriptExecutionOutcome =
  | { readonly kind: "entries"; readonly entries: readonly ChromeUserScriptInjectionResult[] }
  | { readonly kind: "failure" }
  | { readonly kind: "timeout" };

export class BrowserCapabilityError extends CapabilityUnavailableError {
  constructor(
    message: string,
    reason: CapabilityUnavailableReason = "CHROMIUM_API_FAILED",
    capabilityId = "platform.extension.scripting",
  ) {
    super(capabilityId, reason, message);
    this.name = "BrowserCapabilityError";
  }
}

const encoder = new TextEncoder();

export async function assertScriptingTargetAvailable(
  target: ResolvedTabTarget,
  capabilityId = "platform.extension.scripting",
): Promise<void> {
  if (target.url === null) return;
  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    return;
  }
  const restrictedProtocols = new Set([
    "chrome:",
    "chrome-extension:",
    "chrome-search:",
    "devtools:",
    "edge:",
    "view-source:",
  ]);
  const restrictedWebStore =
    url.protocol === "https:" &&
    (url.hostname === "chromewebstore.google.com" || url.hostname === "chrome.google.com") &&
    (url.hostname === "chromewebstore.google.com" || url.pathname.startsWith("/webstore"));
  if (restrictedProtocols.has(url.protocol) || restrictedWebStore) {
    throw new BrowserCapabilityError(
      "Chromium forbids extension script injection into this page",
      "RESTRICTED_PAGE",
      capabilityId,
    );
  }
  let originPattern: string | null = null;
  if (url.protocol === "http:" || url.protocol === "https:") {
    originPattern = `${url.protocol}//${url.hostname}/*`;
  } else if (url.protocol === "file:") {
    originPattern = "file:///*";
  }
  if (originPattern === null || chrome.permissions === undefined) return;
  let granted: boolean | null = null;
  try {
    granted = await chrome.permissions.contains({ origins: [originPattern] });
  } catch {
    return;
  }
  if (!granted) {
    throw new BrowserCapabilityError(
      "The extension does not currently have host access to this page",
      "HOST_ACCESS_UNAVAILABLE",
      capabilityId,
    );
  }
}

function boundedJsonText(value: string, maximumJsonBytes: number): { value: string; truncated: boolean } {
  const characters: string[] = [];
  let usedBytes = 0;
  for (const character of value) {
    const encodedCharacter = JSON.stringify(character).slice(1, -1);
    const characterBytes = encoder.encode(encodedCharacter).byteLength;
    if (usedBytes + characterBytes > maximumJsonBytes) {
      return { value: characters.join(""), truncated: true };
    }
    characters.push(character);
    usedBytes += characterBytes;
  }
  return { value, truncated: false };
}

function errorIdentity(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

function rejectedResult(tabRef: string, world: JavaScriptWorld, error: unknown): JavaScriptResult {
  const identity = errorIdentity(error);
  const name = boundedJsonText(identity.name, COMMAND_CATALOG.limits["command.tabs.maximum_text_bytes"]);
  const message = boundedJsonText(identity.message, COMMAND_CATALOG.limits["command.tabs.maximum_text_bytes"]);
  return {
    tabRef,
    world,
    status: "rejected",
    valueJson: null,
    valueTruncated: false,
    errorName: name.value,
    errorMessage: message.value,
  };
}

function serializedResult(tabRef: string, world: JavaScriptWorld, value: unknown): JavaScriptResult {
  let valueJson: string;
  try {
    const serialized = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return { type: "bigint", value: item.toString() };
      if (typeof item === "undefined") return { type: "undefined" };
      if (typeof item === "function") return { type: "function", value: String(item) };
      if (typeof item === "symbol") return { type: "symbol", value: String(item) };
      return item;
    });
    valueJson = serialized ?? JSON.stringify({ type: "undefined" });
  } catch (error) {
    const identity = errorIdentity(error);
    const name = boundedJsonText(identity.name, COMMAND_CATALOG.limits["command.tabs.maximum_text_bytes"]);
    const message = boundedJsonText(identity.message, COMMAND_CATALOG.limits["command.tabs.maximum_text_bytes"]);
    return {
      tabRef,
      world,
      status: "serialization_error",
      valueJson: null,
      valueTruncated: false,
      errorName: name.value,
      errorMessage: message.value,
    };
  }

  const preview = boundedJsonText(valueJson, COMMAND_CATALOG.limits["command.js.maximum_value_json_bytes"]);
  return {
    tabRef,
    world,
    status: "fulfilled",
    valueJson: preview.value,
    valueTruncated: preview.truncated,
    errorName: null,
    errorMessage: null,
  };
}

function readMainFrameDom(root: PageDomRoot, maximumHtmlJsonBytes: number, maximumUrlJsonBytes: number): PageSnapshot {
  const page = globalThis as unknown as {
    readonly document: {
      readonly documentElement?: { readonly outerHTML: string } | null;
      readonly body?: { readonly outerHTML: string } | null;
    };
    readonly location: { readonly href: string };
  };
  const localEncoder = new TextEncoder();
  const bound = (value: string, maximumJsonBytes: number): { value: string; truncated: boolean } => {
    const characters: string[] = [];
    let usedBytes = 0;
    for (const character of value) {
      const encodedCharacter = JSON.stringify(character).slice(1, -1);
      const characterBytes = localEncoder.encode(encodedCharacter).byteLength;
      if (usedBytes + characterBytes > maximumJsonBytes) {
        return { value: characters.join(""), truncated: true };
      }
      characters.push(character);
      usedBytes += characterBytes;
    }
    return { value, truncated: false };
  };

  const html = bound(
    root === "body" ? page.document.body?.outerHTML ?? "" : page.document.documentElement?.outerHTML ?? "",
    maximumHtmlJsonBytes,
  );
  const url = bound(page.location.href, maximumUrlJsonBytes);
  return {
    url: url.value,
    urlTruncated: url.truncated,
    html: html.value,
    htmlTruncated: html.truncated,
  };
}

export async function getPageDom(tabRef: string, root: PageDomRoot): Promise<PageDomResult> {
  const target = await resolveTabTarget(tabRef);
  await assertScriptingTargetAvailable(target);
  let entries: readonly ChromeScriptingInjectionResult<PageSnapshot>[];
  try {
    entries = await chrome.scripting.executeScript({
      target: { tabId: target.tabId },
      world: "ISOLATED",
      func: readMainFrameDom,
      args: [
        root,
        COMMAND_CATALOG.limits["command.page.dom.maximum_html_json_bytes"],
        COMMAND_CATALOG.limits["command.tabs.maximum_text_bytes"],
      ],
    });
  } catch {
    assertResolvedTabTarget(target);
    throw new BrowserCapabilityError("Chromium could not read the target main-frame DOM");
  }
  assertResolvedTabTarget(target);
  const entry = entries[0];
  if (entries.length !== 1 || entry === undefined || entry.frameId !== 0 || entry.result === undefined) {
    throw new BrowserCapabilityError("Chromium returned an unexpected main-frame DOM result");
  }
  return { tabRef, root, ...entry.result };
}

function readMainFrameText(maximumTextJsonBytes: number, maximumUrlJsonBytes: number): PageSnapshot {
  const page = globalThis as unknown as {
    readonly document: { readonly body?: { readonly innerText: string } | null };
    readonly location: { readonly href: string };
  };
  const localEncoder = new TextEncoder();
  const bound = (value: string, maximumJsonBytes: number): { value: string; truncated: boolean } => {
    const characters: string[] = [];
    let usedBytes = 0;
    for (const character of value) {
      const encodedCharacter = JSON.stringify(character).slice(1, -1);
      const characterBytes = localEncoder.encode(encodedCharacter).byteLength;
      if (usedBytes + characterBytes > maximumJsonBytes) return { value: characters.join(""), truncated: true };
      characters.push(character);
      usedBytes += characterBytes;
    }
    return { value, truncated: false };
  };
  const text = bound(page.document.body?.innerText ?? "", maximumTextJsonBytes);
  const url = bound(page.location.href, maximumUrlJsonBytes);
  return { url: url.value, urlTruncated: url.truncated, html: text.value, htmlTruncated: text.truncated };
}

export async function getPageText(tabRef: string): Promise<PageTextResult> {
  const target = await resolveTabTarget(tabRef);
  await assertScriptingTargetAvailable(target);
  let entries: readonly ChromeScriptingInjectionResult<PageSnapshot>[];
  try {
    entries = await chrome.scripting.executeScript({
      target: { tabId: target.tabId },
      world: "ISOLATED",
      func: readMainFrameText,
      args: [
        COMMAND_CATALOG.limits["command.page.text.maximum_json_bytes"],
        COMMAND_CATALOG.limits["command.tabs.maximum_text_bytes"],
      ],
    });
  } catch {
    assertResolvedTabTarget(target);
    throw new BrowserCapabilityError("Chromium could not read the target main-frame text");
  }
  assertResolvedTabTarget(target);
  const entry = entries[0];
  if (entries.length !== 1 || entry === undefined || entry.frameId !== 0 || entry.result === undefined) {
    throw new BrowserCapabilityError("Chromium returned an unexpected main-frame text result", "UNEXPECTED_PLATFORM_RESULT");
  }
  return {
    tabRef,
    url: entry.result.url,
    urlTruncated: entry.result.urlTruncated,
    text: entry.result.html,
    textTruncated: entry.result.htmlTruncated,
  };
}

function readFullMainFrameDom(root: PageDomRoot): { readonly url: string; readonly html: string } {
  const page = globalThis as unknown as {
    readonly document: {
      readonly documentElement?: { readonly outerHTML: string } | null;
      readonly body?: { readonly outerHTML: string } | null;
    };
    readonly location: { readonly href: string };
  };
  return {
    url: page.location.href,
    html: root === "body" ? page.document.body?.outerHTML ?? "" : page.document.documentElement?.outerHTML ?? "",
  };
}

export async function captureFullPageDom(tabRef: string, root: PageDomRoot): Promise<FullPageDomResult> {
  const target = await resolveTabTarget(tabRef);
  await assertScriptingTargetAvailable(target);
  let entries: readonly ChromeScriptingInjectionResult<{ readonly url: string; readonly html: string }>[];
  try {
    entries = await chrome.scripting.executeScript({
      target: { tabId: target.tabId },
      world: "ISOLATED",
      func: readFullMainFrameDom,
      args: [root],
    });
  } catch {
    assertResolvedTabTarget(target);
    throw new BrowserCapabilityError("Chromium could not capture the target main-frame DOM");
  }
  assertResolvedTabTarget(target);
  const entry = entries[0];
  if (entries.length !== 1 || entry === undefined || entry.frameId !== 0 || entry.result === undefined) {
    throw new BrowserCapabilityError("Chromium returned an unexpected full DOM result", "UNEXPECTED_PLATFORM_RESULT");
  }
  return { tabRef, root, ...entry.result };
}

function discoverPageResources(
  maximumItems: number,
  maximumTextBytes: number,
  maximumResultBytes: number,
): { readonly items: readonly PageResourceItem[]; readonly truncated: boolean } {
  type AttributeElement = {
    readonly getAttribute: (name: string) => string | null;
    readonly tagName: string;
  };
  type TreeWalkerLike = { nextNode(): AttributeElement | null };
  const page = globalThis as unknown as {
    readonly document: {
      readonly documentElement?: AttributeElement | null;
      createTreeWalker(root: AttributeElement, whatToShow: number): TreeWalkerLike;
    };
    readonly location: { readonly href: string };
    readonly performance: { getEntriesByType(type: string): readonly { readonly name: string }[] };
    readonly NodeFilter: { readonly SHOW_ELEMENT: number };
  };
  const items: PageResourceItem[] = [];
  const seen = new Set<string>();
  const encoder = new TextEncoder();
  const emptyResultBytes = encoder.encode(JSON.stringify({ items: [], truncated: true })).byteLength;
  let itemBytes = 0;
  let truncated = false;
  let saturated = false;
  const add = (raw: string | null, source: "dom" | "performance"): void => {
    if (saturated) return;
    if (raw === null || raw.length === 0) return;
    if (raw.length > maximumTextBytes) {
      truncated = true;
      return;
    }
    let url: string;
    try {
      url = new URL(raw, page.location.href).href;
    } catch {
      return;
    }
    if (seen.has(url)) return;
    seen.add(url);
    if (encoder.encode(url).byteLength > maximumTextBytes) {
      truncated = true;
      return;
    }
    if (items.length >= maximumItems) {
      truncated = true;
      saturated = true;
      return;
    }
    const item = { url, source } as const;
    const encodedItemBytes = encoder.encode(JSON.stringify(item)).byteLength;
    const separatorBytes = items.length === 0 ? 0 : 1;
    if (emptyResultBytes + itemBytes + separatorBytes + encodedItemBytes > maximumResultBytes) {
      truncated = true;
      saturated = true;
      return;
    }
    items.push(item);
    itemBytes += separatorBytes + encodedItemBytes;
  };
  for (const entry of page.performance.getEntriesByType("resource")) {
    add(entry.name, "performance");
    if (saturated) break;
  }
  const root = page.document.documentElement;
  if (!saturated && root !== null && root !== undefined) {
    const walker = page.document.createTreeWalker(root, page.NodeFilter.SHOW_ELEMENT);
    let element: AttributeElement | null = root;
    while (element !== null && !saturated) {
      add(element.getAttribute("src"), "dom");
      add(element.getAttribute("href"), "dom");
      add(element.getAttribute("poster"), "dom");
      add(element.getAttribute("data"), "dom");
      const srcset = element.getAttribute("srcset");
      if (srcset !== null) {
        let start = 0;
        let inspected = 0;
        while (start < srcset.length && inspected < maximumItems && !saturated) {
          const comma = srcset.indexOf(",", start);
          const end = comma === -1 ? srcset.length : comma;
          let tokenStart = start;
          while (tokenStart < end && /\s/u.test(srcset[tokenStart] ?? "")) tokenStart += 1;
          let tokenEnd = tokenStart;
          while (tokenEnd < end && !/\s/u.test(srcset[tokenEnd] ?? "")) tokenEnd += 1;
          if (tokenEnd - tokenStart <= maximumTextBytes) {
            add(srcset.slice(tokenStart, tokenEnd), "dom");
          } else {
            truncated = true;
          }
          inspected += 1;
          if (comma === -1) break;
          start = comma + 1;
        }
        if (start < srcset.length && inspected >= maximumItems) truncated = true;
      }
      element = walker.nextNode();
    }
  }
  return { items, truncated };
}

export async function getPageResources(tabRef: string, limit: number): Promise<PageResourcesResult> {
  const target = await resolveTabTarget(tabRef);
  await assertScriptingTargetAvailable(target);
  let entries: readonly ChromeScriptingInjectionResult<{ readonly items: readonly PageResourceItem[]; readonly truncated: boolean }>[];
  try {
    entries = await chrome.scripting.executeScript({
      target: { tabId: target.tabId },
      world: "ISOLATED",
      func: discoverPageResources,
      args: [
        limit,
        COMMAND_CATALOG.limits["command.tabs.maximum_text_bytes"],
        COMMAND_CATALOG.limits["command.inline.maximum_result_json_bytes"] - 256,
      ],
    });
  } catch {
    assertResolvedTabTarget(target);
    throw new BrowserCapabilityError("Chromium could not inspect page resource references");
  }
  assertResolvedTabTarget(target);
  const entry = entries[0];
  if (entries.length !== 1 || entry === undefined || entry.frameId !== 0 || entry.result === undefined) {
    throw new BrowserCapabilityError("Chromium returned an unexpected page resource result", "UNEXPECTED_PLATFORM_RESULT");
  }
  return { tabRef, ...entry.result };
}

export async function ensureUserScriptsAvailable(): Promise<void> {
  if (!await isUserScriptsAvailable()) {
    throw new BrowserCapabilityError(
      USER_SCRIPTS_SETUP_REQUIRED,
      "USER_SCRIPTS_NOT_ENABLED",
      "platform.extension.user_scripts",
    );
  }
}

function timeoutOutcome(timeoutMs: number): {
  readonly promise: Promise<JavaScriptExecutionOutcome>;
  readonly cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<JavaScriptExecutionOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

export async function executeJavaScript(
  target: ResolvedTabTarget,
  world: JavaScriptWorld,
  code: string,
  timeoutMs: number,
): Promise<JavaScriptResult> {
  assertResolvedTabTarget(target);
  await assertScriptingTargetAvailable(target, "platform.extension.user_scripts");
  const api = chrome.userScripts;
  if (api === undefined) {
    return Promise.reject(new BrowserCapabilityError(
      USER_SCRIPTS_SETUP_REQUIRED,
      "USER_SCRIPTS_NOT_ENABLED",
      "platform.extension.user_scripts",
    ));
  }

  let settled: Promise<JavaScriptExecutionOutcome>;
  try {
    const execution = api.execute({
      target: { tabId: target.tabId },
      js: [{ code }],
      world,
    });
    settled = execution.then<JavaScriptExecutionOutcome, JavaScriptExecutionOutcome>(
      (entries) => ({ kind: "entries", entries }),
      () => ({ kind: "failure" }),
    );
  } catch {
    settled = Promise.resolve({ kind: "failure" });
  }
  const timeout = timeoutOutcome(timeoutMs);

  return Promise.race([settled, timeout.promise]).then((outcome): JavaScriptResult => {
    timeout.cancel();
    if (outcome.kind === "timeout") {
      return {
        tabRef: target.tabRef,
        world,
        status: "timed_out",
        valueJson: null,
        valueTruncated: false,
        errorName: null,
        errorMessage: null,
      };
    }
    if (outcome.kind === "failure") {
      assertResolvedTabTarget(target);
      throw new BrowserCapabilityError(
        "Chromium could not execute JavaScript in the target tab",
        "CHROMIUM_API_FAILED",
        "platform.extension.user_scripts",
      );
    }

    const entry = outcome.entries[0];
    if (outcome.entries.length !== 1 || entry === undefined || entry.frameId !== 0) {
      return rejectedResult(target.tabRef, world, new Error("Unexpected user-script result count"));
    }
    if (entry.error !== undefined) return rejectedResult(target.tabRef, world, new Error(entry.error));
    return serializedResult(target.tabRef, world, entry.result);
  });
}
