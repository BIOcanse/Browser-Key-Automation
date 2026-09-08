import { COMMAND_CATALOG } from "../../generated/command-config.js";
import type { PublicKeyRecord } from "../../shared/admin-protocol.js";
import { createArtifact } from "../artifact-service.js";
import { assertScriptingTargetAvailable } from "../browser-service.js";
import { captureVisibleScreenshotBlob } from "../capture-service.js";
import { DomServiceError, resolveNodeRefTarget, type NodeRefTarget } from "../dom-service.js";
import { assertResolvedTabTarget, resolveTabTarget } from "../tab-service.js";
import { collectDocumentGeometry } from "./document-geometry.js";
import { withFrameMapping } from "./frame-mapping.js";
import type { DebuggerDispatch } from "../debugger-service.js";
import { ElementScreenshotError, type CaptureGeometry, type CaptureRect } from "./geometry-model.js";
import { composeElementScreenshot } from "./mask-image.js";

export interface ElementScreenshotRequest {
  readonly nodeRef: string;
  readonly width: number;
  readonly height: number;
  readonly region?: CaptureRect;
  readonly frameMapping?: "none" | "debugger";
}

async function geometryFor(target: NodeRefTarget): Promise<CaptureGeometry> {
  let entries: readonly ChromeScriptingInjectionResult<ReturnType<typeof collectDocumentGeometry>>[];
  try {
    entries = await chrome.scripting.executeScript({
      target: { tabId: target.tabId, documentIds: [target.documentId] }, world: "ISOLATED", func: collectDocumentGeometry,
      args: [target.nodeRef, COMMAND_CATALOG.limits["command.page.screenshot.maximum_geometry_nodes"],
        COMMAND_CATALOG.limits["command.page.screenshot.maximum_geometry_depth"], COMMAND_CATALOG.limits["command.page.screenshot.maximum_geometry_bytes"]],
    });
  } catch { throw new DomServiceError("TARGET_REF_STALE", "Screenshot NodeRef no longer resolves to its document"); }
  const entry = entries[0];
  if (entries.length !== 1 || !entry || entry.documentId !== target.documentId || entry.frameId !== target.frameId || !entry.result) throw new DomServiceError("TARGET_REF_STALE", "Screenshot document changed");
  const result = entry.result;
  if (result.ok) return result.geometry;
  if (result.reason === "stale") throw new DomServiceError("TARGET_REF_STALE", "Screenshot NodeRef is stale");
  throw new ElementScreenshotError(result.reason === "limit" ? "LIMIT_EXCEEDED" : result.reason === "empty" ? "EMPTY_REGION" : "GEOMETRY_UNSUPPORTED", result.feature);
}

export async function captureElementScreenshot(ownerKeyId: string, request: ElementScreenshotRequest,
  frameAccess?: {readonly caller: PublicKeyRecord; readonly dispatch: DebuggerDispatch}) {
  const { width, height, nodeRef } = request;
  const maximumDimension = COMMAND_CATALOG.limits["command.page.screenshot.maximum_dimension"];
  const maximumPixels = COMMAND_CATALOG.limits["command.page.screenshot.maximum_pixels"];
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= maximumDimension) || width * height > maximumPixels) {
    throw new ElementScreenshotError("LIMIT_EXCEEDED", "output-pixels");
  }
  const node = resolveNodeRefTarget(nodeRef);
  const tab = await resolveTabTarget(node.tabRef);
  await assertScriptingTargetAvailable(tab);
  const capture = async (geometry: () => Promise<CaptureGeometry>, guard: DebuggerDispatch) => {
    const before = await geometry();
    assertResolvedTabTarget(tab);
    const blob = await guard(() => captureVisibleScreenshotBlob(node.tabRef, "png", COMMAND_CATALOG.limits["command.page.screenshot.default_quality"]));
    const after = await geometry();
    assertResolvedTabTarget(tab);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new ElementScreenshotError("GEOMETRY_CHANGED", "layout-or-viewport");
    let source: ImageBitmap | null = null, disposed = false;
    try {
      const bitmap = await guard(() => createImageBitmap(blob).then(value => {
        if (disposed) value.close(); else source = value;
        return value;
      }));
      if (bitmap.width * bitmap.height > maximumPixels) throw new ElementScreenshotError("LIMIT_EXCEEDED", "source-pixels");
      const output = await guard(() => composeElementScreenshot(bitmap, before, width, height, request.region ?? null));
      return {blob: output.blob, sourceRect: output.sourceRect, contentRect: output.contentRect, viewport: before.viewport};
    } finally { disposed = true; (source as ImageBitmap | null)?.close(); }
  };
  let output: Awaited<ReturnType<typeof capture>>;
  if (request.frameMapping === "debugger") {
    if (!frameAccess || frameAccess.caller.keyId !== ownerKeyId) throw new ElementScreenshotError("GEOMETRY_UNSUPPORTED", "frame-authorization-context");
    output = await withFrameMapping(frameAccess.caller, node, frameAccess.dispatch, mapping => capture(mapping.geometry, mapping.guard));
  } else output = await capture(() => geometryFor(node), effect => effect());
  const publish = () => createArtifact(ownerKeyId, "image/png", output.blob);
  const artifact = request.frameMapping === "debugger" ? await frameAccess!.dispatch(publish) : await publish();
  return {nodeRef, tabRef: node.tabRef, artifact, width, height, sourceRect: output.sourceRect,
    contentRect: output.contentRect, viewport: output.viewport, viewportOnly: true};
}
