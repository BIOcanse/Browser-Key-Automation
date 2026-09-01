import { COMMAND_CATALOG } from "../generated/command-config.js";
import { ArtifactServiceError, createArtifact, createTextArtifact, type ArtifactMetadata } from "./artifact-service.js";
import { captureFullPageDom, type PageDomRoot } from "./browser-service.js";
import { CapabilityUnavailableError } from "./capability-error.js";
import { getRuntimeSettings } from "./settings-service.js";
import { assertResolvedTabTarget, getTab, resolveTabTarget } from "./tab-service.js";

const encoder = new TextEncoder();

export interface ResourceFetchResult {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly finalUrlTruncated: boolean;
  readonly status: number;
  readonly headers: readonly { readonly name: string; readonly value: string; readonly valueTruncated: boolean }[];
  readonly headersTruncated: boolean;
  readonly artifact: ArtifactMetadata;
}

function limit(pointId: string): number {
  const value = COMMAND_CATALOG.limits[pointId as keyof typeof COMMAND_CATALOG.limits];
  if (typeof value !== "number") throw new Error(`Missing generated integer Freedom Point: ${pointId}`);
  return value;
}

function boundedText(value: string, maximumBytes = limit("command.tabs.maximum_text_bytes")): {
  readonly value: string;
  readonly truncated: boolean;
} {
  const characters: string[] = [];
  let usedBytes = 0;
  for (const character of value) {
    const bytes = encoder.encode(character).byteLength;
    if (usedBytes + bytes > maximumBytes) return { value: characters.join(""), truncated: true };
    characters.push(character);
    usedBytes += bytes;
  }
  return { value, truncated: false };
}

export async function capturePageDomArtifact(
  ownerKeyId: string,
  tabRef: string,
  root: PageDomRoot,
): Promise<{
  readonly tabRef: string;
  readonly root: PageDomRoot;
  readonly url: string;
  readonly urlTruncated: boolean;
  readonly artifact: ArtifactMetadata;
}> {
  const captured = await captureFullPageDom(tabRef, root);
  const url = boundedText(captured.url);
  const artifact = await createTextArtifact(ownerKeyId, "text/html;charset=utf-8", captured.html);
  return { tabRef, root, url: url.value, urlTruncated: url.truncated, artifact };
}

async function boundedResponseBlob(response: Response, maximumBytes: number): Promise<Blob> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > maximumBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw new ArtifactServiceError("LIMIT_EXCEEDED", "Resource response exceeds the Artifact byte limit");
    }
  }
  if (response.body === null) return new Blob([], { type: response.headers.get("content-type") ?? "application/octet-stream" });
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      totalBytes += item.value.byteLength;
      if (totalBytes > maximumBytes) {
        throw new ArtifactServiceError("LIMIT_EXCEEDED", "Resource response exceeds the Artifact byte limit");
      }
      chunks.push(item.value.slice().buffer as ArrayBuffer);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, { type: response.headers.get("content-type") ?? "application/octet-stream" });
}

export async function fetchResource(
  ownerKeyId: string,
  requestedUrl: string,
  credentials: "include" | "omit",
  cache: "default" | "no-store" | "reload",
): Promise<ResourceFetchResult> {
  const settings = await getRuntimeSettings();
  const maximumBytes = Math.min(
    settings.artifactMaximumBytes,
    limit("build.artifact.hard_maximum_bytes"),
  );
  let response: Response;
  let body: Blob;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limit("command.resource.fetch.timeout_ms"));
  try {
    response = await fetch(requestedUrl, {
      method: "GET",
      credentials,
      cache,
      redirect: "follow",
      signal: controller.signal,
    });
    body = await boundedResponseBlob(response, maximumBytes);
  } catch (error) {
    controller.abort();
    if (error instanceof ArtifactServiceError) throw error;
    throw new CapabilityUnavailableError(
      "platform.extension.resource_fetch",
      "CHROMIUM_API_FAILED",
      "Chromium could not complete the requested resource fetch",
    );
  } finally {
    clearTimeout(timeout);
  }
  const artifact = await createArtifact(
    ownerKeyId,
    response.headers.get("content-type") ?? "application/octet-stream",
    body,
  );
  const finalUrl = boundedText(response.url);
  const headers: { name: string; value: string; valueTruncated: boolean }[] = [];
  const maximumHeaders = limit("command.resource.fetch.maximum_headers");
  let headersTruncated = false;
  for (const [name, rawValue] of response.headers) {
    if (headers.length >= maximumHeaders) {
      headersTruncated = true;
      break;
    }
    const value = boundedText(rawValue);
    const header = { name: name.toLowerCase(), value: value.value, valueTruncated: value.truncated };
    const candidateBytes = encoder.encode(JSON.stringify({
      requestedUrl,
      finalUrl: finalUrl.value,
      finalUrlTruncated: finalUrl.truncated,
      status: response.status,
      headers: [...headers, header],
      headersTruncated: true,
      artifact,
    })).byteLength;
    if (candidateBytes > limit("command.inline.maximum_result_json_bytes")) {
      headersTruncated = true;
      break;
    }
    headers.push(header);
  }
  return {
    requestedUrl,
    finalUrl: finalUrl.value,
    finalUrlTruncated: finalUrl.truncated,
    status: response.status,
    headers,
    headersTruncated,
    artifact,
  };
}

