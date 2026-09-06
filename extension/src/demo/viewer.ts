import { DEMO_PORT_NAME, type DemoReadResponse } from "../shared/demo-protocol.js";
import { onLocaleChanged, t, type UiMessageKey } from "../ui/page-ui.js";

const status = document.querySelector<HTMLElement>("#status")!;
const surface = document.querySelector<HTMLElement>("#surface")!;
class DemoViewerError extends Error {
  readonly messageKey: UiMessageKey;
  readonly values: Readonly<Record<string, string | number>>;
  constructor(messageKey: UiMessageKey, values: Readonly<Record<string, string | number>> = {}) {
    super(messageKey); this.messageKey = messageKey; this.values = values;
  }
}
let visibleError: DemoViewerError | null = null;

async function readHtml(): Promise<string> {
  const artifactRef = new URL(location.href).searchParams.get("artifactRef");
  const port = chrome.runtime.connect({ name: DEMO_PORT_NAME });
  let pending: { resolve(value: unknown): void; reject(error: Error): void } | undefined;
  port.onMessage.addListener((response) => { const current = pending; pending = undefined; current?.resolve(response); });
  port.onDisconnect.addListener(() => { const current = pending; pending = undefined;
    current?.reject(new DemoViewerError("demoDisconnected")); });
  try {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let offset = 0;
    let metadata: { byteLength: number; sha256: string } | undefined;
    while (true) {
      const value = await new Promise<unknown>((resolve, reject) => { pending = { resolve, reject }; port.postMessage({ offset }); });
      if (typeof value !== "object" || value === null || !("ok" in value)) throw new DemoViewerError("demoInvalid");
      const response = value as DemoReadResponse;
      if (!response.ok) throw new DemoViewerError("demoUnavailable", { code: response.code });
      const chunk = response.chunk;
      if (chunk.artifactRef !== artifactRef || chunk.offset !== offset || chunk.mediaType !== "text/html" ||
          !Number.isSafeInteger(chunk.byteLength) || chunk.byteLength < offset ||
          !/^[a-f0-9]{64}$/u.test(chunk.sha256) || typeof chunk.dataBase64Url !== "string") throw new DemoViewerError("demoInconsistent");
      if (metadata !== undefined && (metadata.byteLength !== chunk.byteLength || metadata.sha256 !== chunk.sha256)) throw new DemoViewerError("demoChanged");
      metadata = { byteLength: chunk.byteLength, sha256: chunk.sha256 };
      const binary = atob(chunk.dataBase64Url.replaceAll("-", "+").replaceAll("_", "/"));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      parts.push(bytes); offset += bytes.length;
      if (offset > metadata.byteLength || (chunk.nextOffset === null ? offset !== metadata.byteLength :
          chunk.nextOffset !== offset || bytes.length === 0)) throw new DemoViewerError("demoLength");
      if (chunk.nextOffset === null) break;
    }
    const buffer = await new Blob(parts).arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
    const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (hex !== metadata!.sha256) throw new DemoViewerError("demoHash");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    catch { throw new DemoViewerError("demoUtf8"); }
  } finally { port.disconnect(); }
}

async function display(): Promise<void> {
  const html = await readHtml();
  const frame = document.createElement("iframe");
  frame.title = "HTML 演示";
  frame.src = "sandbox.html";
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== frame.contentWindow || typeof event.data !== "object" || event.data === null ||
        !("kind" in event.data) || event.data.kind !== "demo.rendered") return;
    status.hidden = true;
    document.documentElement.dataset.state = "ready";
    if ("title" in event.data && typeof event.data.title === "string" && event.data.title) document.title = event.data.title;
  });
  frame.addEventListener("load", () => { frame.contentWindow?.postMessage({ kind: "demo.render", html }, "*"); }, { once: true });
  surface.append(frame);
}

void display().catch((error: unknown) => {
  document.documentElement.dataset.state = "error";
  visibleError = error instanceof DemoViewerError ? error : new DemoViewerError("demoFailed");
  status.textContent = t(visibleError.messageKey, visibleError.values);
});
onLocaleChanged(() => {
  if (visibleError !== null) status.textContent = t(visibleError.messageKey, visibleError.values);
  else if (document.documentElement.dataset.state !== "ready") status.textContent = t("demoLoading");
});
