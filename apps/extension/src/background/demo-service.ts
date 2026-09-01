import { COMMAND_CATALOG } from "../generated/command-config.js";
import { DEMO_PAGE, DEMO_PORT_NAME } from "../shared/demo-protocol.js";
import { ArtifactServiceError, getArtifactMetadata, isArtifactRefShape, readArtifact } from "./artifact-service.js";
import { dispatchWithControlGate, dispatchWithGlobalControlGate } from "./occupation-service.js";
import { createTab, resolveTab, updateResolvedTab } from "./tab-service.js";

export interface OpenDemoParams {
  readonly artifactRef: string;
  readonly tabRef: string | null;
  readonly windowId: number | null;
  readonly active: boolean;
}

export class DemoServiceError extends Error {
  readonly code = "DEMO_INPUT_INVALID" as const;
  readonly details: { readonly reason: string };
  constructor(reason: string) { super(reason); this.details = { reason }; }
}

function isDemoPage(url: string | null): boolean {
  if (url === null) return false;
  try { const parsed = new URL(url); parsed.search = ""; parsed.hash = ""; return parsed.href === chrome.runtime.getURL(DEMO_PAGE); }
  catch { return false; }
}

export async function openDemo(ownerKeyId: string, params: OpenDemoParams) {
  const artifact = await getArtifactMetadata(ownerKeyId, params.artifactRef);
  if (artifact.mediaType !== "text/html") throw new DemoServiceError("NOT_HTML");
  const destination = new URL(chrome.runtime.getURL(DEMO_PAGE));
  destination.searchParams.set("ownerKeyId", ownerKeyId);
  destination.searchParams.set("artifactRef", params.artifactRef);
  if (params.tabRef === null) {
    const result = await dispatchWithGlobalControlGate(ownerKeyId, () => createTab({ url: destination.href, active: params.active,
      ...(params.windowId === null ? {} : { windowId: params.windowId }) }));
    return { ...result, artifact };
  }
  const tabRef = params.tabRef;
  return dispatchWithControlGate(ownerKeyId, tabRef, async () => {
    const { target, tab } = await resolveTab(tabRef);
    if (!isDemoPage(tab.url ?? null)) throw new DemoServiceError("NOT_DEMO_TAB");
    if (tab.pendingUrl !== undefined && !isDemoPage(tab.pendingUrl)) throw new DemoServiceError("NAVIGATION_PENDING");
    return { ...await updateResolvedTab(target, { url: destination.href, active: params.active }), artifact };
  });
}

function demoAddress(port: ChromeRuntimePort): { readonly ownerKeyId: string; readonly artifactRef: string } | null {
  if (port.name !== DEMO_PORT_NAME || port.sender?.id !== chrome.runtime.id || !isDemoPage(port.sender.url ?? null)) return null;
  const url = new URL(port.sender.url!);
  const ownerKeyId = url.searchParams.get("ownerKeyId");
  const artifactRef = url.searchParams.get("artifactRef");
  if (url.hash !== "" || url.searchParams.size !== 2 || typeof ownerKeyId !== "string" ||
      !/^[A-Za-z0-9_-]{22}$/u.test(ownerKeyId) || !isArtifactRefShape(artifactRef)) return null;
  return { ownerKeyId, artifactRef };
}

export function isTrustedDemoPort(port: ChromeRuntimePort): boolean { return demoAddress(port) !== null; }

// Like the local admin UI, only the fixed packaged outer page can access this
// internal port. It can read only the owner/ref in its own address. Submitted
// HTML lives at a unique sandbox origin and cannot connect or select a file.
export function attachDemoRouter(port: ChromeRuntimePort): void {
  const address = demoAddress(port);
  if (address === null) { port.disconnect(); return; }
  let connected = true;
  let reading = false;
  port.onDisconnect.addListener(() => { connected = false; });
  port.onMessage.addListener((message) => {
    if (!connected) return;
    if (reading || typeof message !== "object" || message === null || Array.isArray(message) ||
        Object.keys(message).length !== 1 || !("offset" in message) || typeof message.offset !== "number" ||
        !Number.isSafeInteger(message.offset) || message.offset < 0) { port.disconnect(); return; }
    reading = true;
    void readArtifact(address.ownerKeyId, address.artifactRef, message.offset,
      COMMAND_CATALOG.limits["command.artifact.read.maximum_raw_bytes"]).then((chunk) => {
      if (!connected) return;
      if (chunk.mediaType !== "text/html") port.postMessage({ ok: false, code: "DEMO_INPUT_INVALID" });
      else port.postMessage({ ok: true, chunk });
    }, (error: unknown) => {
      if (connected) port.postMessage({ ok: false, code: error instanceof ArtifactServiceError ? error.code : "STORAGE_UNAVAILABLE" });
    }).catch(() => undefined).finally(() => { reading = false; });
  });
}