export async function capturePageArchive(
  ownerKeyId: string,
  tabRef: string,
): Promise<{ readonly tabRef: string; readonly artifact: ArtifactMetadata }> {
  const target = await resolveTabTarget(tabRef);
  assertResolvedTabTarget(target);
  let blob: Blob | undefined;
  try {
    blob = await chrome.pageCapture.saveAsMHTML({ tabId: target.tabId });
  } catch {
    assertResolvedTabTarget(target);
    throw new CapabilityUnavailableError(
      "platform.extension.page_capture",
      "CHROMIUM_API_FAILED",
      "Chromium could not capture the current page as MHTML",
    );
  }
  assertResolvedTabTarget(target);
  if (blob === undefined) {
    throw new CapabilityUnavailableError(
      "platform.extension.page_capture",
      "UNEXPECTED_PLATFORM_RESULT",
      "Chromium returned no MHTML archive",
    );
  }
  const artifact = await createArtifact(ownerKeyId, "multipart/related", blob);
  return { tabRef, artifact };
}

function dataUrlBlob(dataUrl: string, expectedType: "image/jpeg" | "image/png"): Blob {
  const prefix = `data:${expectedType};base64,`;
  if (!dataUrl.startsWith(prefix)) {
    throw new CapabilityUnavailableError(
      "platform.extension.visible_tab_capture",
      "UNEXPECTED_PLATFORM_RESULT",
      "Chromium returned an unexpected screenshot encoding",
    );
  }
  const binary = atob(dataUrl.slice(prefix.length));
  const bytes = new Uint8Array(binary.length);
  let index = 0;
  while (index < binary.length) {
    bytes[index] = binary.charCodeAt(index);
    index += 1;
  }
  return new Blob([bytes], { type: expectedType });
}

export async function captureVisibleScreenshot(
  ownerKeyId: string,
  tabRef: string,
  format: "jpeg" | "png",
  quality: number,
): Promise<{ readonly tabRef: string; readonly artifact: ArtifactMetadata }> {
  const target = await resolveTabTarget(tabRef);
  const tab = await getTab(tabRef);
  if (!tab.active) {
    throw new CapabilityUnavailableError(
      "platform.extension.visible_tab_capture",
      "TARGET_TAB_NOT_VISIBLE",
      "The target tab must already be active in its window",
    );
  }
  assertResolvedTabTarget(target);
  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format, quality });
  } catch {
    assertResolvedTabTarget(target);
    throw new CapabilityUnavailableError(
      "platform.extension.visible_tab_capture",
      "CHROMIUM_API_FAILED",
      "Chromium could not capture the visible tab viewport",
    );
  }
  assertResolvedTabTarget(target);
  const current = await getTab(tabRef);
  if (!current.active) {
    throw new CapabilityUnavailableError(
      "platform.extension.visible_tab_capture",
      "TARGET_TAB_NOT_VISIBLE",
      "The target tab stopped being active during capture",
    );
  }
  const mediaType = format === "jpeg" ? "image/jpeg" : "image/png";
  const artifact = await createArtifact(ownerKeyId, mediaType, dataUrlBlob(dataUrl, mediaType));
  return { tabRef, artifact };
}
